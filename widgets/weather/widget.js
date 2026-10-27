import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {surfaceStyle} from '../../utils/widget.js';
import {ease} from '../../utils/animation.js';
import {VERTICAL, boxOrientation} from '../../compatibility.js';

import {OpenMeteoService, cacheTtlMs} from './openMeteo.js';
import {GWeatherService} from './gweather.js';
import {fullColorWeatherIcon} from './weatherIcons.js';

export const type = 'weather';
export const label = 'Weather';
export const stylesheet = 'widgets/weather/stylesheet.css';
export {cacheTtlMs};
export const defaultSize = 'small';
export const supportedSizes = ['small', 'medium', 'large'];

const WEATHER_LOCATION_KEY = 'weather-location';

const temperatureState = new Map();
const temperatureBodies = new WeakSet();

const TEMPERATURE_ANIMATION_MS = 280;

export const weatherService = {
	listeners: new Set(),
	extensionSettings: null,
	openMeteo: null,
	gweather: null,
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
		return this.extensionSettings?.get_string(WEATHER_LOCATION_KEY).trim() ?? '';
	},

	start(extensionSettings = null) {
		this.stop();
		this.extensionSettings = extensionSettings;
		this.extensionSettings?.connectObject(
			`changed::${WEATHER_LOCATION_KEY}`, () => this.onLocationChanged(), this);

		this.openMeteo = new OpenMeteoService(() => this.onSourceUpdate(this.openMeteo));
		this.gweather = new GWeatherService(() => this.onSourceUpdate(this.gweather));
		this.openMeteo.start();
		this.gweather.start();
		this.refresh();
	},

	hasSource() {
		return this.openMeteo.hasLocation() || this.gweather.hasLocation();
	},

	onLocationChanged() {
		this.locationName = null;
		this.weather = null;
		this.refresh(true);
		this.notify();
	},

	onSourceUpdate(service) {
		if (!service.hasLocation()) {
			return;
		};
		const next = service.weather;
		const unchanged = next && this.weather && JSON.stringify(next) === JSON.stringify(this.weather);
		this.weather = next;
		this.locationName = service.locationName;
		if (!unchanged) {
			this.notify();
		};
	},

	refresh(force = false) {
		const query = this.locationQuery();
		if (query) {
			this.gweather.setActive(false);
			if (this.openMeteo.setLocation(query)) {
				this.weather = null;
			};
			this.locationName = this.openMeteo.locationName;
			this.openMeteo.refresh(force);
			return;
		};
		this.openMeteo.setLocation('');
		if (this.gweather.setActive(true)) {
			this.weather = null;
		};
		this.locationName = this.gweather.locationName;
		this.gweather.refresh(force);
	},

	notify() {
		for (const callback of [...this.listeners]) {
			if (this.listeners.has(callback)) {
				callback(this.weather, this.locationName);
			};
		};
	},

	stop() {
		this.extensionSettings?.disconnectObject(this);
		this.extensionSettings = null;
		this.openMeteo?.destroy();
		this.openMeteo = null;
		this.gweather?.destroy();
		this.gweather = null;
	},
};

export function cleanup() {
	weatherService.stop();
	weatherService.listeners.clear();
	weatherService.weather = null;
	weatherService.locationName = null;
	temperatureState.clear();
};

