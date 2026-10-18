import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import {clipRounded} from './utils/roundedClip.js';
import {VERTICAL, createBlurEffect, hasSetting} from './compatibility.js';
import {surfaceStyle} from './utils/widget.js';
import * as Storage from './utils/storage.js';

import * as AppLauncherWidget from './widgets/applauncher/widget.js';
import * as BatteryWidget from './widgets/battery/widget.js';
import * as BinaryClockWidget from './widgets/binaryclock/widget.js';
import * as CalendarWidget from './widgets/calendar/widget.js';
import * as ClockWidget from './widgets/clock/widget.js';
import * as DigitalClockWidget from './widgets/digitalclock/widget.js';
import * as EventsWidget from './widgets/events/widget.js';
import * as GitHubWidget from './widgets/github/widget.js';
import * as MusicWidget from './widgets/music/widget.js';
import * as PhotosWidget from './widgets/photos/widget.js';
import * as ScreenTimeWidget from './widgets/screentime/widget.js';
import * as StocksWidget from './widgets/stocks/widget.js';
import * as TodoWidget from './widgets/todo/widget.js';
import * as WeatherWidget from './widgets/weather/widget.js';

import {configureLogger, resetLogger, warn} from './logger.js';
import { WidgetGallery } from './widgetGallery.js';
import { WorkspaceIntegration } from './workspaceIntegration.js';

const LAYOUT_KEY = 'layout-json';
const GRID_SIZE = 20;
const WIDGET_GAP = GRID_SIZE;
const REMOVE_BUTTON_SIZE = 32;
const REMOVE_BUTTON_INSET = 12;
const SMALL_WIDGET_SIZE = 220;
const MEDIUM_WIDGET_WIDTH = SMALL_WIDGET_SIZE * 2 + WIDGET_GAP;
const MIN_WIDGET_WIDTH = 180;
const MIN_WIDGET_HEIGHT = 120;
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';

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
const WIDGETS = new Map(WIDGET_MODULES.map(widgetModule => [widgetModule.type, widgetModule]));
const WIDGET_TYPES = WIDGET_MODULES.map(widgetModule => [widgetModule.type, widgetModule.label]);
const DEFAULT_WIDGETS = WIDGET_MODULES
	.filter(widgetModule => DEFAULT_WIDGET_TYPES.has(widgetModule.type))
	.map(widgetModule => ({
		id: `${widgetModule.type}-default`,
		type: widgetModule.type,
		size: widgetModule.defaultSize,
	}));
const WIDGET_APP_IDS = Object.fromEntries(WIDGET_MODULES
	.filter(widgetModule => widgetModule.appIds)
	.map(widgetModule => [widgetModule.type, widgetModule.appIds]));
const WIDGET_SIZES = {
	small: [SMALL_WIDGET_SIZE, SMALL_WIDGET_SIZE],
	medium: [MEDIUM_WIDGET_WIDTH, SMALL_WIDGET_SIZE],
	large: [MEDIUM_WIDGET_WIDTH, MEDIUM_WIDGET_WIDTH],
};
const LEGACY_WIDGET_SIZES = {compact: 'small', tall: 'large', wide: 'medium', huge: 'large'};

function supportedWidgetSize(size, widgetModule) {
	const normalized = LEGACY_WIDGET_SIZES[size] ?? size;
	return WIDGET_SIZES[normalized] && widgetModule.supportedSizes.includes(normalized)
		? normalized
		: widgetModule.defaultSize;
};
function widgetCatalog() {
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
		sizes: WIDGETS.get(record.type)?.supportedSizes ?? [WIDGETS.get(record.type)?.defaultSize ?? 'small'],
		defaultSize: WIDGETS.get(record.type)?.defaultSize ?? 'small',
	}));
};

const ACCENT_COLORS = {
  blue: '#3584e4',
  teal: '#2190a4',
  green: '#3a944a',
  yellow: '#c88800',
  orange: '#ed5b00',
  red: '#e62d42',
  pink: '#d56199',
  purple: '#9141ac',
  slate: '#6f8396',
};

function defaultWidgetPositions() {
  const monitor = Main.layoutManager.primaryMonitor;

  if (!monitor) {
    return null;
  };

  const rightX = snap(Math.max(WIDGET_GAP, monitor.width - MEDIUM_WIDGET_WIDTH - WIDGET_GAP));
  const middleX = snap(Math.max(WIDGET_GAP, rightX - SMALL_WIDGET_SIZE - WIDGET_GAP));
  const leftX = snap(Math.max(WIDGET_GAP, middleX - SMALL_WIDGET_SIZE - WIDGET_GAP));
  const topY = firstDesktopGridRow();
  const bottomY = snap(topY + SMALL_WIDGET_SIZE + WIDGET_GAP);

  return {
    weather: {x: leftX, y: topY},
    calendar: {x: middleX, y: topY},
    photos: {x: rightX, y: topY},
    clock: {x: middleX, y: bottomY},
    battery: {x: rightX, y: bottomY},
  };
};

