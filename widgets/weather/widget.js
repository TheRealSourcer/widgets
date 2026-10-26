import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';
import {surfaceStyle} from '../../utils/widget.js';
import {ease} from '../../utils/animation.js';
import {VERTICAL, boxOrientation} from '../../compatibility.js';

import { warn } from '../../logger.js';

let GWeather = null;

try {
	GWeather = (await import('gi://GWeather')).default;
} catch (error) {
	warn('weather-gweather-missing', `GWeather is unavailable: ${error.message}`);
};

export const type = 'weather';
export const label = 'Weather';
export const stylesheet = 'widgets/weather/stylesheet.css';
export const settingsSchema = 'org.gnome.Weather';
export const cacheTtlMs = 60 * 1000;
export const defaultSize = 'small';
export const supportedSizes = ['small', 'medium', 'large'];

const legacyCacheTtlMs = 10 * 60 * 1000;
const REFRESH_SECONDS = 60;
const LEGACY_POLL_SECONDS = 30;
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const WEATHER_LOCATION_KEY = 'weather-location';

const decoder = new TextDecoder();
const temperatureState = new Map();
const temperatureBodies = new WeakSet();

const TEMPERATURE_ANIMATION_MS = 280;

const WEATHER_CODES = new Map([
	[0, ['Clear sky', 'weather-clear', 'weather-clear-night']],
	[1, ['Mainly clear', 'weather-few-clouds', 'weather-few-clouds-night']],
	[2, ['Partly cloudy', 'weather-few-clouds', 'weather-few-clouds-night']],
	[3, ['Overcast', 'weather-overcast', 'weather-overcast']],
	[45, ['Fog', 'weather-fog', 'weather-fog']],
	[48, ['Rime fog', 'weather-fog', 'weather-fog']],
	[51, ['Light drizzle', 'weather-showers-scattered', 'weather-showers-scattered']],
	[53, ['Drizzle', 'weather-showers-scattered', 'weather-showers-scattered']],
	[55, ['Heavy drizzle', 'weather-showers', 'weather-showers']],
	[56, ['Freezing drizzle', 'weather-showers', 'weather-showers']],
	[57, ['Heavy freezing drizzle', 'weather-showers', 'weather-showers']],
	[61, ['Light rain', 'weather-showers-scattered', 'weather-showers-scattered']],
	[63, ['Rain', 'weather-showers', 'weather-showers']],
	[65, ['Heavy rain', 'weather-showers', 'weather-showers']],
	[66, ['Freezing rain', 'weather-showers', 'weather-showers']],
	[67, ['Heavy freezing rain', 'weather-showers', 'weather-showers']],
	[71, ['Light snow', 'weather-snow', 'weather-snow']],
	[73, ['Snow', 'weather-snow', 'weather-snow']],
	[75, ['Heavy snow', 'weather-snow', 'weather-snow']],
	[77, ['Snow grains', 'weather-snow', 'weather-snow']],
	[80, ['Light showers', 'weather-showers-scattered', 'weather-showers-scattered']],
	[81, ['Showers', 'weather-showers', 'weather-showers']],
	[82, ['Violent showers', 'weather-showers', 'weather-showers']],
	[85, ['Light snow showers', 'weather-snow', 'weather-snow']],
	[86, ['Snow showers', 'weather-snow', 'weather-snow']],
	[95, ['Thunderstorm', 'weather-storm', 'weather-storm']],
	[96, ['Thunderstorm with hail', 'weather-storm', 'weather-storm']],
	[99, ['Severe thunderstorm with hail', 'weather-storm', 'weather-storm']],
]);

function describeCode(code, isDay = true) {
	const entry = WEATHER_CODES.get(Number(code)) ?? ['Unknown conditions', 'weather-clear', 'weather-clear-night'];

	return {summary: entry[0], icon: isDay ? entry[1] : entry[2]};
};

function roundedTemperature(value) {
	return Number.isFinite(Number(value)) && value !== null ? `${Math.round(Number(value))}°` : '--';
};

