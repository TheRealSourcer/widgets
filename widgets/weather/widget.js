import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather';
import St from 'gi://St';

import { warn } from '../../logger.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { boxLayoutProps } from '../../utils/gnomeCompat.js';

const EXTENSION_PATH = GLib.path_get_dirname(GLib.path_get_dirname(GLib.path_get_dirname(import.meta.url.replace('file://', ''))));

export const type = 'weather';
export const label = 'Weather';
export const stylesheet = 'widgets/weather/stylesheet.css';
export const appIds = ['org.gnome.Weather.desktop'];
export const settingsSchema = 'org.gnome.Weather';
export const cacheTtlMs = 10 * 60 * 1000;
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium', 'large', 'wide'];

const HOUR_MS = 3600 * 1000;
const HOURS_AHEAD = 24;

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text}; border-radius: 16px; padding: 18px 18px 10px 18px;`;
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
	if (!settings) {
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

	info.set_application_id('org.gnome.shell.extensions.desktop-widgets-r3nhick');
	info.set_contact_info('https://github.com/r3nhick/desktop-widgets');
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
	const {hourly, daily} = forecastSeries(info, Date.now());

	return {
		temp: formatTemperature(currentInfo.get_temp()),
		summary: cleanSummary(currentInfo.get_weather_summary(), locationName),
		location: location.get_city_name() || displayName || locationName,
		icon: currentInfo.get_icon_name() || 'weather-clear',
		feelsLike: apparent && apparent !== '--' ? `${_('It feels like')} ${apparent}` : null,
		hourly,
		daily,
	};
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

function forecastSeries(info, nowMs) {
	const list = info.get_forecast_list() ?? [];
	const hourly = [];
	const dayMap = new Map();
	const todayStart = todayStartMs(nowMs);
	const horizon = nowMs + HOURS_AHEAD * HOUR_MS;

	for (const forecast of list) {
		const updateTime = forecastUpdateTime(forecast);

		if (updateTime === null) {
			continue;
		};

		const timeMs = updateTime * 1000;
		const date = new Date(timeMs);
		const hour = date.getHours();
		const minute = date.getMinutes();
		const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
		const maxN = tempNumber(formatTemperature(forecast.get_temp_max?.()));
		const minN = tempNumber(formatTemperature(forecast.get_temp_min?.()));
		const tempN = tempNumber(formatTemperature(forecast.get_temp?.()));
		const dayKey = dayStart;

		if (!dayMap.has(dayKey)) {
			const isToday = dayStart === todayStart;

			dayMap.set(dayKey, {
				time: dayStart,
				day: isToday ? _('Today') : date.toLocaleDateString(undefined, {weekday: 'short'}),
				icon: forecastSymbolicIcon(forecast),
				maxN: null,
				minN: null,
			});
		};

		const entry = dayMap.get(dayKey);
		const dayHigh = maxN !== null ? maxN : tempN;
		const dayLow = minN !== null ? minN : tempN;

		if (dayHigh !== null && (entry.maxN === null || dayHigh > entry.maxN)) {
			entry.maxN = dayHigh;
		};

		if (dayLow !== null && (entry.minN === null || dayLow < entry.minN)) {
			entry.minN = dayLow;
		};

		if (hour === 0 && minute === 0) {
			entry.icon = forecastSymbolicIcon(forecast);
		};

		if (timeMs >= nowMs && timeMs <= horizon && tempN !== null) {
			hourly.push({
				time: timeMs,
				label: date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'}),
				icon: forecastSymbolicIcon(forecast),
				temp: formatTemperature(tempN),
			});
		};
	};

	const daily = [...dayMap.values()]
		.filter(day => day.time >= todayStart && day.maxN !== null)
		.sort((a, b) => a.time - b.time)
		.map(day => ({
			time: day.time,
			day: day.day,
			icon: day.icon,
			high: formatTemperature(day.maxN),
			low: formatTemperature(day.minN),
		}));

	hourly.sort((a, b) => a.time - b.time);

	return {
		hourly: sampleHourly(hourly),
		daily,
	};
};

function todayStartMs(nowMs) {
	const start = new Date(nowMs);

	start.setHours(0, 0, 0, 0);
	return start.getTime();
};

function forecastSymbolicIcon(forecast) {
	return String(forecast.get_symbolic_icon_name?.() ?? forecast.get_icon_name?.() ?? 'weather-clear');
};

function sampleHourly(hourly) {
	const sampled = [];
	let lastTime = -Infinity;

	for (const item of hourly) {
		if (item.temp === '--') {
			continue;
		};

		if (item.time - lastTime < 3 * HOUR_MS) {
			continue;
		};

		sampled.push(item);
		lastTime = item.time;

		if (sampled.length >= 6) {
			break;
		};
	};

	return sampled;
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

// Natural width of a piece of text at the given font; used to size the
// hourly cells so the full time label ("9:00 PM") fits without clipping.
function measureLabelWidth(text, fontPx, weight) {
	const label = new St.Label({
		text: String(text ?? ''),
		style: `font-size: ${fontPx}px; font-weight: ${weight};`,
	});
	const [, natural] = label.get_preferred_width(-1);
	label.destroy();
	return natural;
};

function cleanSummary(summary, locationName) {
	if (!summary) {
		return _('Weather unavailable');
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

function symbolicIconName(iconName) {
	const base = String(iconName || 'weather-clear').replace(/-symbolic$/, '');

	return `${base}-symbolic`;
};

function scaledFont(base, scale) {
	return Math.max(1, Math.round(base * scale));
};

function smallWeatherIcon(iconName, styleClass, theme, sizePx) {
	return new St.Icon({
		style_class: styleClass,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		icon_name: symbolicIconName(iconName),
		style: `icon-size: ${sizePx}px; color: ${theme.text};`,
	});
};

function buildHourlyStrip(hours, theme, createLabel, stripScale, cellCount, opts = {}) {
	const timeFontBase = opts.timeFont ?? 11;
	const timeWeight = opts.timeWeight ?? 600;
	const iconSizeBase = opts.iconSize ?? 15;
	const tempFontBase = opts.tempFont ?? 13;
	const tempWeight = opts.tempWeight ?? 700;
	const timeColor = opts.timeColor ?? theme.muted;
	const strip = new St.BoxLayout(boxLayoutProps({
		style_class: 'widget-weather-hourly',
		x_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		style: `spacing: ${Math.round(6 * stripScale)}px;`,
	}));

	for (let index = 0; index < cellCount; index++) {
		const hour = hours[index];
		const cell = new St.BoxLayout(boxLayoutProps({
			vertical: true,
			style_class: 'widget-weather-hour',
			x_expand: true,
			y_align: Clutter.ActorAlign.CENTER,
		}));

		const timeLabel = createLabel(
			hour ? hour.label : '',
			'widget-weather-hour-time',
			`color: ${timeColor}; font-size: ${scaledFont(timeFontBase, stripScale)}px; font-weight: ${timeWeight}; text-align: center;`);

		timeLabel.x_align = Clutter.ActorAlign.CENTER;
		cell.add_child(timeLabel);
		cell.add_child(smallWeatherIcon(hour ? hour.icon : null, 'widget-weather-hour-icon', theme, scaledFont(iconSizeBase, stripScale)));

		const tempLabel = createLabel(
			hour ? hour.temp : '',
			'widget-weather-hour-temp',
			`color: ${theme.text}; font-size: ${scaledFont(tempFontBase, stripScale)}px; font-weight: ${tempWeight}; text-align: center;`);

		tempLabel.x_align = Clutter.ActorAlign.CENTER;
		cell.add_child(tempLabel);

		strip.add_child(cell);
	};

	return strip;
};

function tempNumber(value) {
	const match = String(value ?? '').match(/-?\d+(?:[.,]\d+)?/);

	return match ? Number(match[0].replace(',', '.')) : null;
};

function temperatureRange(daily, theme, createLabel, scale, size = 11) {
	const today = daily[0];

	if (!today) {
		return null;
	};

	const high = tempNumber(today.high);
	const low = tempNumber(today.low);

	if (high === null || low === null) {
		return null;
	};

	return createLabel(
		_('H:%s L:%s').format(today.high, today.low),
		'widget-weather-range',
		`color: ${theme.muted}; font-size: ${scaledFont(size, scale)}px; font-weight: 400;`);
};

function buildHeader(rendered, theme, createLabel, scale, opts = {}) {
	// The main temperature carries the accent color when the toggle allows it.
	const tempColor = opts.tempColor ?? theme.text;
	const cityFont = opts.cityFont ?? 17;
	const cityWeight = opts.cityWeight ?? 800;
	const tempFont = opts.tempFont ?? 38;
	const tempWeight = opts.tempWeight ?? 400;
	const condFont = opts.condFont ?? 13;
	const condWeight = opts.condWeight ?? 700;
	const condIcon = opts.condIcon ?? false;
	const condIconSize = opts.condIconSize ?? 16;
	const left = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		x_align: Clutter.ActorAlign.START,
		style: 'spacing: 0px;',
	}));

	// City name with navigation icon
	const cityRow = new St.BoxLayout(boxLayoutProps({
		vertical: false,
		x_align: Clutter.ActorAlign.START,
		style: 'spacing: 6px;',
	}));

	cityRow.add_child(createLabel(
		rendered.location,
		'widget-weather-city',
		`color: ${theme.text}; font-size: ${scaledFont(cityFont, scale)}px; font-weight: ${cityWeight};`));

	// Navigation icon (use white or black based on theme)
	const iconName = theme.dark ? 'navigation-white' : 'navigation-black';
	const iconPath = `${EXTENSION_PATH}/icons/widgets_settings/weather/${iconName}.svg`;
	const iconFile = Gio.File.new_for_path(iconPath);
	
	if (iconFile.query_exists(null)) {
		const navIcon = new St.Icon({
			gicon: Gio.icon_new_for_string(iconPath),
			icon_size: scaledFont(14, scale),
			y_align: Clutter.ActorAlign.START,
			style: `margin-top: ${scaledFont(1, scale)}px;`,
		});
		cityRow.add_child(navIcon);
	}

	left.add_child(cityRow);

	left.add_child(createLabel(
		rendered.temp,
		'widget-weather-temp-main',
		`color: ${tempColor}; font-size: ${scaledFont(tempFont, scale)}px; font-weight: ${tempWeight};`));

	const right = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		x_align: Clutter.ActorAlign.END,
		y_align: Clutter.ActorAlign.START,
		style: 'spacing: 0px;',
	}));

	if (condIcon) {
		const iconParams = {
			style_class: 'widget-weather-condition-icon',
			style: `icon-size: ${scaledFont(condIconSize, scale)}px; icon-shadow: 0 2px 4px rgba(0, 0, 0, 0.42);`,
			x_align: Clutter.ActorAlign.END,
			y_align: Clutter.ActorAlign.CENTER,
		};
		const gicon = fullColorWeatherIcon(rendered.icon);

		if (gicon) {
			iconParams.gicon = gicon;
		} else {
			iconParams.icon_name = rendered.icon;
		};

		right.add_child(new St.Icon(iconParams));
	};

	const condRow = new St.BoxLayout(boxLayoutProps({
		x_align: Clutter.ActorAlign.END,
		y_align: Clutter.ActorAlign.CENTER,
		style: 'spacing: 4px;',
	}));

	condRow.add_child(createLabel(
		rendered.summary,
		'widget-weather-condition',
		`color: ${theme.text}; font-size: ${scaledFont(condFont, scale)}px; font-weight: ${condWeight};`));

	const range = temperatureRange(rendered.daily, theme, createLabel, scale);

	right.add_child(condRow);
	if (range) {
		range.x_align = Clutter.ActorAlign.END;
		right.add_child(range);
	};

	// With equalColumnWidth (2x1) the header splits into two exact halves;
	// otherwise the left column keeps its natural width and the rest goes
	// to a spacer. Fixed widths are used instead of layout-manager
	// homogeneous settings: St/Clutter allocation quirks made the left
	// column disappear with those.
	const header = new St.BoxLayout(boxLayoutProps({
		style_class: 'widget-weather-header',
		x_expand: true,
		y_align: Clutter.ActorAlign.START,
		style: 'spacing: 8px;',
	}));

	if (opts.equalColumnWidth) {
		left.set_width(opts.equalColumnWidth);
		right.set_width(opts.equalColumnWidth);
	};

	header.add_child(left);
	if (!opts.equalColumnWidth) {
		header.add_child(new St.Widget({x_expand: true}));
	};
	header.add_child(right);
	return header;
};

function buildTempBar(day, allDays, trackWidth = 110) {
	const trackHeight = 4;
	const lows = allDays.map(d => tempNumber(d.low));
	const highs = allDays.map(d => tempNumber(d.high));
	const min = Math.min(...lows.filter(n => n !== null));
	const max = Math.max(...highs.filter(n => n !== null));
	const low = tempNumber(day.low);
	const high = tempNumber(day.high);
	const span = max - min;

	let start = 0.15;
	let width = 0.55;

	if (Number.isFinite(span) && span > 0 && low !== null && high !== null) {
		start = (low - min) / span;
		width = (high - low) / span;
	};

	start = Math.max(0, Math.min(0.92, start));
	width = Math.max(0.08, Math.min(1 - start, width));

	const track = new St.BoxLayout(boxLayoutProps({
		style: `width: ${trackWidth}px; height: ${trackHeight}px; background-color: rgba(255, 255, 255, 0.12); border-radius: 2px;`,
		x_align: Clutter.ActorAlign.START,
		x_expand: false,
	}));

	track.set_size(trackWidth, trackHeight);

	const offset = Math.round(trackWidth * start);
	const fillWidth = Math.max(3, Math.round(trackWidth * width));

	if (offset > 0) {
		const spacer = new St.Widget({x_expand: false});
		spacer.set_size(offset, trackHeight);
		track.add_child(spacer);
	};

	const fill = new St.Widget({
		style: `width: ${fillWidth}px; height: ${trackHeight}px; background-gradient-direction: horizontal; background-gradient-start: #30b0c7; background-gradient-end: #ffd60a; border-radius: 2px;`,
		x_expand: false,
	});

	fill.set_size(fillWidth, trackHeight);
	track.add_child(fill);
	return track;
};