function cloneDefaultWidgets() {
  const positions = defaultWidgetPositions();

  return DEFAULT_WIDGETS.map(widget => ({
    id: widget.id,
    type: widget.type,
    size: widget.size,
    width: WIDGET_SIZES[widget.size][0],
    height: WIDGET_SIZES[widget.size][1],
    x: positions?.[widget.type]?.x ?? WIDGET_GAP,
    y: positions?.[widget.type]?.y ?? WIDGET_GAP,
    data: {},
  }));
};

function accentColor(settings) {
	const accent = hasSetting(settings, 'accent-color') ? settings.get_string('accent-color') : 'blue';

  return ACCENT_COLORS[accent] ?? ACCENT_COLORS.blue;
};

function darkStyleEnabled(settings) {
  return settings?.get_string('color-scheme') === 'prefer-dark';
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
};

function snap(value) {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
};

function firstDesktopGridRow() {
	return Math.ceil(((Main.panel?.height ?? 0) + WIDGET_GAP) / GRID_SIZE) * GRID_SIZE;
};

function sizeForWidget(widget) {
  const [defaultWidth, defaultHeight] = WIDGET_SIZES[widget.size] ?? WIDGET_SIZES.small;

  return [
    Number.isFinite(widget.width) ? widget.width : defaultWidth,
    Number.isFinite(widget.height) ? widget.height : defaultHeight,
  ];
};

function rectForWidget(widget) {
  const [width, height] = sizeForWidget(widget);

  return {
    x: widget.x,
    y: widget.y,
    width,
    height,
  };
};

function rectsOverlap(a, b) {
  return a.x < b.x + b.width + WIDGET_GAP &&
    a.x + a.width + WIDGET_GAP > b.x &&
    a.y < b.y + b.height + WIDGET_GAP &&
    a.y + a.height + WIDGET_GAP > b.y;
};

function raiseActor(actor) {
  const parent = actor.get_parent();

  if (parent?.set_child_above_sibling) {
    parent.set_child_above_sibling(actor, null);
  };
};

function createBlurredSurface(owner) {
	const monitor = Main.layoutManager.primaryMonitor;
	const surface = new St.Widget({
		reactive: false,
		layout_manager: new Clutter.FixedLayout(),
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		y_align: Clutter.ActorAlign.FILL,
		clip_to_allocation: true,
	});
	const wallpaper = new St.Widget({width: monitor.width, height: monitor.height});
	surface.add_child(wallpaper);
	const manager = new Background.BackgroundManager({
		container: wallpaper, monitorIndex: Main.layoutManager.primaryIndex,
		controlPosition: false,
	});
	const syncPosition = () => wallpaper.set_position(-owner.x, -owner.y);
	owner.connectObject('notify::x', syncPosition, 'notify::y', syncPosition, surface);
	surface.connectObject('destroy', () => {
		owner.disconnectObject(surface);
		manager.destroy();
	}, surface);
	syncPosition();
	surface.add_effect(createBlurEffect({
		brightness: 1,
		radius: 18,
		mode: Shell.BlurMode.ACTOR,
	}));

	return surface;
};

export default class DesktopWidgetsExtension extends Extension {
	enable() {
		configureLogger(this.getLogger?.() ?? null);
		this._widgetStylesheets = [];
		try {
			this._initializeDesktop();
			const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
			for (const widgetModule of WIDGET_MODULES) {
				if (!widgetModule.stylesheet) {
					continue;
				};
				const file = this.dir.resolve_relative_path(widgetModule.stylesheet);
				theme.load_stylesheet(file);
				this._widgetStylesheets.push(file);
			};
			for (const widgetModule of WIDGET_MODULES)
				widgetModule.initialize?.({settings: this._layoutSettings});
			this._enableDesktop();
		} catch (error) {
			this.disable();
			throw error;
		};
	};