function forecastFromDaily(daily) {
	const times = daily?.time ?? [];
	const days = [];

	for (let index = 1; index < times.length && days.length < 5; index++) {
		const [year, month, day] = String(times[index]).split('-').map(Number);
		const temp = roundedTemperature(daily.temperature_2m_max?.[index]);

		if (!year || temp === '--') {
			continue;
		};

		days.push({
			time: index,
			day: new Date(year, month - 1, day).toLocaleDateString(undefined, {weekday: 'short'}),
			temp,
			icon: describeCode(daily.weather_code?.[index]).icon,
		});
	};

	return days;
};

function weatherFromOpenMeteo(data, name) {
	const current = data?.current;

	if (!current) {
		throw new Error('Missing current conditions');
	};

	const {summary, icon} = describeCode(current.weather_code, current.is_day !== 0);
	const apparent = roundedTemperature(current.apparent_temperature);

	return {
		temp: roundedTemperature(current.temperature_2m),
		summary,
		location: name,
		icon,
		feelsLike: apparent !== '--' ? `It feels like ${apparent}` : null,
		forecast: forecastFromDaily(data.daily),
	};
};

function notFoundWeather(name) {
	return {
		temp: '--',
		summary: 'Location not found',
		location: name,
		icon: 'weather-severe-alert',
		feelsLike: null,
		forecast: [],
	};
};

export class OpenMeteoService {
	constructor(onUpdate) {
		this._onUpdate = onUpdate;
		this._session = new Soup.Session({timeout: 15, idle_timeout: 15});
		this._cancellable = null;
		this._timerId = 0;
		this._query = '';
		this._place = null;
		this._weather = null;
		this._updatedAt = 0;
		this._updating = false;
		this._generation = 0;
		this._destroyed = false;
		this.cacheTtlMs = cacheTtlMs;
	};

	get weather() {
		return this._weather;
	};

	get locationName() {
		return this._place?.name ?? (this._query || null);
	};

	hasLocation() {
		return this._query !== '';
	};

	start() {
		if (this._destroyed || this._timerId) {
			return;
		};

		this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
			this.refresh(true);
			return GLib.SOURCE_CONTINUE;
		});
	};

	stopTimer() {
		if (this._timerId) {
			GLib.Source.remove(this._timerId);
		};

		this._timerId = 0;
	};

	setLocation(query) {
		const normalized = String(query ?? '').trim();

		if (this._destroyed || normalized === this._query) {
			return false;
		};

		this._cancel();
		this._query = normalized;
		this._place = null;
		this._weather = null;
		this._updatedAt = 0;
		return true;
	};

	refresh(force = false) {
		if (this._destroyed || !this._query) {
			return;
		};

		if (!force && (this._updating || Date.now() - this._updatedAt < this.cacheTtlMs)) {
			return;
		};

		this._cancel();

		const cancellable = new Gio.Cancellable();
		const generation = this._generation;

		this._cancellable = cancellable;
		this._updating = true;
		this._load(generation, cancellable);
	};

	destroy() {
		if (this._destroyed) {
			return;
		};

		this._destroyed = true;
		this.stopTimer();
		this._cancel();
		this._session?.abort();
		this._session = null;
		this._onUpdate = null;
		this._weather = null;
		this._place = null;
	};

	_cancel() {
		this._generation++;
		this._updating = false;

		if (this._cancellable) {
			this._cancellable.cancel();
			this._cancellable = null;
		};
	};

	_stale(generation) {
		return this._destroyed || generation !== this._generation;
	};

	_finish(generation, weather) {
		if (this._stale(generation)) {
			return;
		};

		this._cancellable = null;
		this._updating = false;
		this._updatedAt = Date.now();
		this._weather = weather;
		this._onUpdate?.();
	};

	_getJson(url, cancellable) {
		return new Promise((resolve, reject) => {
			const message = Soup.Message.new('GET', url);

			if (!message || !this._session) {
				reject(new Error('Request could not be created'));
				return;
			};

			this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
				try {
					const bytes = session.send_and_read_finish(result);

					if (message.get_status() !== Soup.Status.OK) {
						throw new Error(`HTTP ${message.get_status()}`);
					};

					resolve(JSON.parse(decoder.decode(bytes.get_data())));
				} catch (error) {
					reject(error);
				};
			});
		});
	};

	async _load(generation, cancellable) {
		try {
			if (!this._place) {
				const geocode = await this._getJson(
					`${GEOCODE_URL}?name=${encodeURIComponent(this._query)}&count=1&language=en&format=json`,
					cancellable);

				if (this._stale(generation)) {
					return;
				};

				const hit = geocode?.results?.[0];

				if (!hit) {
					this._finish(generation, notFoundWeather(this._query));
					return;
				};

				this._place = {
					name: hit.name || this._query,
					latitude: hit.latitude,
					longitude: hit.longitude,
				};
			};

			const params = [
				`latitude=${this._place.latitude}`,
				`longitude=${this._place.longitude}`,
				'current=temperature_2m,apparent_temperature,weather_code,is_day',
				'hourly=temperature_2m,weather_code',
				'daily=weather_code,temperature_2m_max,temperature_2m_min',
				'forecast_days=6',
				'timezone=auto',
			].join('&');
			const data = await this._getJson(`${FORECAST_URL}?${params}`, cancellable);

			if (this._stale(generation)) {
				return;
			};

			this._finish(generation, weatherFromOpenMeteo(data, this._place.name));
		} catch (error) {
			if (this._stale(generation)) {
				return;
			};

			this._updating = false;
			this._cancellable = null;
			warn('weather-open-meteo', `Could not fetch weather: ${error.message}`);
		};
	};
};

