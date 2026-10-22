import * as AppLauncherWidget from '../widgets/applauncher/widget.js';
import * as BatteryWidget from '../widgets/battery/widget.js';
import * as BinaryClockWidget from '../widgets/binaryclock/widget.js';
import * as CalendarWidget from '../widgets/calendar/widget.js';
import * as ClockWidget from '../widgets/clock/widget.js';
import * as DigitalClockWidget from '../widgets/digitalclock/widget.js';
import * as EventsWidget from '../widgets/events/widget.js';
import * as GitHubWidget from '../widgets/github/widget.js';
import * as MusicWidget from '../widgets/music/widget.js';
import * as PhotosWidget from '../widgets/photos/widget.js';
import * as ScreenTimeWidget from '../widgets/screentime/widget.js';
import * as StocksWidget from '../widgets/stocks/widget.js';
import * as TodoWidget from '../widgets/todo/widget.js';
import * as WeatherWidget from '../widgets/weather/widget.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const GRID_SIZE = 20;
export const WIDGET_GAP = GRID_SIZE;
export const SMALL_WIDGET_SIZE = 220;
export const MEDIUM_WIDGET_WIDTH = SMALL_WIDGET_SIZE * 2 + WIDGET_GAP;

export const WIDGET_MODULES = [
	ClockWidget,
	DigitalClockWidget,
	BinaryClockWidget,
	CalendarWidget,
	EventsWidget,
	WeatherWidget,
	PhotosWidget,
	BatteryWidget,
	MusicWidget,
	TodoWidget,
	GitHubWidget,
	AppLauncherWidget,
	ScreenTimeWidget,
	StocksWidget,
];
const DEFAULT_WIDGET_TYPES = new Set(['clock', 'calendar', 'weather', 'photos', 'battery']);
export const WIDGETS = new Map(WIDGET_MODULES.map(widgetModule => [widgetModule.type, widgetModule]));
export const DEFAULT_WIDGETS = WIDGET_MODULES
	.filter(widgetModule => DEFAULT_WIDGET_TYPES.has(widgetModule.type))
	.map(widgetModule => ({
		id: `${widgetModule.type}-default`,
		type: widgetModule.type,
		size: widgetModule.defaultSize,
	}));
export const WIDGET_APP_IDS = Object.fromEntries(WIDGET_MODULES
	.filter(widgetModule => widgetModule.appIds)
	.map(widgetModule => [widgetModule.type, widgetModule.appIds]));
export const WIDGET_SIZES = {
	small: [SMALL_WIDGET_SIZE, SMALL_WIDGET_SIZE],
	medium: [MEDIUM_WIDGET_WIDTH, SMALL_WIDGET_SIZE],
	large: [MEDIUM_WIDGET_WIDTH, MEDIUM_WIDGET_WIDTH],
};
const LEGACY_WIDGET_SIZES = {compact: 'small', tall: 'large', wide: 'medium', huge: 'large'};

export function supportedWidgetSize(size, widgetModule) {
	const normalized = LEGACY_WIDGET_SIZES[size] ?? size;
	return WIDGET_SIZES[normalized] && widgetModule.supportedSizes.includes(normalized)
		? normalized
		: widgetModule.defaultSize;
};
export function widgetCatalog() {
	return [
		{type: 'clock', label: _('Analog Clock'), category: _('Clocks'), description: _('An analog clock'),
			keywords: ['time'], iconName: 'preferences-system-time-symbolic'},
		{type: 'digitalclock', label: _('Digital Clock'), category: _('Clocks'), description: _('A scalable digital time display'),
			keywords: ['time', 'numbers'], iconName: 'alarm-symbolic'},
		{type: 'binaryclock', label: _('Binary Clock'), category: _('Clocks'), description: _('Time displayed as binary-coded dots'),
			keywords: ['time', 'binary'], iconName: 'view-grid-symbolic'},
		{type: 'calendar', label: _('Calendar'), category: _('Calendar'), description: _('A compact monthly calendar'),
			keywords: ['date', 'month'], iconName: 'x-office-calendar-symbolic'},
		{type: 'events', label: _('Events'), category: _('Calendar'), description: _('Upcoming events from GNOME Calendar'),
			keywords: ['appointments', 'schedule'], iconName: 'office-calendar-symbolic'},
		{type: 'weather', label: _('Weather'), category: _('Information'), description: _('Current conditions from GNOME Weather'),
			keywords: ['temperature', 'forecast'], iconName: 'weather-few-clouds-symbolic'},
		{type: 'photos', label: _('Photos'), category: _('Media'), description: _('Rotating pictures from your photo folders'),
			keywords: ['pictures', 'images'], iconName: 'image-x-generic-symbolic'},
		{type: 'battery', label: _('Battery'), category: _('Information'), description: _('Computer and Bluetooth battery levels'),
			keywords: ['power', 'devices'], iconName: 'battery-level-100-symbolic'},
		{type: 'music', label: _('Media Player'), category: _('Media'), description: _('MPRIS playback information and controls'),
			keywords: ['audio', 'music', 'video', 'player'], iconName: 'audio-x-generic-symbolic'},
		{type: 'todo', label: _('Tasks'), category: _('Productivity'), description: _('A persistent interactive task list'),
			keywords: ['todo', 'checklist'], iconName: 'view-list-symbolic'},
		{type: 'github', label: _('GitHub Activity'), category: _('Information'), description: _('Contribution activity for a public profile'),
			keywords: ['git', 'contributions', 'developer'], iconName: 'vcs-git-symbolic'},
		{type: 'applauncher', label: _('App Launcher'), category: _('Applications'), description: _('Quick access to installed applications'),
			keywords: ['apps', 'grid', 'launch'], iconName: 'view-app-grid-symbolic'},
		{type: 'screentime', label: _('Screen Time'), category: _('Information'), description: _('Local focused-application usage history'),
			keywords: ['usage', 'activity'], iconName: 'preferences-system-time-symbolic'},
		{type: 'stocks', label: _('Stocks'), category: _('Finance'), description: _('Market quotes and recent trends'),
			keywords: ['shares', 'market', 'finance'], iconName: 'office-chart-line-symbolic'},
	].map(record => ({
		...record,
		sizes: WIDGETS.get(record.type).supportedSizes,
		defaultSize: WIDGETS.get(record.type).defaultSize,
	}));
};