function buildWeekList(days, theme, createLabel, scale, barWidth = 110, fill = false) {
	const list = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		style_class: 'widget-weather-week',
		style: `spacing: ${Math.round(6 * scale)}px;`,
	}));

	// With fill the list itself claims every free pixel under the hourly
	// strip, and its rows split that height equally — the card has no empty
	// gap at the bottom.
	if (fill) {
		list.y_expand = true;
	};

	for (const day of days) {
		const row = new St.BoxLayout(boxLayoutProps({
			style_class: 'widget-weather-day-row',
			x_expand: true,
			x_align: Clutter.ActorAlign.FILL,
			y_align: Clutter.ActorAlign.CENTER,
			style: `spacing: ${Math.round(6 * scale)}px;`,
		}));

		// With fill the rows share the leftover height of the card equally,
		// so the week list reaches the bottom edge with no empty gap.
		if (fill) {
			row.y_expand = true;
		};
		const name = createLabel(
			day.day,
			'widget-weather-day-name',
			`color: ${theme.text}; font-size: ${scaledFont(16, scale)}px; font-weight: 500; width: ${Math.round(56 * scale)}px;`);

		name.x_expand = false;
		name.clutter_text.set_line_wrap(false);
		name.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
		row.add_child(name);
		row.add_child(smallWeatherIcon(day.icon, 'widget-weather-day-icon', theme, scaledFont(24, scale)));

		const low = createLabel(
			day.low,
			'widget-weather-day-temps widget-weather-day-low',
			`color: ${theme.muted}; font-size: ${scaledFont(18, scale)}px; font-weight: 400; text-align: right; width: ${Math.round(30 * scale)}px;`);

		low.x_expand = false;
		row.add_child(low);
		row.add_child(buildTempBar(day, days, barWidth));

		const high = createLabel(
			day.high,
			'widget-weather-day-temps widget-weather-day-high',
			`color: ${theme.text}; font-size: ${scaledFont(18, scale)}px; font-weight: 600; text-align: right; width: ${Math.round(30 * scale)}px;`);

		high.x_expand = false;
		row.add_child(high);
		list.add_child(row);
	};

	return list;
};