export const weatherService = {
	listeners: new Set(),
	settings: null,
	extensionSettings: null,
	openMeteo: null,
	info: null,
	timerId: 0,
	updating: false,
	updatedAt: 0,
	locationKey: null,
	locationName: null,
	weather: null,

	subscribe(callback, extensionSettings = null) {
		if (this.listeners.size === 0) {
			this.start(extensionSettings);
		};
		this.listeners.add(callback);
		callback(this.weather, this.locationName);
		return () => {
			this.listeners.delete(callback);
			if (this.listeners.size === 0) {
				this.stop();
			};
		};
	},

	locationQuery() {
		return this.extensionSettings?.get_string(WEATHER_LOCATION_KEY)?.trim() ?? '';
	},

	start(extensionSettings = null) {
		this.stop();
		this.extensionSettings = extensionSettings;
		this.extensionSettings?.connectObject(
			`changed::${WEATHER_LOCATION_KEY}`, () => this.onLocationChanged(), this);

		this.openMeteo = new OpenMeteoService(() => this.onOpenMeteoUpdate());
		this.openMeteo.start();

		const schema = Gio.SettingsSchemaSource.get_default()?.lookup(settingsSchema, true);
		this.settings = schema ? new Gio.Settings({settings_schema: schema}) : null;
		this.settings?.connectObject('changed::locations', () => this.refresh(true), this);

		this.refresh();

		this.timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LEGACY_POLL_SECONDS, () => {
			if (!this.locationQuery()) {
				this.refresh();
			};
			return GLib.SOURCE_CONTINUE;
		});
	},

	onLocationChanged() {
		this.clearInfo();
		this.locationKey = null;
		this.locationName = null;
		this.weather = null;
		this.updatedAt = 0;
		if (!this.locationQuery()) {
			this.openMeteo?.setLocation('');
		};
		this.notify();
		this.refresh(true);
	},

	onOpenMeteoUpdate() {
		if (!this.openMeteo || !this.locationQuery()) {
			return;
		};
		this.weather = this.openMeteo.weather;
		this.locationName = this.openMeteo.locationName;
		this.notify();
	},

	clearInfo() {
		if (this.info) {
			this.info.disconnectObject(this);
			this.info.abort();
		};
		this.info = null;
		this.updating = false;
	},

	refresh(force = false) {
		const query = this.locationQuery();
		if (query && this.openMeteo) {
			this.clearInfo();
			if (this.openMeteo.setLocation(query)) {
				this.weather = null;
			};
			this.locationName = this.openMeteo.locationName;
			this.openMeteo.refresh(force);
			return;
		};
		this.refreshLegacy(force);
	},

	refreshLegacy(force = false) {
		const key = this.settings?.get_value('locations').print(true) ?? '';
		if (key !== this.locationKey) {
			this.clearInfo();
			this.locationKey = key;
			this.locationName = locationNameFromSettings(this.settings);
			this.weather = null;
			this.updatedAt = 0;
			this.notify();
		};
		if (!force && (this.updating || Date.now() - this.updatedAt < legacyCacheTtlMs)) return;
		this.clearInfo();
		const location = locationFromSettings(this.settings);
		if (!location) {
			this.weather = null;
			this.updatedAt = Date.now();
			this.notify();
			return;
		};
		const info = infoForLocation(location);
		this.info = info;
		this.updating = true;
		info.connectObject('updated', () => {
			if (info !== this.info) return;
			this.updating = false;
			this.updatedAt = Date.now();
			this.weather = info.is_valid() ? weatherFromInfo(info, location, this.locationName) : null;
			this.notify();
		}, this);
		info.update();
	},

	notify() {
		for (const callback of [...this.listeners]) {
			if (this.listeners.has(callback)) {
				callback(this.weather, this.locationName);
			};
		};
	},

	stop() {
		if (this.timerId) {
			GLib.Source.remove(this.timerId);
		};
		this.timerId = 0;
		this.extensionSettings?.disconnectObject(this);
		this.extensionSettings = null;
		this.settings?.disconnectObject(this);
		this.settings = null;
		this.clearInfo();
		this.openMeteo?.destroy();
		this.openMeteo = null;
	},
};

