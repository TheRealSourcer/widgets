import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {warn} from '../../logger.js';

export const GWEATHER_CACHE_TTL_MS = 10 * 60 * 1000;

const REFRESH_SECONDS = 30;
const GNOME_WEATHER_SCHEMA = 'org.gnome.Weather';
const LOCATIONS_KEY = 'locations';
const UNAVAILABLE_HINT = 'Set a city in Widgets preferences to use Open-Meteo';
const FLATPAK_SCHEMA_DIRS = [
	'/var/lib/flatpak/app/org.gnome.Weather/current/active/files/share/glib-2.0/schemas',
	GLib.build_filenamev([GLib.get_home_dir(), '.local/share/flatpak/app/org.gnome.Weather/current/active/files/share/glib-2.0/schemas']),
];

let GWeather = null;

try {
	GWeather = (await import('gi://GWeather')).default;
} catch (error) {
	warn('weather-gweather-missing', `GWeather is unavailable: ${error.message}`);
};

function gnomeWeatherSettings() {
	const defaultSource = Gio.SettingsSchemaSource.get_default();
	let schema = defaultSource.lookup(GNOME_WEATHER_SCHEMA, true);

	for (const dir of FLATPAK_SCHEMA_DIRS) {
		if (schema) {
			break;
		};

		if (!GLib.file_test(GLib.build_filenamev([dir, 'gschemas.compiled']), GLib.FileTest.EXISTS)) {
			continue;
		};

		try {
			schema = Gio.SettingsSchemaSource.new_from_directory(dir, defaultSource, false)
				.lookup(GNOME_WEATHER_SCHEMA, true);
		} catch (error) {
			warn('weather-gnome-schema', `Could not load GNOME Weather schema from ${dir}: ${error.message}`);
		};
	};

	return schema?.has_key(LOCATIONS_KEY) ? new Gio.Settings({settings_schema: schema}) : null;
};

function messageWeather(name, summary, hint = null) {
	return {
		temp: '--',
		summary,
		location: name,
		icon: 'weather-severe-alert',
		feelsLike: null,
		forecast: [],
		hint,
	};
};

function infoForLocation(location) {
	const info = GWeather.Info.new(location);

	info.set_application_id('com.github.TheRealSourcer.Widgets');
	info.set_contact_info('https://github.com/TheRealSourcer/widgets');
	info.set_enabled_providers(
		GWeather.Provider.METAR |
		GWeather.Provider.MET_NO |
		GWeather.Provider.OWM);
	return info;
};

function weatherFromInfo(info, location, displayName = null) {
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

function forecastDays(info) {
	const today = new Date();
	const dayKey = date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
	const byDay = new Map();
	const now = Date.now() / 1000;

	for (const forecast of info.get_forecast_list()) {
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
	const forecasts = info.get_forecast_list();
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

export class GWeatherService {
	constructor(onUpdate) {
		this._onUpdate = onUpdate;
		this._settings = null;
		this._info = null;
		this._active = false;
		this._location = null;
		this._locationKey = null;
		this._weather = null;
		this._updatedAt = 0;
		this._updating = false;
		this._timerId = 0;
	};

	get weather() {
		return this._weather;
	};

	get locationName() {
		return this._location ? this._location.get_city_name() : null;
	};

	hasLocation() {
		return this._active;
	};

	start() {
		this._settings = gnomeWeatherSettings();
		this._settings?.connectObject(`changed::${LOCATIONS_KEY}`, () => {
			this._cancel();
			this._weather = null;
			this.refresh(true);
		}, this);

		if (this._timerId) {
			GLib.Source.remove(this._timerId);
			this._timerId = 0;
		};
		this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
			this.refresh();
			return GLib.SOURCE_CONTINUE;
		});
	};

	setActive(active) {
		const next = Boolean(active);

		if (next === this._active) {
			return false;
		};

		this._cancel();
		this._active = next;
		this._weather = null;
		this._updatedAt = 0;
		return true;
	};

	refresh(force = false) {
		if (!this._active) {
			return;
		};

		if (!force && (this._updating || Date.now() - this._updatedAt < GWEATHER_CACHE_TTL_MS)) {
			return;
		};

		this._cancel();

		const location = this._resolveLocation();

		if (!location) {
			this._finish(messageWeather('Weather', 'GNOME Weather unavailable', UNAVAILABLE_HINT));
			return;
		};

		const info = infoForLocation(location);

		this._info = info;
		this._updating = true;
		info.connectObject('updated', () => {
			this._info = null;
			this._updating = false;
			info.disconnectObject(this);
			this._finish(info.is_valid()
				? weatherFromInfo(info, location, location.get_city_name())
				: messageWeather(location.get_city_name(), 'GNOME Weather unavailable', UNAVAILABLE_HINT));
		}, this);
		info.update();
	};

	destroy() {
		if (this._timerId) {
			GLib.Source.remove(this._timerId);
			this._timerId = 0;
		};
		this._settings?.disconnectObject(this);
		this._settings = null;
		this._cancel();
		this._onUpdate = null;
		this._location = null;
		this._weather = null;
	};

	_resolveLocation() {
		if (!GWeather || !this._settings) {
			return null;
		};

		const locations = this._settings.get_value(LOCATIONS_KEY);
		const key = locations.print(true);

		if (key === this._locationKey) {
			return this._location;
		};

		this._locationKey = key;
		this._location = null;

		if (locations.n_children() === 0) {
			return null;
		};

		try {
			this._location = GWeather.Location.get_world().deserialize(locations.get_child_value(0).deep_unpack());
		} catch (error) {
			warn('weather-location-deserialize', `Could not read the GNOME Weather location: ${error.message}`);
		};

		return this._location;
	};

	_cancel() {
		if (this._info) {
			this._info.disconnectObject(this);
			this._info.abort();
			this._info = null;
		};
		this._updating = false;
	};

	_finish(weather) {
		this._updatedAt = Date.now();
		this._weather = weather;
		this._onUpdate();
	};
};
