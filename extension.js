import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as BatteryWidget from './widgets/battery/widget.js';
import * as CalendarWidget from './widgets/calendar/widget.js';
import * as ClockWidget from './widgets/clock/widget.js';
import * as PhotosWidget from './widgets/photos/widget.js';
import * as WeatherWidget from './widgets/weather/widget.js';
import { resetWarnings, warn } from './logger.js';
import { WorkspaceIntegration } from './workspaceIntegration.js';

const EXTENSION_PATH = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const LAYOUT_KEY = 'layout-json';
const GRID_SIZE = 20;
const WIDGET_GAP = 14;
const SMALL_WIDGET_SIZE = 220;
const MEDIUM_WIDGET_WIDTH = SMALL_WIDGET_SIZE * 2 + WIDGET_GAP;
const MIN_WIDGET_WIDTH = 180;
const MIN_WIDGET_HEIGHT = 160;
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';

const WIDGET_MODULES = [
  ClockWidget,
  CalendarWidget,
  WeatherWidget,
  PhotosWidget,
  BatteryWidget,
];
const WIDGETS = new Map(WIDGET_MODULES.map(widgetModule => [widgetModule.type, widgetModule]));
const WIDGET_TYPES = WIDGET_MODULES.map(widgetModule => [widgetModule.type, widgetModule.label]);
const DEFAULT_WIDGETS = WIDGET_MODULES.map(widgetModule => ({
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
  }

  const rightX = snap(Math.max(WIDGET_GAP, monitor.width - MEDIUM_WIDGET_WIDTH - WIDGET_GAP));
  const middleX = snap(Math.max(WIDGET_GAP, rightX - SMALL_WIDGET_SIZE - WIDGET_GAP));
  const leftX = snap(Math.max(WIDGET_GAP, middleX - SMALL_WIDGET_SIZE - WIDGET_GAP));
  const topY = Main.panel?.height ? Main.panel.height + WIDGET_GAP : WIDGET_GAP;
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



function desktopAppExists(appId) {
  const dataDirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()];

  for (const dataDir of dataDirs) {
    const file = Gio.File.new_for_path(GLib.build_filenamev([dataDir, 'applications', appId]));

    if (file.query_exists(null)) {
      return true;
    };
  };

  return false;
};

function createSettings(schemaId) {
  const schema = Gio.SettingsSchemaSource.get_default()?.lookup(schemaId, true);

  return schema ? new Gio.Settings({schema_id: schemaId}) : null;
};

function accentColor(settings) {
  const accent = settings?.get_string('accent-color') ?? 'blue';

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
  const parent = actor.get_parent?.();

  if (parent?.set_child_above_sibling) {
    parent.set_child_above_sibling(actor, null);
  };
};

class WidgetController {
  constructor(extension) {
    this._extension = extension;
    this._widgets = [];
    this._views = new Map();
    this._timeouts = [];
    this._signals = [];
    this._dbusSignalIds = [];
    this._editMode = false;
    this._dragSignalId = 0;
    this._appClickSignalId = 0;
    this._layerDestroySignalId = 0;
    this._lastAppLaunchAt = 0;
    this._workspaceIntegration = new WorkspaceIntegration();
    this._layoutSettings = extension.getSettings();
    this._interfaceSettings = createSettings(INTERFACE_SCHEMA);
    this._weatherSettings = createSettings(WeatherWidget.settingsSchema);
    this._weather = null;
    this._weatherLocation = null;
    this._weatherInfo = null;
    this._weatherInfoSignalId = 0;
    this._weatherUpdating = false;
    this._weatherUpdateTime = 0;
  };

  enable() {
    this._widgets = this._loadWidgets();
    this._saveWidgets();
    this._createIndicator();
    this._createLayer();
    this._rebuildWidgets();
    this._refreshWeather(true);
    this._workspaceIntegration.enable(this._layer);
    this._appClickSignalId = global.stage.connect('captured-event', (_stage, event) => this._handleAppClickEvent(event));

    if (this._interfaceSettings) {
      this._signals.push([
        this._interfaceSettings,
        this._interfaceSettings.connect('changed::color-scheme', () => this._rebuildWidgets()),
      ]);
      this._signals.push([
        this._interfaceSettings,
        this._interfaceSettings.connect('changed::accent-color', () => this._rebuildWidgets()),
      ]);
    };

    if (this._weatherSettings) {
      this._signals.push([
        this._weatherSettings,
        this._weatherSettings.connect('changed::locations', () => {
          this._weather = null;
          this._weatherUpdateTime = 0;
          this._refreshWeather(true);
          this._refreshWeatherViews();
        }),
      ]);
    };

    this._watchBatteryChanges();

    this._signals.push([
      Main.layoutManager,
      Main.layoutManager.connect('monitors-changed', () => {
        this._syncLayerGeometry();
      }),
    ]);

    this._timeouts.push(GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
      this._refreshWidgets();
      return GLib.SOURCE_CONTINUE;
    }));
  };

  destroy() {
    this._workspaceIntegration.destroy();

    for (const timeout of this._timeouts) {
      GLib.source_remove(timeout);
    };

    this._timeouts = [];

    for (const [actor, id] of this._signals) {
      actor.disconnect(id);
    };

    this._signals = [];

    for (const id of this._dbusSignalIds) {
      Gio.DBus.system.signal_unsubscribe(id);
    };

    this._dbusSignalIds = [];

    this._cancelActiveDrag();

    if (this._appClickSignalId) {
      global.stage.disconnect(this._appClickSignalId);
      this._appClickSignalId = 0;
    };

    this._indicator?.destroy();
    this._indicator = null;

    this._clearWeatherInfo();

    this._destroyLayer();
    this._layoutSettings = null;
    this._interfaceSettings = null;
    this._weatherSettings = null;
    this._extension = null;
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
        const size = WIDGET_SIZES[widget.size] ? widget.size : 'small';
        const [defaultWidth, defaultHeight] = WIDGET_SIZES[size];
        const savedWidth = Number.isFinite(widget.width) ? widget.width : defaultWidth;
        const savedHeight = Number.isFinite(widget.height) ? widget.height : defaultHeight;

        return {
          id: String(widget.id),
          type: String(widget.type),
          size,
          width: size === 'medium' && [440, 460].includes(savedWidth) ? defaultWidth : savedWidth,
          height: [210, 440].includes(savedHeight) ? defaultHeight : savedHeight,
          x: Number.isFinite(widget.x) ? widget.x : 24,
          y: Number.isFinite(widget.y) ? widget.y : 80,
          data: widget.data && typeof widget.data === 'object' ? widget.data : {},
        };
      });
  };

  _loadWidgets() {
    try {
      const serialized = this._layoutSettings.get_string(LAYOUT_KEY);

      return serialized ? this._parseWidgets(serialized) : cloneDefaultWidgets();
    } catch (error) {
      warn('layout-load', `Could not load layout: ${error.message}`);
      return cloneDefaultWidgets();
    };
  };

  _saveWidgets() {
    try {
      this._layoutSettings.set_string(LAYOUT_KEY, JSON.stringify({widgets: this._widgets}));
    } catch (error) {
      warn('layout-save', `Could not save layout: ${error.message}`);
    };
  };

  _disconnectViewSignals(view) {
    if (!view?.buttonPressSignalId) {
      return;
    };

    try {
      view.actor.disconnect(view.buttonPressSignalId);
    } catch (error) {
      warn('view-signal-disconnect', `Could not disconnect widget input signal: ${error.message}`);
    };

    view.buttonPressSignalId = 0;
  };

  _clearViews() {
    for (const view of this._views.values()) {
      this._disconnectViewSignals(view);
    };

    this._views.clear();
  };

  _destroyLayer() {
    const layerDestroySignalId = this._layerDestroySignalId;

    this._workspaceIntegration.setSource(null);
    this._cancelActiveDrag();
    this._clearViews();

    if (this._layer && layerDestroySignalId) {
      try {
        this._layer.disconnect(layerDestroySignalId);
      } catch (error) {
        warn('layer-signal-disconnect', `Could not disconnect layer destroy signal: ${error.message}`);
      };
    };

    this._layerDestroySignalId = 0;

    if (this._layer) {
      try {
        this._layer.destroy();
      } catch (error) {
        warn('layer-destroy', `Could not destroy stale layer: ${error.message}`);
      };
    };

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

    this._layerDestroySignalId = this._layer.connect('destroy', actor => {
      this._layerDestroySignalId = 0;

      if (this._layer === actor) {
        this._workspaceIntegration.setSource(null);
        this._cancelActiveDrag();
        this._layer = null;
        this._clearViews();
      };
    });

    backgroundGroup.add_child(this._layer);
    raiseActor(this._layer);
    this._syncLayerGeometry();
    this._workspaceIntegration.setSource(this._layer);
  };

  _syncLayerGeometry() {
    const monitor = Main.layoutManager.primaryMonitor;

    if (!monitor || !this._layer) {
      return;
    };

    this._layer.set_position(monitor.x, monitor.y);
    this._layer.set_size(monitor.width, monitor.height);
    raiseActor(this._layer);
    this._resolveLayout(null, false, true);

    this._workspaceIntegration.queueSync();
  };

  _gnomeTheme() {
    const dark = darkStyleEnabled(this._interfaceSettings);

    return {
      dark,
      accent: accentColor(this._interfaceSettings),
      background: dark ? '#242424' : '#ffffff',
      border: dark ? '#3d3d3d' : '#deddda',
      text: dark ? '#ffffff' : '#241f31',
      muted: dark ? '#c0bfbc' : '#5e5c64',
    };
  };

  _styleForWidget(widget) {
    const widgetModule = WIDGETS.get(widget.type);

    if (!widgetModule?.style) {
      return null;
    };

    return widgetModule.style(this._gnomeTheme());
  };

  _clearWeatherInfo() {
    const info = this._weatherInfo;
    const signalId = this._weatherInfoSignalId;

    this._weatherInfo = null;
    this._weatherInfoSignalId = 0;
    this._weatherUpdating = false;

    if (info && signalId) {
      try {
        info.disconnect(signalId);
      } catch (error) {
        warn('weather-signal-disconnect', `Could not disconnect weather update signal: ${error.message}`);
      };
    };

    info?.abort?.();
  };

  _refreshWeather(force = false) {
    const now = Date.now();

    if (this._weatherUpdating && !force) {
      return;
    };

    if (!force && now - this._weatherUpdateTime < WeatherWidget.cacheTtlMs) {
      return;
    };

    const location = WeatherWidget.locationFromSettings(this._weatherSettings);
    const displayName = WeatherWidget.locationNameFromSettings(this._weatherSettings);
    this._weatherLocation = displayName;

    if (!location) {
      this._clearWeatherInfo();
      this._weather = null;
      this._weatherUpdateTime = now;
      return;
    };

    this._clearWeatherInfo();
    const info = WeatherWidget.infoForLocation(location);
    this._weatherInfo = info;
    this._weatherUpdating = true;

    this._weatherInfoSignalId = info.connect('updated', () => {
      if (info !== this._weatherInfo) {
        return;
      };

      this._weatherUpdating = false;
      this._weatherUpdateTime = Date.now();

      if (info.is_valid()) {
        this._weather = WeatherWidget.weatherFromInfo(info, location, displayName);
      } else {
        this._weather = null;
      };

      this._refreshWeatherViews();
    });

    info.update();
  };

  _refreshWeatherViews() {
    if (this._editMode) {
      return;
    };

    for (const view of this._views.values()) {
      if (view.widget.type === 'weather') {
        this._fillWidgetBody(view.widget, view.body);
      };
    };
  };

  _refreshBatteryViews() {
    for (const view of this._views.values()) {
      if (view.widget.type === 'battery') {
        this._fillWidgetBody(view.widget, view.body);
      };
    };
  };

  _watchBatteryChanges() {
    const refresh = () => this._refreshBatteryViews();
    const refreshBlueZ = (_connection, _sender, _objectPath, _interfaceName, _signalName, parameters) => {
      const [changedInterface] = parameters.deep_unpack();

      if (['org.bluez.Device1', 'org.bluez.Battery1'].includes(changedInterface)) {
        refresh();
      };
    };

    try {
      this._dbusSignalIds.push(
        Gio.DBus.system.signal_subscribe('org.freedesktop.UPower', 'org.freedesktop.UPower', 'DeviceAdded', '/org/freedesktop/UPower', null, Gio.DBusSignalFlags.NONE, refresh),
        Gio.DBus.system.signal_subscribe('org.freedesktop.UPower', 'org.freedesktop.UPower', 'DeviceRemoved', '/org/freedesktop/UPower', null, Gio.DBusSignalFlags.NONE, refresh),
        Gio.DBus.system.signal_subscribe('org.freedesktop.UPower', 'org.freedesktop.DBus.Properties', 'PropertiesChanged', null, 'org.freedesktop.UPower.Device', Gio.DBusSignalFlags.NONE, refresh),
        Gio.DBus.system.signal_subscribe('org.bluez', 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded', '/', null, Gio.DBusSignalFlags.NONE, refresh),
        Gio.DBus.system.signal_subscribe('org.bluez', 'org.freedesktop.DBus.ObjectManager', 'InterfacesRemoved', '/', null, Gio.DBusSignalFlags.NONE, refresh),
        Gio.DBus.system.signal_subscribe('org.bluez', 'org.freedesktop.DBus.Properties', 'PropertiesChanged', null, null, Gio.DBusSignalFlags.NONE, refreshBlueZ));
    } catch (error) {
      warn('battery-watch', `Could not watch battery devices: ${error.message}`);
    };
  };

  _createIndicator() {
    this._indicator = new PanelMenu.Button(0.0, 'Desktop Widgets');
    this._indicator.add_child(new St.Icon({
      icon_name: 'view-grid-symbolic',
      style_class: 'widget-panel-icon',
    }));

    const editItem = new PopupMenu.PopupSwitchMenuItem('Edit Widgets', this._editMode);
    editItem.connect('toggled', (_item, state) => this.setEditMode(state));

    this._indicator.menu.addMenuItem(editItem);
    this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    for (const [type, label] of WIDGET_TYPES) {
      const item = new PopupMenu.PopupMenuItem(`Add ${label}`);
      item.connect('activate', () => this.addWidget(type));
      this._indicator.menu.addMenuItem(item);
    };

    this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const resetItem = new PopupMenu.PopupMenuItem('Reset Default Widgets');
    resetItem.connect('activate', () => {
      this._widgets = cloneDefaultWidgets();
      this._saveWidgets();
      this._rebuildWidgets();
    });

    this._indicator.menu.addMenuItem(resetItem);
    Main.panel.addToStatusArea(this._extension.uuid, this._indicator);
  };

  setEditMode(enabled) {
    this._editMode = enabled;
    this._rebuildWidgets();
  };

  addWidget(type) {
    const widgetModule = WIDGETS.get(type);

    if (!widgetModule) {
      return;
    };

    const index = this._widgets.length;
    const size = WIDGET_SIZES[widgetModule.defaultSize] ? widgetModule.defaultSize : 'small';

    const widget = {
      id: `${type}-${Date.now()}`,
      type,
      size,
      x: snap(32 + (index % 4) * 240),
      y: snap(96 + Math.floor(index / 4) * 250),
      data: {},
    };

    const [width, height] = WIDGET_SIZES[widget.size] ?? WIDGET_SIZES.small;

    widget.width = width;
    widget.height = height;

    const position = this._findOpenPosition(widget, this._widgets);
    widget.x = position.x;
    widget.y = position.y;
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
    if (!this._layer) {
      return;
    };

    this._cancelActiveDrag();
    this._clearViews();
    this._layer.destroy_all_children();

    this._resolveLayout(null, false, true);

    for (const widget of this._widgets) {
      this._createWidget(widget);
    };
  };

  _refreshWidgets() {
    if (this._editMode) {
      return;
    };

    this._refreshWeather(false);

    for (const [id, view] of this._views) {
      if (!['battery', 'calendar', 'weather'].includes(view.widget.type)) {
        continue;
      };

      try {
        if (view.actor.get_parent() !== this._layer || view.body.get_parent() !== view.actor) {
          this._disconnectViewSignals(view);
          this._views.delete(id);
          continue;
        };

        this._fillWidgetBody(view.widget, view.body);
      } catch (error) {
        warn('stale-widget-view', `Dropping stale widget view: ${error.message}`);
        this._disconnectViewSignals(view);
        this._views.delete(id);
      };
    };
  };

  _createWidget(widget) {
    const [width, height] = sizeForWidget(widget);
    const actorParams = {
      vertical: true,
      style_class: `widget widget-${widget.type}`,
      reactive: true,
      can_focus: true,
      track_hover: true,
    };
    const style = this._styleForWidget(widget);

    if (style) {
      actorParams.style = style;
    };

    const actor = new St.BoxLayout(actorParams);

    actor.set_size(width, height);
    actor.set_position(widget.x, widget.y);

    const body = new St.BoxLayout({
      vertical: true,
      style_class: 'widget-body',
      x_expand: true,
      y_expand: true,
    });
    actor.add_child(body);

    this._layer.add_child(actor);
    const view = {
      widget,
      actor,
      body,
      editBorder: null,
      removeButton: null,
      buttonPressSignalId: 0,
    };
    this._views.set(widget.id, view);

    actor.connect('destroy', () => {
      view.buttonPressSignalId = 0;

      if (this._views.get(widget.id)?.actor === actor) {
        this._views.delete(widget.id);
      };
    });

    if (this._editMode) {
      this._makeDraggable(view);
      this._addEditControls(view);
    };

    this._fillWidgetBody(widget, body);
  };

  _removeButtonPosition(widget, removeButton) {
    const [width] = sizeForWidget(widget);

    removeButton.ensure_style();
    const [, buttonWidth] = removeButton.get_preferred_width(-1);

    return {
      x: widget.x + width - buttonWidth - 8,
      y: widget.y + 8,
    };
  };

  _syncEditControls(widget, animate = false) {
    const view = this._views.get(widget.id);

    if (!view?.editBorder && !view?.removeButton) {
      return;
    };

    const overlay = rectForWidget(widget);
    const button = this._removeButtonPosition(widget, view.removeButton);

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
    const editBorder = new St.Widget({
      style_class: 'widget-edit-border',
      reactive: false,
    });

    const removeButton = new St.Button({
      style_class: 'icon-button',
      icon_name: 'window-close-symbolic',
      reactive: true,
      can_focus: true,
      track_hover: true,
      accessible_name: 'Remove widget',
    });

    this._layer.add_child(editBorder);

    removeButton.connect('clicked', () => this.removeWidget(view.widget.id));
    this._layer.add_child(removeButton);

    view.editBorder = editBorder;
    view.removeButton = removeButton;
    this._syncEditControls(view.widget);
  };

  _openWidgetApp(type) {
    for (const appId of WIDGET_APP_IDS[type] ?? []) {
      if (!desktopAppExists(appId)) {
        continue;
      };

      try {
        GLib.spawn_command_line_async(`gtk-launch ${appId}`);
        return;
      } catch (error) {
        warn('app-launch', `Could not launch ${appId} with gtk-launch: ${error.message}`);
      };
    };
  };

  _actorIsDescendantOf(actor, ancestor) {
    for (let current = actor; current; current = current.get_parent?.()) {
      if (current === ancestor) {
        return true;
      };
    }

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

    if ((event.get_button?.() ?? 1) !== 1) {
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
      if (!drag) {
        return;
      };

      drag = null;
      this._clampWidget(widget);
      this._resolveLayout(widget, true, false);
      this._animateWidget(widget, true);
      this._cancelActiveDrag();
      this._saveWidgets();
    };

    const moveDrag = event => {
      if (!drag) {
        return;
      };

      const [stageX, stageY] = event.get_coords();
      const [width, height] = sizeForWidget(widget);
      const monitor = Main.layoutManager.primaryMonitor;
      const minY = Main.panel?.height ? Main.panel.height + WIDGET_GAP : WIDGET_GAP;

      widget.x = clamp(snap(drag.actorX + stageX - drag.stageX), WIDGET_GAP, Math.max(WIDGET_GAP, monitor.width - width - WIDGET_GAP));
      widget.y = clamp(snap(drag.actorY + stageY - drag.stageY), minY, Math.max(minY, monitor.height - height - WIDGET_GAP));
      actor.set_position(widget.x, widget.y);
      this._syncEditControls(widget);
      this._resolveLayout(widget, false, false);
    };

    view.buttonPressSignalId = actor.connect('button-press-event', (_source, event) => {
      if (event.get_button() !== 1) {
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

      this._dragSignalId = global.stage.connect('captured-event', (_stage, capturedEvent) => {
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
      });

      return Clutter.EVENT_STOP;
    });
  };

  _cancelActiveDrag() {
    if (!this._dragSignalId) {
      return;
    };

    global.stage.disconnect(this._dragSignalId);
    this._dragSignalId = 0;
  };

  _fillWidgetBody(widget, body) {
    body.destroy_all_children();
    const widgetModule = WIDGETS.get(widget.type);

    if (!widgetModule?.render) {
      body.add_child(this._label('Unknown widget', 'widget-text'));
      return;
    };

    widgetModule.render({
      body,
      widget,
      theme: this._gnomeTheme(),
      weather: this._weather,
      weatherLocation: this._weatherLocation,
      createLabel: this._label.bind(this),
      sizeForWidget,
    });
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
    const minY = Main.panel?.height ? Main.panel.height + WIDGET_GAP : WIDGET_GAP;
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

    if (!view) {
      return;
    };

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
    const minY = Main.panel?.height ? Main.panel.height + WIDGET_GAP : WIDGET_GAP;
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

export default class DesktopWidgetsExtension extends Extension {
  _loadWidgetStylesheets() {
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    this._widgetStylesheets = [];

    for (const widgetModule of WIDGET_MODULES) {
      if (!widgetModule.stylesheet) {
        continue;
      };

      const file = Gio.File.new_for_path(GLib.build_filenamev([EXTENSION_PATH, widgetModule.stylesheet]));

      if (!file.query_exists(null)) {
        continue;
      };

      try {
        theme.load_stylesheet(file);
        this._widgetStylesheets.push(file);
      } catch (error) {
        warn('stylesheet-load', `Could not load ${widgetModule.stylesheet}: ${error.message}`);
      };
    };
  };

  _unloadWidgetStylesheets() {
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();

    for (const file of this._widgetStylesheets ?? []) {
      try {
        theme.unload_stylesheet(file);
      } catch (error) {
        warn('stylesheet-unload', `Could not unload ${file.get_path()}: ${error.message}`);
      };
    };

    this._widgetStylesheets = [];
  };

  enable() {
    this._loadWidgetStylesheets();
    this._controller = new WidgetController(this);
    this._controller.enable();
  };

  disable() {
    this._controller?.destroy();
    this._controller = null;
    for (const widgetModule of WIDGET_MODULES) {
      widgetModule.cleanup?.();
    };
    this._unloadWidgetStylesheets();
    resetWarnings();
  };
};