export function cleanup() {
	weatherService.stop();
	weatherService.listeners.clear();
	weatherService.weather = null;
	weatherService.locationName = null;
	weatherService.locationKey = null;
	weatherService.updatedAt = 0;
	temperatureState.clear();
};

export function style(theme) {
	return surfaceStyle(theme);
};

export function locationNameFromSettings(settings) {
	const strings = locationStringsFromSettings(settings);

	return strings[0] || null;
};

function locationStringsFromSettings(settings) {
	if (!settings) {
		return [];
	};

	const locations = settings.get_value('locations');

	if (locations.n_children() === 0) {
		return [];
	};

	const serialized = locations.get_child_value(0).print(true);

	return [...serialized.matchAll(/'([^']*)'/g)].map(match => match[1]);
};

export function locationFromSettings(settings) {
	if (!settings || !GWeather) {
		return null;
	};

	try {
		const locations = settings.get_value('locations');

		return locations.n_children() > 0
			? GWeather.Location.get_world()?.deserialize(locations.get_child_value(0).deep_unpack()) ?? null
			: null;
	} catch (error) {
		warn('weather-location-deserialize', `Could not deserialize Weather app location: ${error.message}`);
		return null;
	};
};

export function infoForLocation(location) {
	const info = GWeather.Info.new(location);

	info.set_application_id('com.github.TheRealSourcer.Widgets');
	info.set_contact_info('https://github.com/TheRealSourcer/widgets');
	info.set_enabled_providers(
		GWeather.Provider.METAR |
		GWeather.Provider.MET_NO |
		GWeather.Provider.OWM);
	return info;
};

export function weatherFromInfo(info, location, displayName = null) {
	const currentInfo = currentConditionsInfo(info);
	const locationName = currentInfo.get_location_name();
	const apparent = formatTemperature(currentInfo.get_apparent());

	return {
		temp: formatTemperature(currentInfo.get_temp()),
		summary: cleanSummary(currentInfo.get_weather_summary(), locationName),
		location: displayName || location.get_city_name() || locationName,
		icon: currentInfo.get_icon_name() || 'weather-clear',
		feelsLike: apparent && apparent !== '--' ? `It feels like ${apparent}` : null,
		forecast: forecastDays(info),
	};
};