function stripDivider() {
	return new St.Widget({
		x_expand: true,
		style: 'height: 1px; min-height: 1px; background-color: rgba(255, 255, 255, 0.12); margin-top: 4px; margin-bottom: 2px;',
	});
};

// Compact (1×1) card in the W01 style: location label, a bold accent-colored
// temperature, then the condition icon, the sky summary and the day's
// high/low, stacked in a single left-aligned column.
function buildCompactRegime(body, rendered, theme, createLabel, scale, tempColor) {
	// City name with navigation icon
	const cityRow = new St.BoxLayout(boxLayoutProps({
		vertical: false,
		x_align: Clutter.ActorAlign.START,
		style: 'spacing: 5px;',
	}));

	cityRow.add_child(createLabel(
		rendered.location,
		'widget-weather-city',
		`color: ${theme.text}; font-size: ${scaledFont(16, scale)}px; font-weight: 800;`));

	// Navigation icon (use white or black based on theme)
	const iconName = theme.dark ? 'navigation-white' : 'navigation-black';
	const iconPath = `${EXTENSION_PATH}/icons/widgets_settings/weather/${iconName}.svg`;
	const iconFile = Gio.File.new_for_path(iconPath);
	
	if (iconFile.query_exists(null)) {
		const navIcon = new St.Icon({
			gicon: Gio.icon_new_for_string(iconPath),
			icon_size: scaledFont(12, scale),
			y_align: Clutter.ActorAlign.START,
			style: `margin-top: ${scaledFont(1, scale)}px;`,
		});
		cityRow.add_child(navIcon);
	}

	body.add_child(cityRow);

	body.add_child(createLabel(
		rendered.temp,
		'widget-weather-temp-main',
		`color: ${tempColor ?? theme.accent}; font-size: ${scaledFont(40, scale)}px; font-weight: 600;`));
	body.add_child(new St.Widget({y_expand: true}));

	const bottom = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		x_align: Clutter.ActorAlign.START,
		y_align: Clutter.ActorAlign.END,
		style: 'spacing: 2px;',
	}));
	const iconParams = {
		style_class: 'widget-weather-icon',
		style: `icon-size: ${scaledFont(24, scale)}px; icon-shadow: 0 2px 4px rgba(0, 0, 0, 0.42);`,
		x_align: Clutter.ActorAlign.START,
		y_align: Clutter.ActorAlign.CENTER,
	};
	const gicon = fullColorWeatherIcon(rendered.icon);

	if (gicon) {
		iconParams.gicon = gicon;
	} else {
		iconParams.icon_name = rendered.icon;
	};

	bottom.add_child(new St.Icon(iconParams));
	bottom.add_child(createLabel(
		rendered.summary,
		'widget-weather-summary',
		`color: ${theme.text}; font-size: ${scaledFont(13, scale)}px; font-weight: 600;`));

	// H/L: a notch larger than the header range, kept at normal weight.
	const range = temperatureRange(rendered.daily, theme, createLabel, scale, 12);

	if (range) {
		bottom.add_child(range);
	};

	body.add_child(bottom);
};

