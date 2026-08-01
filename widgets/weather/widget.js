import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather';
import St from 'gi://St';

import { warn } from '../../logger.js';

export const type = 'weather';
export const label = 'Weather';
export const stylesheet = 'widgets/weather/stylesheet.css';
export const appIds = ['org.gnome.Weather.desktop'];
export const settingsSchema = 'org.gnome.Weather';
export const cacheTtlMs = 10 * 60 * 1000;
export const defaultSize = 'small';

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text};`;
};

function stationFromSettings(settings) {
	const strings = locationStringsFromSettings(settings);

	return strings[1] || null;
};

export function locationNameFromSettings(settings) {
	const strings = locationStringsFromSettings(settings);

	return strings[0] || null;
};

function locationStringsFromSettings(settings) {
	if (!settings) {
		return [];
	};

	try {
		const locations = settings.get_value('locations');

		if (locations.n_children() === 0) {
			return [];
		};

		const serialized = locations.get_child_value(0).print(true);

		return [...serialized.matchAll(/'([^']*)'/g)].map(match => match[1]);
	} catch (error) {
		warn('weather-location-read', `Could not read Weather app location: ${error.message}`);
		return [];
	};
};

export function locationFromSettings(settings) {
	const stationCode = stationFromSettings(settings);

	return stationCode
		? GWeather.Location.get_world()?.find_by_station_code(stationCode)
		: null;
};

export function infoForLocation(location) {
	const info = GWeather.Info.new(location);

	info.set_application_id('com.github.TheRealSourcer.Widgets');
	info.set_contact_info('https://github.com/TheRealSourcer/widgets');
	info.set_enabled_providers(GWeather.Provider.ALL);
	return info;
};

export function weatherFromInfo(info, location, displayName = null) {
	const currentInfo = currentConditionsInfo(info);
	const locationName = currentInfo.get_location_name();
	const apparent = formatTemperature(currentInfo.get_apparent?.());

	return {
		temp: formatTemperature(currentInfo.get_temp()),
		summary: cleanSummary(currentInfo.get_weather_summary(), locationName),
		location: displayName || location.get_city_name() || locationName,
		icon: currentInfo.get_icon_name() || 'weather-clear',
		feelsLike: apparent && apparent !== '--' ? `It feels like ${apparent}` : null,
	};
};

function currentConditionsInfo(info) {
	return formatTemperature(info.get_temp()) !== '--' ? info : currentForecastInfo(info);
};

function forecastUpdateTime(info) {
	try {
		const [ok, updateTime] = info.get_value_update();

		return ok ? updateTime : null;
	} catch {
		return null;
	};
};

function currentForecastInfo(info) {
	const forecasts = info.get_forecast_list?.() ?? [];
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

export function render({body, widget, createLabel, theme, weather, weatherLocation}) {
	const detail = widget.data.detail || 'Weather unavailable';
	const renderedWeather = weather ?? {
		temp: formatTemperature(String(detail).split(/\s+/)[0] || '--'),
		summary: String(detail).replace(/^\S+\s*/, '') || 'Open Weather to set a location',
		location: weatherLocation || widget.data.location || 'GNOME Weather',
		icon: fallbackIcon(detail),
		feelsLike: null,
	};
	const locationRow = new St.BoxLayout({
		style_class: 'widget-weather-location-row',
		x_align: Clutter.ActorAlign.START,
	});
	const locationIcon = new St.Icon({
		icon_name: 'find-location-symbolic',
		style_class: 'widget-weather-location-icon',
		style: `color: ${theme.muted};`,
		x_align: Clutter.ActorAlign.START,
		y_align: Clutter.ActorAlign.CENTER,
	});
	const locationLabel = createLabel(
		renderedWeather.location,
		'widget-weather-location-name',
		`color: ${theme.muted};`);
	const bottomRow = new St.BoxLayout({
		vertical: true,
		style_class: 'widget-weather-bottom',
		x_expand: true,
		x_align: Clutter.ActorAlign.START,
	});
	const iconParams = {
		style_class: 'widget-weather-icon',
		style: 'icon-shadow: 0 2px 4px rgba(0, 0, 0, 0.42);',
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
		vertical: true,
		style_class: 'widget-weather-details',
		x_align: Clutter.ActorAlign.START,
	});

	locationLabel.x_expand = false;
	locationRow.add_child(locationLabel);
	locationRow.add_child(locationIcon);
	body.add_child(locationRow);
	body.add_child(createLabel(renderedWeather.temp, 'widget-weather-temp', `color: ${theme.text};`));
	body.add_child(new St.Widget({y_expand: true}));

	details.add_child(createLabel(renderedWeather.summary, 'widget-weather-summary', `color: ${theme.text};`));
	if (renderedWeather.feelsLike) {
		details.add_child(createLabel(renderedWeather.feelsLike, 'widget-weather-feels-like', `color: ${theme.muted};`));
	};

	bottomRow.add_child(icon);
	bottomRow.add_child(details);
	body.add_child(bottomRow);
};