export function forecastDays(info) {
	const today = new Date();
	const dayKey = date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
	const byDay = new Map();
	const now = Date.now() / 1000;

	for (const forecast of info.get_forecast_list() ?? []) {
		const time = forecastUpdateTime(forecast);
		if (!time || time <= now) {
			continue;
		};
		const date = new Date(time * 1000);
		const key = dayKey(date);
		if (key === dayKey(today)) {
			continue;
		};
		const temp = formatTemperature(forecast.get_temp());
		if (temp === '--') {
			continue;
		};
		const distance = Math.abs(date.getHours() - 12);
		if (byDay.has(key) && byDay.get(key).distance <= distance) {
			continue;
		};
		byDay.set(key, {time, distance,
			day: date.toLocaleDateString(undefined, {weekday: 'short'}),
			temp, icon: forecast.get_icon_name() || 'weather-clear'});
	};
	return [...byDay.values()].sort((a, b) => a.time - b.time).slice(0, 5);
};

function currentConditionsInfo(info) {
	return formatTemperature(info.get_temp()) !== '--' ? info : currentForecastInfo(info);
};

function forecastUpdateTime(info) {
	const [ok, updateTime] = info.get_value_update();

	return ok ? updateTime : null;
};

function currentForecastInfo(info) {
	const forecasts = info.get_forecast_list() ?? [];
	const now = Math.floor(Date.now() / 1000);
	let bestPast = null;
	let bestFuture = null;

	for (const forecast of forecasts) {
		const updateTime = forecastUpdateTime(forecast);
		const temp = formatTemperature(forecast.get_temp());

		if (updateTime === null || temp === '--') {
			continue;
		};

		if (updateTime <= now && (!bestPast || updateTime > bestPast.updateTime)) {
			bestPast = {forecast, updateTime};
		} else if (updateTime > now && (!bestFuture || updateTime < bestFuture.updateTime)) {
			bestFuture = {forecast, updateTime};
		};
	};

	return bestPast?.forecast ?? bestFuture?.forecast ?? info;
};

function formatTemperature(temperature) {
	const text = String(temperature ?? '--').trim();
	const match = text.match(/-?\d+(?:[.,]\d+)?/);

	if (!match) {
		return '--';
	};

	const value = Number(match[0].replace(',', '.'));

	return Number.isFinite(value) ? `${Math.round(value)}°` : '--';
};

function cleanSummary(summary, locationName) {
	if (!summary) {
		return 'Weather unavailable';
	};

	if (locationName && summary.startsWith(`${locationName}: `)) {
		return summary.slice(locationName.length + 2);
	};

	const separator = summary.indexOf(': ');

	return separator >= 0 ? summary.slice(separator + 2) : summary;
};

function fallbackIcon(text) {
	const lower = String(text || '').toLowerCase();

	if (lower.includes('thunder') || lower.includes('storm')) {
		return 'weather-storm';
	};
	if (lower.includes('snow') || lower.includes('ice')) {
		return 'weather-snow';
	};
	if (lower.includes('rain') || lower.includes('shower') || lower.includes('drizzle')) {
		return 'weather-showers';
	};
	if (lower.includes('fog') || lower.includes('mist') || lower.includes('haze')) {
		return 'weather-fog';
	};
	if (lower.includes('cloud') || lower.includes('overcast')) {
		return 'weather-few-clouds';
	};

	return 'weather-clear';
};

function fullColorWeatherIcon(iconName) {
	const baseName = String(iconName || 'weather-clear')
		.replace(/-symbolic$/, '')
		.replace(/-(small|large)$/, '');
	const candidates = [
		`${baseName}-large.svg`,
		`${baseName}-small.svg`,
		`${baseName}.svg`,
	];

	for (const candidate of candidates) {
		const path = GLib.build_filenamev(['/usr/share/icons/hicolor/scalable/status', candidate]);
		const file = Gio.File.new_for_path(path);

		if (file.query_exists(null)) {
			return Gio.FileIcon.new(file);
		};
	};

	return null;
};

function clamp(value, minimum, maximum) {
	return Math.max(minimum, Math.min(maximum, value));
};