export function render({body, widget, createLabel, theme, weather, weatherLocation, sizeForWidget, settings}) {
	// The main temperature is accent-colored by default; the toggle in the
	// widget's preferences switches it back to the neutral text color.
	const useAccentColor = settings?.get_boolean('weather-use-accent-color') ?? true;
	const tempColor = useAccentColor ? theme.accent : theme.text;
	const detail = widget.data.detail || _('Weather unavailable');
	const renderedWeather = weather ?? {
		temp: formatTemperature(String(detail).split(/\s+/)[0] || '--'),
		summary: String(detail).replace(/^\S+\s*/, '') || _('Open Weather to set a location'),
		location: weatherLocation || widget.data.location || _('GNOME Weather'),
		icon: fallbackIcon(detail),
		feelsLike: null,
		hourly: [],
		daily: [],
	};
	const [widgetWidth, widgetHeight] = sizeForWidget(widget);

	// Three coherent regimes, decided by width and height:
	//   compact (width < 340):        location + accent temp + icon/summary/H-L (1x1)
	//   wide    (width >= 340, short): header + hourly strip             (2x4)
	//   large   (width >= 340, tall):  header + hourly + temp-bar week   (4x4)
	const large = widgetWidth >= 340 && widgetHeight >= 340;
	const wide = widgetWidth >= 340 && !large;
	// Exact equal halves for the 2x1 header: content box = cell width minus
	// the card chrome (18px padding on each side + 1px border), minus the
	// 8px gap between the two header columns.
	const equalColumnWidth = Math.floor((widgetWidth - 38 - 8) / 2);
	// HTML mockups are drawn at 360px (wide/large) and 170px (compact),
	// but the real widgets are 454px / 220px wide, so scale fonts up
	// proportionally to keep them looking the same size as in the mockups.
	const scale = Math.max(1, Math.min(1.6, widgetWidth / 360));
	const compactScale = large || wide ? 1 : Math.max(0.9, Math.min(1.6, Math.min(widgetWidth, widgetHeight) / 170));

	if (!wide && !large) {
		buildCompactRegime(body, renderedWeather, theme, createLabel, compactScale, tempColor);
		return;
	};

	const hourly = renderedWeather.hourly;
	// Size the hourly cells from the measured time label so the full
	// "9:00 PM" always fits (12h locales) instead of being clipped.
	const stripTimeFont = large ? 12 : 10;
	const stripTimeWeight = large ? 700 : 800;
	const widestHourTime = hourly.slice(0, 6).reduce(
		(maxW, item) => Math.max(maxW, item ? measureLabelWidth(item.label, scaledFont(stripTimeFont, scale), stripTimeWeight) : 0),
		0);
	const hourCellWidth = Math.max(Math.round(52 * scale), widestHourTime + Math.round(8 * scale));
	const hourCount = Math.min(6, Math.max(4, Math.floor((widgetWidth - Math.round(40 * scale)) / hourCellWidth)), hourly.length || 0);

	if (large) {
		body.add_child(buildHeader(renderedWeather, theme, createLabel, scale, {
			cityFont: 17,
			cityWeight: 800,
			tempFont: 38,
			tempWeight: 600,
			tempColor,
			condFont: 13,
			condWeight: 800,
			condIcon: true,
			condIconSize: 16,
		}));

		if (hourly.length > 0 && hourCount >= 4) {
			body.add_child(stripDivider());
			body.add_child(buildHourlyStrip(hourly, theme, createLabel, scale, hourCount, {
				timeFont: 12,
				timeWeight: 700,
				iconSize: 24,
				tempFont: 14,
				tempWeight: 700,
				timeColor: theme.muted,
			}));
		};

		if (renderedWeather.daily.length > 0) {
			const stripContentH = Math.round((12 + 24 + 14 + 16) * scale);
			const headerH = Math.round((17 + 2 + 38) * scale);
			const availableH = Math.max(1, widgetHeight - Math.round(24 * scale) - headerH - stripContentH - (hourCount >= 4 ? Math.round(14 * scale) : 0) - Math.round(8 * scale));
			// 2x2 (square) can fit a longer week list, the 4x2 (wide) layout
			// keeps a 5-day summary: square/tall widgets show as many days as
			// the available height allows (up to 8 days, incl. the day after
			// Saturday); wide widgets show exactly one more than before.
			const wideLayout = widgetWidth >= widgetHeight * 1.6;
			let targetDays = Math.min(5, renderedWeather.daily.length);
			if (!wideLayout) {
				const maxDays = Math.min(8, renderedWeather.daily.length);
				for (let n = targetDays + 1; n <= maxDays; n++) {
					if (availableH / (n * 22 + (n - 1) * 6) >= 0.65)
						targetDays = n;
					else
						break;
				};
			};
			const days = renderedWeather.daily.slice(0, targetDays);
			const weeklyScale = Math.max(0.65, Math.min(scale, availableH / (targetDays * 22 + (targetDays - 1) * 6)));
			const rowSpacing = Math.round(6 * weeklyScale);
			const rowWidths = Math.round(56 * weeklyScale) + Math.round(20 * weeklyScale) + Math.round(30 * weeklyScale) + Math.round(30 * weeklyScale) + rowSpacing * 4;
			const barWidth = Math.max(60, widgetWidth - Math.round(36 * weeklyScale) - rowWidths);

			if (days.length > 0) {
				body.add_child(stripDivider());
				body.add_child(buildWeekList(days, theme, createLabel, weeklyScale, barWidth, true));
			};
		} else {
			// No week data: the old bottom spacer keeps the hourly strip
			// anchored under the header instead of stretching it.
			body.add_child(new St.Widget({y_expand: true}));
		};
		return;
	};

	// Wide (2x4, Tokyo): city + temp left, condition (icon + text + range) right,
	// hourly strip at the bottom.
	body.add_child(buildHeader(renderedWeather, theme, createLabel, scale, {
		cityFont: 17,
		cityWeight: 800,
		tempFont: 34,
		tempWeight: 600,
		tempColor,
		condFont: 14,
		condWeight: 700,
		condIcon: true,
		condIconSize: 16,
		equalColumnWidth,
	}));

	if (!(hourly.length > 0 && hourCount >= 4)) {
		body.add_child(new St.Widget({y_expand: true}));
		return;
	};

	body.add_child(new St.Widget({y_expand: true}));
	body.add_child(buildHourlyStrip(hourly, theme, createLabel, scale, hourCount, {
		timeFont: 12,
		timeWeight: 800,
		iconSize: 26,
		tempFont: 18,
		tempWeight: 700,
		timeColor: theme.muted,
	}));
};