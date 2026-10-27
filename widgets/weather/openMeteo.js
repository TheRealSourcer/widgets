import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {warn} from '../../logger.js';

export const cacheTtlMs = 60 * 1000;

const REFRESH_SECONDS = 60;
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const decoder = new TextDecoder();

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
		this._lastError = null;
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
		if (this._timerId) {
			GLib.Source.remove(this._timerId);
			this._timerId = 0;
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

		if (normalized === this._query) {
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
		if (!this._query) {
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
		this.stopTimer();
		this._cancel();
		this._session.abort();
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
		return generation !== this._generation;
	};

	_finish(generation, weather) {
		if (this._stale(generation)) {
			return;
		};

		this._cancellable = null;
		this._updating = false;
		this._updatedAt = Date.now();
		this._lastError = null;
		this._weather = weather;
		this._onUpdate();
	};

	_getJson(url, cancellable) {
		return new Promise((resolve, reject) => {
			const message = Soup.Message.new('GET', url);

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
			if (error.message !== this._lastError) {
				this._lastError = error.message;
				warn('weather-open-meteo', `Could not fetch weather: ${error.message}`);
			};
		};
	};
};