function numericTemperature(text) {
	const match = String(text ?? '').match(/^\s*([+-]?\d+(?:[.,]\d+)?)\s*°?\s*([CF])?\s*$/i);

	if (!match) {
		return null;
	};

	const value = Number(match[1].replace(',', '.'));

	return Number.isFinite(value)
		? {value, unit: (match[2] ?? '').toUpperCase()}
		: null;
};

function weatherLayout(width, height) {
	const contentWidth = Math.max(140, width - 30);
	const contentHeight = Math.max(120, height - 30);
	const aspect = contentWidth / contentHeight;
	const compact = contentWidth < 170 || contentHeight < 145;
	const wide = aspect > 1.55;
	const tall = aspect < 0.78;
	const large = contentWidth >= 330 && contentHeight >= 330;
	const shortSide = Math.min(contentWidth, contentHeight);
	const tempFont = clamp(Math.round(Math.min(
		contentWidth * (wide ? 0.23 : 0.34),
		contentHeight * (tall ? 0.23 : wide ? 0.34 : 0.31))), compact ? 42 : 50, large ? 112 : 88);

	return {
		compact,
		wide,
		tempFont,
		tempHeight: Math.round(tempFont * 1.22),
		locationFont: clamp(Math.round(shortSide / 13), compact ? 13 : 14, large ? 22 : 18),
		summaryFont: clamp(Math.round(shortSide / 14), compact ? 13 : 14, large ? 20 : 18),
		feelsFont: clamp(Math.round(shortSide / 16), 12, large ? 18 : 16),
		iconSize: clamp(Math.round(shortSide / (wide ? 6.5 : 7.5)), compact ? 22 : 25, large ? 48 : 38),
		sectionGap: clamp(Math.round(shortSide / 70), 2, large ? 7 : 4),
	};
};

function temperatureKey(widget) {
	return widget?.id === undefined || widget?.id === null ? null : String(widget.id);
};

function trackTemperatureBody(body, key) {
	if (!key || temperatureBodies.has(body)) return;

	temperatureBodies.add(body);
	body.connectObject('destroy', () => {
		if (temperatureState.get(key)?.body === body) {
			temperatureState.delete(key);
		};
	}, body);
};

function temperatureActor(body, widget, text, createLabel, color, layout) {
	const key = temperatureKey(widget);
	const currentNumeric = numericTemperature(text);
	const previous = key ? temperatureState.get(key) : null;
	const animate = previous?.numeric && currentNumeric &&
		previous.body === body &&
		previous.numeric.unit === currentNumeric.unit &&
		previous.numeric.value !== currentNumeric.value;
	const stage = new St.Widget({
		layout_manager: new Clutter.BinLayout(),
		style_class: 'widget-weather-temp-stage',
		clip_to_allocation: true,
		x_expand: false,
		x_align: Clutter.ActorAlign.START,
	});
	const row = new St.BoxLayout({
		x_expand: true,
		x_align: Clutter.ActorAlign.FILL,
	});
	const labelStyle = `color: ${color}; font-size: ${layout.tempFont}px;`;
	const currentLabel = createLabel(text, 'widget-weather-temp', labelStyle);

	stage.set_height(layout.tempHeight);
	currentLabel.x_expand = false;
	currentLabel.x_align = Clutter.ActorAlign.START;
	currentLabel.y_align = Clutter.ActorAlign.CENTER;
	stage.add_child(currentLabel);
	row.add_child(stage);

	if (key) {
		trackTemperatureBody(body, key);
		temperatureState.set(key, {text, numeric: currentNumeric, body});
	};

	if (!animate) {
		return row;
	};

	const previousLabel = createLabel(previous.text, 'widget-weather-temp widget-weather-temp-previous', labelStyle);
	const travel = Math.max(16, Math.round(layout.tempFont * 0.38));
	let alive = true;

	previousLabel.x_expand = false;
	previousLabel.x_align = Clutter.ActorAlign.START;
	previousLabel.y_align = Clutter.ActorAlign.CENTER;
	stage.insert_child_below(previousLabel, currentLabel);
	currentLabel.translation_y = -travel;
	currentLabel.opacity = 0;

	stage.connectObject('destroy', () => {
		alive = false;
		previousLabel.remove_all_transitions();
		currentLabel.remove_all_transitions();
	}, stage);

	ease(previousLabel, {
		translation_y: travel,
		opacity: 0,
		duration: TEMPERATURE_ANIMATION_MS,
		mode: Clutter.AnimationMode.EASE_OUT_QUAD,
		onComplete: () => {
			if (alive) {
				previousLabel.destroy();
			};
		},
	});
	ease(currentLabel, {
		translation_y: 0,
		opacity: 255,
		duration: TEMPERATURE_ANIMATION_MS,
		mode: Clutter.AnimationMode.EASE_OUT_QUAD,
	});

	return row;
};