	_initializeDesktop() {
		this._widgets = [];
		this._views = new Map();
		this._editMode = false;
		this._dragActor = null;
		this._lastAppLaunchAt = 0;
		this._gallery = null;
		this._galleryKeybindingInstalled = false;
		this._workspaceIntegration = new WorkspaceIntegration();
		this._layoutSettings = this.getSettings();
		if (!this._layoutSettings.get_boolean('style-surface-default-migrated')) {
			this._layoutSettings.set_boolean('style-background-blur', false);
			this._layoutSettings.set_boolean('style-surface-default-migrated', true);
		};
		this._interfaceSettings = new Gio.Settings({schema_id: INTERFACE_SCHEMA});
	};

	_enableDesktop() {
		this._widgets = this._loadWidgets();
		this._saveWidgets();
		this._createLayer();
		this._rebuildWidgets();
		this._createGallery();
		this._installGalleryKeybinding();
		this._workspaceIntegration.enable(this._layer);
		global.stage.connectObject(
			'captured-event', (_stage, event) => this._handleAppClickEvent(event),
			this
		);

		this._interfaceSettings.connectObject(
			'changed::color-scheme', () => {
				this._rebuildWidgets();
			},
			this
		);
		if (hasSetting(this._interfaceSettings, 'accent-color')) {
			this._interfaceSettings.connectObject('changed::accent-color', () => {
				this._rebuildWidgets();
				this._gallery?.setAccentColor(accentColor(this._interfaceSettings));
			}, this);
		};

		this._layoutSettings.connectObject(
			'changed::style-border-radius', () => {
				this._rebuildWidgets();
			},
			'changed::style-background-blur', () => {
				this._rebuildWidgets();
			},
			'changed::edge-launcher-enabled', () => this._syncGalleryLauncher(),
			this
		);

		Main.layoutManager.connectObject(
			'monitors-changed', () => {
				this._syncLayerGeometry();
			},
			this
		);
	};

	disable() {
		this._workspaceIntegration?.destroy();

		global.stage.disconnectObject(this);
		Main.layoutManager.disconnectObject(this);
		this._interfaceSettings?.disconnectObject(this);
		this._layoutSettings?.disconnectObject(this);

		this._cancelActiveDrag();
		this._removeGalleryKeybinding();
		this._gallery?.destroy();
		this._gallery = null;
		this._destroyLayer();
		this._workspaceIntegration = null;
		this._layoutSettings = null;
		this._interfaceSettings = null;
		this._widgets = [];
		this._editMode = false;
		for (const widgetModule of WIDGET_MODULES)
			widgetModule.cleanup?.();
		Storage.cleanup();
		if (this._widgetStylesheets?.length) {
			const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
			for (const file of this._widgetStylesheets) theme.unload_stylesheet(file);
		};
		this._widgetStylesheets = null;
		resetLogger();
	};

	_parseWidgets(serialized) {
		const parsed = JSON.parse(serialized);
		if (!Array.isArray(parsed.widgets)) {
			return cloneDefaultWidgets();
		};

		return parsed.widgets
			.filter(widget => widget.id && widget.type)
			.filter(widget => WIDGET_TYPES.some(([type]) => type === widget.type))
			.map(widget => {
				const size = supportedWidgetSize(widget.size, WIDGETS.get(widget.type));
				const [width, height] = WIDGET_SIZES[size];

				return {
					id: String(widget.id),
					type: String(widget.type),
					size,
					width,
					height,
					x: Number.isFinite(widget.x) ? widget.x : 24,
					y: Number.isFinite(widget.y) ? widget.y : 80,
					data: widget.data && typeof widget.data === 'object' ? widget.data : {},
				};
			});
	};

	_loadWidgets() {
		const serialized = this._layoutSettings.get_string(LAYOUT_KEY);

		return serialized ? this._parseWidgets(serialized) : cloneDefaultWidgets();
	};

	_saveWidgets() {
		this._layoutSettings.set_string(LAYOUT_KEY, JSON.stringify({widgets: this._widgets}));
	};

	_clearViews() {
		for (const view of this._views?.values() ?? []) {
			view.actor.disconnectObject(this);
		};

		this._views?.clear();
	};

	_destroyLayer() {
		this._workspaceIntegration?.setSource(null);
		this._cancelActiveDrag();
		this._clearViews();
		this._layer?.destroy();
		this._layer = null;
	};

	_createLayer() {
		const backgroundGroup = Main.layoutManager._backgroundGroup;

		if (!backgroundGroup) {
			warn('background-group-missing', 'Could not find GNOME Shell background group');
			return;
		};

		this._destroyLayer();

		this._layer = new St.Widget({
			style_class: 'widget-layer',
			reactive: true,
			x_expand: true,
			y_expand: true,
		});

		backgroundGroup.add_child(this._layer);
		raiseActor(this._layer);
		this._syncLayerGeometry();
		this._workspaceIntegration.setSource(this._layer);
	};