export function style(theme) {
	return surfaceStyle(theme);
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
	const sourceActive = weatherService.hasSource();
	const openMeteoActive = weatherService.openMeteo.hasLocation();
	const renderedWeather = weather ?? {
		temp: '--',
		summary: sourceActive ? 'Loading weather…' : 'No city set',
		location: weatherLocation || 'Weather',
		icon: 'weather-severe-alert',
		feelsLike: null,
		hint: sourceActive ? null : 'Set a city in Widgets preferences to use Open-Meteo',
	};
	const [widgetWidth, widgetHeight] = sizeForWidget ? sizeForWidget(widget) : [220, 220];
	const layout = weatherLayout(widgetWidth, widgetHeight);
	const forecast = renderedWeather.forecast ?? [];
	const showForecast = forecast.length > 0 &&
		['medium', 'large', 'tall', 'wide', 'huge'].includes(widget.size);
	const sideBySide = showForecast && widgetWidth / widgetHeight > 1.55;
	if (showForecast && widgetHeight < 260) {
		layout.tempFont = Math.min(layout.tempFont, sideBySide ? 60 : 52);
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
	const refreshIcon = refreshButton.get_child();
	refreshIcon.set_pivot_point(0.5, 0.5);
	refreshIcon.connectObject('destroy', () => refreshIcon.remove_all_transitions(), refreshIcon);
	refreshButton.connectObject('clicked', () => {
		refreshIcon.remove_all_transitions();
		refreshIcon.rotation_angle_z = 0;
		ease(refreshIcon, {
			rotation_angle_z: 360,
			duration: 700,
			mode: Clutter.AnimationMode.EASE_OUT_QUAD,
		});
		if (weatherService.openMeteo.hasLocation()) {
			weatherService.openMeteo.refresh(true);
		} else {
			weatherService.refresh(true);
		};
	}, refreshButton);
	const main = sideBySide ? new St.BoxLayout({x_expand: true, y_expand: true}) : body;
	const left = sideBySide
		? new St.BoxLayout({...VERTICAL, x_expand: false, y_expand: true})
		: body;
	if (sideBySide) {
		left.set_width(Math.round((widgetWidth - 30) * 0.5));
	};
	body.add_child(locationRow);
	left.add_child(temperatureActor(body, widget, renderedWeather.temp, createLabel, theme.text, layout));
	left.add_child(new St.Widget({y_expand: true}));

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
	left.add_child(bottomRow);
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
		const days = sideBySide ? 3 : ['large', 'huge', 'wide'].includes(widget.size) ? 5 : 3;
		const forecastRow = new St.BoxLayout({
			style_class: sideBySide ? 'widget-weather-forecast widget-weather-forecast-panel' : 'widget-weather-forecast',
			style: sideBySide
				? 'spacing: 4px; margin-left: 12px; margin-top: 4px;'
				: `spacing: ${layout.sectionGap}px; margin-top: ${widgetHeight < 260 ? 4 : 12}px;`,
			x_expand: true,
			y_expand: sideBySide,
		});
		for (const day of forecast.slice(0, days)) {
			const column = new St.BoxLayout({
				...VERTICAL,
				x_expand: true,
				y_expand: sideBySide,
				x_align: Clutter.ActorAlign.FILL,
				y_align: Clutter.ActorAlign.CENTER,
				style: sideBySide ? 'spacing: 3px;' : '',
			});
			const title = createLabel(day.day, 'widget-weather-forecast-day',
				`color: ${theme.muted}; font-size: ${sideBySide ? 13 : widgetHeight < 260 ? 12 : 14}px;`);
			title.x_align = Clutter.ActorAlign.CENTER;
			column.add_child(title);
			const gicon = fullColorWeatherIcon(day.icon);
			const dayIcon = new St.Icon({
				...(gicon ? {gicon} : {icon_name: day.icon}),
				icon_size: sideBySide ? 30 : widgetHeight < 260 ? 20 : 28,
				x_align: Clutter.ActorAlign.CENTER,
			});
			column.add_child(dayIcon);
			const temperature = createLabel(day.temp, 'widget-weather-forecast-temp',
				`color: ${theme.text}; font-size: ${sideBySide ? 18 : widgetHeight < 260 ? 14 : 17}px;`);
			temperature.x_align = Clutter.ActorAlign.CENTER;
			column.add_child(temperature);
			forecastRow.add_child(column);
		};
		if (sideBySide) {
			main.add_child(left);
			main.add_child(forecastRow);
			body.add_child(main);
		} else {
			body.add_child(forecastRow);
		};
	};
	if (openMeteoActive) {
		body.add_child(createLabel(
			'Weather data by Open-Meteo.com',
			'widget-weather-attribution',
			`color: ${theme.muted}; font-size: 10px;`));
	};
};