export function render(context) {
	const {body} = context;

	const unsubscribe = weatherService.subscribe((weather, weatherLocation) => {
		body.destroy_all_children();
		renderWeather({...context, weather, weatherLocation});
	}, context.settings);
	body.connectObject('destroy', unsubscribe, body);
};

function renderWeather({body, widget, createLabel, theme, weather, weatherLocation, sizeForWidget}) {
	const detail = widget.data.detail || 'Weather unavailable';
	const openMeteoActive = weatherService.openMeteo?.hasLocation() ?? false;
	const renderedWeather = weather ?? {
		temp: '--',
		summary: openMeteoActive ? 'Loading weather…' : 'Weather unavailable',
		location: weatherLocation || widget.data.location || 'Weather',
		icon: fallbackIcon(detail),
		feelsLike: null,
		hint: openMeteoActive ? null : 'Use Open-Meteo: set a city in Widgets preferences',
	};
	const [widgetWidth, widgetHeight] = sizeForWidget ? sizeForWidget(widget) : [220, 220];
	const layout = weatherLayout(widgetWidth, widgetHeight);
	const forecast = renderedWeather.forecast ?? [];
	const showForecast = forecast.length > 0 &&
		['medium', 'large', 'tall', 'wide', 'huge'].includes(widget.size);
	if (showForecast && widgetHeight < 260) {
		layout.tempFont = Math.min(layout.tempFont, 52);
		layout.tempHeight = Math.round(layout.tempFont * 1.22);
	};
	const locationRow = new St.BoxLayout({
		style_class: 'widget-weather-location-row',
		x_expand: true,
		x_align: Clutter.ActorAlign.FILL,
	});
	const refreshIconSize = Math.max(12, Math.round(layout.locationFont * 0.85));
	const refreshButton = new St.Button({
		style_class: 'widget-weather-refresh-button',
		reactive: true,
		can_focus: true,
		track_hover: true,
		x_align: Clutter.ActorAlign.END,
		y_align: Clutter.ActorAlign.CENTER,
		child: new St.Icon({
			icon_name: 'view-refresh-symbolic',
			style: `color: ${theme.muted}; icon-size: ${refreshIconSize}px;`,
		}),
	});
	const locationIcon = new St.Icon({
		icon_name: 'find-location-symbolic',
		style_class: 'widget-weather-location-icon',
		style: `color: ${theme.muted}; icon-size: ${Math.max(12, Math.round(layout.locationFont * 0.8))}px;`,
		x_align: Clutter.ActorAlign.START,
		y_align: Clutter.ActorAlign.CENTER,
	});
	const locationLabel = createLabel(
		renderedWeather.location,
		'widget-weather-location-name',
		`color: ${theme.muted}; font-size: ${layout.locationFont}px;`);
	const bottomRow = new St.BoxLayout({
		...boxOrientation(!layout.wide),
		style_class: `widget-weather-bottom ${layout.wide ? 'widget-weather-bottom-wide' : ''}`,
		style: `spacing: ${layout.sectionGap}px;`,
		x_expand: true,
		x_align: layout.wide ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.START,
	});
	const iconParams = {
		style_class: 'widget-weather-icon',
		style: `icon-size: ${layout.iconSize}px;`,
		x_align: Clutter.ActorAlign.START,
		y_align: Clutter.ActorAlign.CENTER,
	};
	const gicon = fullColorWeatherIcon(renderedWeather.icon);

	if (gicon) {
		iconParams.gicon = gicon;
	} else {
		iconParams.icon_name = renderedWeather.icon;
	};

	const icon = new St.Icon(iconParams);
	const details = new St.BoxLayout({
		...VERTICAL,
		style_class: 'widget-weather-details',
		style: `spacing: ${Math.max(1, layout.sectionGap - 1)}px;`,
		x_expand: layout.wide,
		x_align: Clutter.ActorAlign.START,
		y_align: Clutter.ActorAlign.CENTER,
	});

	locationLabel.x_expand = true;
	locationRow.add_child(locationLabel);
	locationRow.add_child(locationIcon);
	locationRow.add_child(refreshButton);
	refreshButton.connectObject('clicked', () => {
		if (weatherService.openMeteo?.hasLocation()) {
			weatherService.openMeteo.refresh(true);
		} else {
			weatherService.refresh(true);
		};
	}, refreshButton);
	body.add_child(locationRow);
	body.add_child(temperatureActor(body, widget, renderedWeather.temp, createLabel, theme.text, layout));
	body.add_child(new St.Widget({y_expand: true}));

	details.add_child(createLabel(
		renderedWeather.summary,
		'widget-weather-summary',
		`color: ${theme.text}; font-size: ${layout.summaryFont}px;`));
	if (renderedWeather.feelsLike) {
		details.add_child(createLabel(
			renderedWeather.feelsLike,
			'widget-weather-feels-like',
			`color: ${theme.muted}; font-size: ${layout.feelsFont}px;`));
	};

	bottomRow.add_child(icon);
	bottomRow.add_child(details);
	body.add_child(bottomRow);
	if (renderedWeather.hint) {
		const hint = createLabel(
			renderedWeather.hint,
			'widget-weather-hint',
			`color: ${theme.muted}; font-size: ${Math.max(11, layout.feelsFont - 2)}px;`);
		hint.set_width(Math.max(100, widgetWidth - 40));
		hint.clutter_text.line_wrap = true;
		body.add_child(hint);
	};
	if (showForecast) {
		const days = ['large', 'huge', 'wide'].includes(widget.size) ? 5 : 3;
		const forecastRow = new St.BoxLayout({
			style_class: 'widget-weather-forecast',
			style: `spacing: ${layout.sectionGap}px; margin-top: ${widgetHeight < 260 ? 4 : 12}px;`,
			x_expand: true,
		});
		for (const day of forecast.slice(0, days)) {
			const column = new St.BoxLayout({
				...VERTICAL,
				x_expand: true,
				x_align: Clutter.ActorAlign.FILL,
			});
			const title = createLabel(day.day, 'widget-weather-forecast-day',
				`color: ${theme.muted}; font-size: ${widgetHeight < 260 ? 12 : 14}px;`);
			title.x_align = Clutter.ActorAlign.CENTER;
			column.add_child(title);
			const gicon = fullColorWeatherIcon(day.icon);
			const dayIcon = new St.Icon({
				...(gicon ? {gicon} : {icon_name: day.icon}),
				icon_size: widgetHeight < 260 ? 20 : 28,
				x_align: Clutter.ActorAlign.CENTER,
			});
			column.add_child(dayIcon);
			const temperature = createLabel(day.temp, 'widget-weather-forecast-temp',
				`color: ${theme.text}; font-size: ${widgetHeight < 260 ? 14 : 17}px;`);
			temperature.x_align = Clutter.ActorAlign.CENTER;
			column.add_child(temperature);
			forecastRow.add_child(column);
		};
		body.add_child(forecastRow);
	};
	if (openMeteoActive) {
		body.add_child(createLabel(
			'Weather data by Open-Meteo.com',
			'widget-weather-attribution',
			`color: ${theme.muted}; font-size: 10px;`));
	};
};