	_syncLayerGeometry() {
		const monitor = Main.layoutManager.primaryMonitor;

		if (!monitor || !this._layer) return;

		this._layer.set_position(monitor.x, monitor.y);
		this._layer.set_size(monitor.width, monitor.height);
		raiseActor(this._layer);
		this._resolveLayout(null, false, true);

		this._workspaceIntegration.queueSync();
	};

	_gnomeTheme() {
		const dark = darkStyleEnabled(this._interfaceSettings);
		const blur = this._layoutSettings.get_boolean('style-background-blur');

		return {
			dark,
			blur,
			accent: accentColor(this._interfaceSettings),
			background: blur
				? dark ? 'rgba(36, 36, 36, 0.68)' : 'rgba(255, 255, 255, 0.68)'
				: dark ? '#242424' : '#ffffff',
			border: dark ? '#3d3d3d' : '#deddda',
			text: dark ? '#ffffff' : '#241f31',
			muted: dark ? '#c0bfbc' : '#5e5c64',
			radius: this._layoutSettings.get_int('style-border-radius'),
		};
	};

	_styleForWidget(widget, theme = this._gnomeTheme()) {
		return WIDGETS.get(widget.type)?.style?.(theme) ?? surfaceStyle(theme);
	};

	_createGallery() {
		this._gallery?.destroy();
		this._gallery = new WidgetGallery({
			accentColor: accentColor(this._interfaceSettings),
			catalog: widgetCatalog(),
			createPreview: (type, size, width, height) => this._createWidgetPreview(type, size, width, height),
			onAdd: (type, size) => {
				this.setEditMode(true);
				this.addWidget(type, size);
				this._gallery?.close();
			},
			onDrop: (type, size, stageX, stageY) => {
				const overviewPoint = this._workspaceIntegration.desktopPointForStagePoint(stageX, stageY);
				if (Main.overview.visible || Main.overview.visibleTarget) {
					if (!overviewPoint) return;
				} else {
					const monitor = Main.layoutManager.primaryMonitor;
					if (!monitor || stageX < monitor.x || stageX >= monitor.x + monitor.width ||
              stageY < monitor.y + Main.panel.height || stageY >= monitor.y + monitor.height) return;
					const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, stageX, stageY);
					for (let current = picked; current; current = current.get_parent?.()) {
						const window = current.meta_window ?? current.get_meta_window?.();
						if (window) return;
					};
				};
				this.setEditMode(true);
				this.addWidget(type, size, overviewPoint ?? {x: stageX, y: stageY});
			},
			onEditToggle: () => this.setEditMode(!this._editMode),
			onReset: () => this.resetWidgets(),
			onSettings: () => this.openPreferences(),
			getEditMode: () => this._editMode,
		});
		this._syncGalleryLauncher();
	};

	_syncGalleryLauncher() {
		this._gallery?.setLauncherEnabled(this._layoutSettings.get_boolean('edge-launcher-enabled'));
	};

	_createWidgetPreview(type, size, availableWidth, availableHeight) {
		const [width, height] = WIDGET_SIZES[size] ?? WIDGET_SIZES.small;
		const theme = {...this._gnomeTheme(), blur: false};
		theme.background = theme.dark ? '#242424' : '#ffffff';
		const widget = {id: `preview-${type}-${size}`, type, size, width, height, data: {}};
		const surface = new St.BoxLayout({
			...VERTICAL,
			style_class: `widget widget-${type}`,
			style: this._styleForWidget(widget, theme), width, height,
			clip_to_allocation: true,
		});
		clipRounded(surface, theme.radius);
		const body = new St.Bin({
			style_class: 'widget-body', x_expand: true, y_expand: true});
		surface.add_child(body);
		let rendered = false;
		surface.connectObject('notify::mapped', () => {
			if (rendered || !surface.mapped) return;
			rendered = true;
			try {
				this._renderWidget(widget, body, theme, true, false);
			} catch (error) {
				warn(`preview-${type}`, error.message);
			};
		}, surface);
		const previewInset = 8;
		const [largeWidth, largeHeight] = WIDGET_SIZES.large;
		const scale = Math.min((availableWidth - previewInset * 2) / largeWidth,
			(availableHeight - previewInset * 2) / largeHeight);
		surface.set_scale(scale, scale);
		surface.set_position(Math.round((availableWidth - width * scale) / 2),
			Math.round((availableHeight - height * scale) / 2));
		return surface;
	};

	_installGalleryKeybinding() {
		try {
			Main.wm.addKeybinding(
				'toggle-gallery',
				this._layoutSettings,
				Meta.KeyBindingFlags.NONE,
				Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
				() => this._gallery?.toggle()
			);
			this._galleryKeybindingInstalled = true;
		} catch (error) {
			warn('gallery-keybinding', `Could not register the widget gallery shortcut: ${error.message}`);
		};
	};

	_removeGalleryKeybinding() {
		if (!this._galleryKeybindingInstalled) return;

		Main.wm.removeKeybinding('toggle-gallery');
		this._galleryKeybindingInstalled = false;
	};

	resetWidgets() {
		this._widgets = cloneDefaultWidgets();
		this._saveWidgets();
		this._rebuildWidgets();
	};

	setEditMode(enabled) {
		enabled = Boolean(enabled);
		if (enabled === this._editMode) return;

		this._editMode = enabled;
		this._rebuildWidgets();
	};

	addWidget(type, requestedSize = null, dropPoint = null) {
		const widgetModule = WIDGETS.get(type);

		if (!widgetModule) return;

		const index = this._widgets.length;
		const supportedSizes = widgetModule.supportedSizes ?? [widgetModule.defaultSize];
		const size = requestedSize && supportedSizes.includes(requestedSize) && WIDGET_SIZES[requestedSize]
			? requestedSize
			: WIDGET_SIZES[widgetModule.defaultSize] ? widgetModule.defaultSize : 'small';

		const widget = {
			id: `${type}-${GLib.uuid_string_random()}`,
			type,
			size,
			x: snap(32 + (index % 4) * 240),
			y: snap(96 + Math.floor(index / 4) * 250),
			data: {},
		};

		const [width, height] = WIDGET_SIZES[widget.size] ?? WIDGET_SIZES.small;

		widget.width = width;
		widget.height = height;

		if (dropPoint) {
			const monitor = Main.layoutManager.primaryMonitor;
			const localX = dropPoint.x - (monitor?.x ?? 0) - width / 2;
			const localY = dropPoint.y - (monitor?.y ?? 0) - height / 2;
			const minY = firstDesktopGridRow();
			widget.x = clamp(snap(localX), WIDGET_GAP, Math.max(WIDGET_GAP, (monitor?.width ?? width) - width - WIDGET_GAP));
			widget.y = clamp(snap(localY), minY, Math.max(minY, (monitor?.height ?? height) - height - WIDGET_GAP));
		} else {
			const position = this._findOpenPosition(widget, this._widgets);
			widget.x = position.x;
			widget.y = position.y;
		};
		this._widgets.push(widget);

		this._saveWidgets();
		this._rebuildWidgets();
	};

	removeWidget(id) {
		this._widgets = this._widgets.filter(widget => widget.id !== id);
		this._saveWidgets();
		this._rebuildWidgets();
	};

	_rebuildWidgets() {
		if (!this._layer) return;

		this._cancelActiveDrag();
		const oldViews = [...this._views.values()];
		this._clearViews();

		for (const view of oldViews) {
			view.removeButton?.destroy();
			view.editBorder?.destroy();
			view.actor.destroy();
		};

		this._resolveLayout(null, false, true);

		for (const widget of this._widgets) {
			this._createWidget(widget);
		};

	};

	_createWidget(widget) {
		const [width, height] = sizeForWidget(widget);
		const theme = this._gnomeTheme();
		const surface = WIDGETS.get(widget.type)?.surface;
		const blurredSurface = theme.blur && surface?.blur !== false;
		const actorParams = {
			style_class: `widget widget-${widget.type}`,
			reactive: true,
			can_focus: true,
			track_hover: true,
		};
		const style = this._styleForWidget(widget);
		actorParams.style = style;

		const actor = blurredSurface
			? new St.Widget({...actorParams, layout_manager: new Clutter.BinLayout(),
				style_class: `${actorParams.style_class} widget-blurred-surface`,
				style: `color: ${theme.text};`})
			: new St.BoxLayout({...actorParams, ...VERTICAL});
		actor.set_clip_to_allocation(true);
		actor.set_size(width, height);
		clipRounded(actor, theme.radius);

		if (blurredSurface) {
			try {
				const blurredBackground = createBlurredSurface(actor);
				clipRounded(blurredBackground, theme.radius, 1);
				actor.add_child(blurredBackground);
			} catch (error) {
				warn('widget-background-blur', `Could not enable widget background blur: ${error.message}`);
			};
		};
		actor.set_position(widget.x, widget.y);

		const body = new St.Bin({
			style_class: blurredSurface ? 'widget widget-body' : 'widget-body',
			x_expand: true,
			y_expand: true,
			x_align: Clutter.ActorAlign.FILL,
			y_align: Clutter.ActorAlign.FILL,
			clip_to_allocation: surface?.clipContent ?? false,
			style: blurredSurface ? style : null,
		});
		actor.add_child(body);

		this._layer.add_child(actor);
		const view = {
			widget,
			actor,
			body,
			editBorder: null,
			removeButton: null,
		};
		this._views.set(widget.id, view);

		if (this._editMode) {
			this._makeDraggable(view);
			this._addEditControls(view);
		};

		this._fillWidgetBody(widget, body);
	};

	_removeButtonPosition(widget) {
		const [width] = sizeForWidget(widget);

		return {
			x: widget.x + width - REMOVE_BUTTON_SIZE - REMOVE_BUTTON_INSET,
			y: widget.y + REMOVE_BUTTON_INSET,
		};
	};

	_syncEditControls(widget, animate = false) {
		const view = this._views.get(widget.id);

		if (!view?.editBorder && !view?.removeButton) return;

		const overlay = rectForWidget(widget);
		const button = this._removeButtonPosition(widget);

		if (animate) {
			view.editBorder?.ease({
				x: overlay.x,
				y: overlay.y,
				width: overlay.width,
				height: overlay.height,
				duration: 130,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			});

			view.removeButton?.ease({
				x: button.x,
				y: button.y,
				duration: 130,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			});
		} else {
			view.editBorder?.set_position(overlay.x, overlay.y);
			view.editBorder?.set_size(overlay.width, overlay.height);
			view.removeButton?.set_position(button.x, button.y);
		};

		if (view.editBorder) {
			raiseActor(view.editBorder);
		};

		if (view.removeButton) {
			raiseActor(view.removeButton);
		};
	};

	_addEditControls(view) {
		const theme = this._gnomeTheme();
		const editBorder = new St.Widget({
			style_class: 'widget-edit-border',
			style: `border-color: ${theme.accent}; border-radius: ${theme.radius}px;`,
			reactive: false,
		});

		const removeButton = new St.Button({
			style_class: 'button widget-action-button widget-remove-button',
			child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 16}),
			width: REMOVE_BUTTON_SIZE,
			height: REMOVE_BUTTON_SIZE,
			reactive: true,
			can_focus: true,
			track_hover: true,
			accessible_name: 'Remove widget',
		});

		this._layer.add_child(editBorder);

		removeButton.connectObject('clicked', () => this.removeWidget(view.widget.id), this);
		this._layer.add_child(removeButton);

		view.editBorder = editBorder;
		view.removeButton = removeButton;
		this._syncEditControls(view.widget);
	};

	_openWidgetApp(type) {
		const appSystem = Shell.AppSystem.get_default();
		for (const appId of WIDGET_APP_IDS[type] ?? []) {
			const app = appSystem.lookup_app(appId);
			if (app) {
				app.activate();
				return;
			};
		};
	};

	_actorIsDescendantOf(actor, ancestor) {
		for (let current = actor; current; current = current.get_parent()) {
			if (current === ancestor) {
				return true;
			};
		};

		return false;
	};

	_viewForPickedActor(actor) {
		if (!actor) {
			return null;
		};

		for (const view of this._views.values()) {
			if (!WIDGET_APP_IDS[view.widget.type]) {
				continue;
			};

			if (this._actorIsDescendantOf(actor, view.actor)) {
				for (let current = actor; current && current !== view.actor; current = current.get_parent()) {
					if (current instanceof St.Button) {
						return null;
					};
				};
				return view;
			};
		};

		return null;
	};

	_viewForStagePoint(stageX, stageY) {
		for (const view of this._views.values()) {
			if (!WIDGET_APP_IDS[view.widget.type]) {
				continue;
			};

			const [actorX, actorY] = view.actor.get_transformed_position();
			const [actorWidth, actorHeight] = view.actor.get_transformed_size();

			if (stageX >= actorX && stageX <= actorX + actorWidth && stageY >= actorY && stageY <= actorY + actorHeight) {
				return view;
			};
		};

		return null;
	};

	_pickedActorIsOnDesktop(actor) {
		const backgroundGroup = Main.layoutManager._backgroundGroup;

		return this._actorIsDescendantOf(actor, this._layer) || this._actorIsDescendantOf(actor, backgroundGroup);
	};

	_handleAppClickEvent(event) {
		if (this._editMode || event.type() !== Clutter.EventType.BUTTON_RELEASE) {
			return Clutter.EVENT_PROPAGATE;
		};

		if ((event.get_button() ?? 1) !== 1) {
			return Clutter.EVENT_PROPAGATE;
		};

		const [stageX, stageY] = event.get_coords();
		const pickedActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, stageX, stageY);
		const view = this._viewForPickedActor(pickedActor) ??
      (this._pickedActorIsOnDesktop(pickedActor) ? this._viewForStagePoint(stageX, stageY) : null);

		if (!view) {
			return Clutter.EVENT_PROPAGATE;
		};

		const now = Date.now();

		if (now - this._lastAppLaunchAt > 500) {
			this._lastAppLaunchAt = now;
			this._openWidgetApp(view.widget.type);
		};

		return Clutter.EVENT_STOP;
	};

	_makeDraggable(view) {
		const {actor, widget} = view;
		let drag = null;

		const finishDrag = () => {
			if (!drag) return;

			drag = null;
			this._clampWidget(widget);
			this._resolveLayout(widget, true, false);
			this._animateWidget(widget, true);
			this._cancelActiveDrag();
			this._saveWidgets();
		};

		const moveDrag = event => {
			if (!drag) return;

			const [stageX, stageY] = event.get_coords();
			const [width, height] = sizeForWidget(widget);
			const monitor = Main.layoutManager.primaryMonitor;
			const minY = firstDesktopGridRow();

			widget.x = clamp(snap(drag.actorX + stageX - drag.stageX), WIDGET_GAP, Math.max(WIDGET_GAP, monitor.width - width - WIDGET_GAP));
			widget.y = clamp(snap(drag.actorY + stageY - drag.stageY), minY, Math.max(minY, monitor.height - height - WIDGET_GAP));
			actor.set_position(widget.x, widget.y);
			this._syncEditControls(widget);
			this._resolveLayout(widget, false, false);
		};

		actor.connectObject('captured-event', (_source, event) => {
			if (event.type() !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== 1) {
				return Clutter.EVENT_PROPAGATE;
			};

			if (!this._editMode) {
				return Clutter.EVENT_PROPAGATE;
			};

			this._cancelActiveDrag();

			const [stageX, stageY] = event.get_coords();
			drag = {
				stageX,
				stageY,
				actorX: widget.x,
				actorY: widget.y,
			};

			raiseActor(actor);
			this._syncEditControls(widget);

			this._dragActor = actor;
			global.stage.connectObject('captured-event', (_stage, capturedEvent) => {
				if (!drag) {
					return Clutter.EVENT_PROPAGATE;
				};

				const eventType = capturedEvent.type();
				const isMotion = eventType === Clutter.EventType.MOTION || eventType === Clutter.EventType.MOTION_NOTIFY;
				const isRelease = eventType === Clutter.EventType.BUTTON_RELEASE;

				if (isMotion) {
					moveDrag(capturedEvent);
					return Clutter.EVENT_STOP;
				};

				if (isRelease) {
					finishDrag();
					return Clutter.EVENT_STOP;
				};

				return Clutter.EVENT_PROPAGATE;
			}, actor);

			return Clutter.EVENT_STOP;
		}, this);
	};

	_cancelActiveDrag() {
		if (!this._dragActor) return;

		global.stage.disconnectObject(this._dragActor);
		this._dragActor = null;
	};

	_fillWidgetBody(widget, body) {
		this._renderWidget(widget, body, this._gnomeTheme(), this._editMode);
	};

	_renderWidget(widget, host, theme, editMode, interactive = true) {
		host.destroy_all_children();
		const widgetModule = WIDGETS.get(widget.type);

		if (!widgetModule?.render) {
			host.set_child(this._label('Unknown widget', 'widget-text'));
			return;
		};

		const body = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true,
			x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL});
		host.set_child(body);
		let destroyed = false;
		body.connectObject('destroy', () => { destroyed = true; }, body);
		widgetModule.render({
			body,
			actor: host.get_parent(),
			widget,
			theme,
			createLabel: this._label.bind(this),
			sizeForWidget,
			settings: this._layoutSettings,
			editMode,
			refresh: () => {
				if (!destroyed) {
					this._renderWidget(widget, host, theme, editMode, interactive);
				};
			},
		});
		if (!interactive) {
			const disableInput = actor => {
				actor.reactive = false;
				actor.can_focus = false;
				for (const child of actor.get_children()) disableInput(child);
			};
			disableInput(body);
		};
	};

	_label(text, styleClass, style = null) {
		const params = {
			text,
			style_class: styleClass,
			x_expand: true,
			x_align: Clutter.ActorAlign.START,
		};

		if (style) {
			params.style = style;
		};

		const label = new St.Label(params);

		label.clutter_text.set_line_wrap(true);
		label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
		label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

		return label;
	};

	_clampWidget(widget) {
		const monitor = Main.layoutManager.primaryMonitor;

		if (!monitor) {
			return false;
		};

		let [width, height] = sizeForWidget(widget);
		const oldWidth = width;
		const oldHeight = height;
		const minY = firstDesktopGridRow();
		width = clamp(Math.round(width), MIN_WIDGET_WIDTH, Math.max(MIN_WIDGET_WIDTH, monitor.width - WIDGET_GAP * 2));
		height = clamp(Math.round(height), MIN_WIDGET_HEIGHT, Math.max(MIN_WIDGET_HEIGHT, monitor.height - minY - WIDGET_GAP));
		const x = clamp(snap(widget.x), WIDGET_GAP, Math.max(WIDGET_GAP, monitor.width - width - WIDGET_GAP));
		const y = clamp(snap(widget.y), minY, Math.max(minY, monitor.height - height - WIDGET_GAP));

		if (x === widget.x && y === widget.y && width === oldWidth && height === oldHeight) {
			return false;
		};

		widget.x = x;
		widget.y = y;
		widget.width = width;
		widget.height = height;

		return true;
	};

	_animateWidget(widget, animate) {
		const view = this._views.get(widget.id);

		if (!view) return;

		if (!animate) {
			view.actor.set_position(widget.x, widget.y);
			view.actor.set_size(widget.width, widget.height);
			this._syncEditControls(widget);
			return;
		};

		view.actor.ease({
			x: widget.x,
			y: widget.y,
			width: widget.width,
			height: widget.height,
			duration: 130,
			mode: Clutter.AnimationMode.EASE_OUT_QUAD,
		});

		this._syncEditControls(widget, true);
	};

	_positionIsFreeAgainst(widget, x, y, blockingWidgets) {
		const [width, height] = sizeForWidget(widget);
		const rect = {x, y, width, height};

		return !blockingWidgets.some(other => other !== widget && rectsOverlap(rect, rectForWidget(other)));
	};

	_findOpenPosition(widget, blockingWidgets = []) {
		const monitor = Main.layoutManager.primaryMonitor;

		if (!monitor) {
			return {x: widget.x, y: widget.y};
		};

		const [width, height] = sizeForWidget(widget);
		const minX = WIDGET_GAP;
		const minY = firstDesktopGridRow();
		const maxX = Math.max(minX, monitor.width - width - WIDGET_GAP);
		const maxY = Math.max(minY, monitor.height - height - WIDGET_GAP);
		const originX = clamp(snap(widget.x), minX, maxX);
		const originY = clamp(snap(widget.y), minY, maxY);
		const candidates = [];

		for (let y = minY; y <= maxY; y += GRID_SIZE) {
			for (let x = minX; x <= maxX; x += GRID_SIZE) {
				const snappedX = clamp(snap(x), minX, maxX);
				const snappedY = clamp(snap(y), minY, maxY);
				const distance = Math.abs(snappedX - originX) + Math.abs(snappedY - originY);
				candidates.push({x: snappedX, y: snappedY, distance});
			};
		};

		candidates.sort((a, b) => a.distance - b.distance);

		for (const candidate of candidates) {
			if (this._positionIsFreeAgainst(widget, candidate.x, candidate.y, blockingWidgets)) {
				return {x: candidate.x, y: candidate.y};
			};
		};

		return {x: originX, y: originY};
	};

	_resolveLayout(anchor = null, animate = false, save = false) {
		const orderedWidgets = anchor
			? [anchor, ...this._widgets.filter(widget => widget !== anchor)]
			: [...this._widgets];
		const settled = [];
		let changed = false;

		for (const widget of orderedWidgets) {
			const oldX = widget.x;
			const oldY = widget.y;
			const oldWidth = widget.width;
			const oldHeight = widget.height;

			this._clampWidget(widget);

			if (settled.some(other => rectsOverlap(rectForWidget(widget), rectForWidget(other)))) {
				const position = this._findOpenPosition(widget, settled);
				widget.x = position.x;
				widget.y = position.y;
				this._clampWidget(widget);
			};

			settled.push(widget);

			if (widget.x !== oldX || widget.y !== oldY || widget.width !== oldWidth || widget.height !== oldHeight) {
				changed = true;
				this._animateWidget(widget, animate);
			};
		};

		if (changed && save) {
			this._saveWidgets();
		};

		return changed;
	};
};
