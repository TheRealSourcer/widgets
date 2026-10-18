import St from 'gi://St';
import {surfaceStyle} from '../../utils/widget.js';
import {VERTICAL, HORIZONTAL} from '../../compatibility.js';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import {loadJsonFromFileAsync, getDataDir, safeStorageId} from '../../utils/storage.js';
import {cssColorToRgba} from '../../utils/colors.js';

export const type = 'applauncher';
export const label = 'App Launcher';
export const stylesheet = 'widgets/applauncher/stylesheet.css';
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium', 'large'];

const MAX_APPS = 16;
const DEFAULT_APP_ICON = 'application-x-executable-symbolic';
const DRAG_THRESHOLD_PIXELS = 10;
const OUTER_MARGIN = 12;
const GRID_GAP = 8;
const TILE_BASE_ALPHA = 0.07;
const TILE_HOVER_ALPHA = 0.13;
const TILE_PADDING_RATIO = 0.07;
const TILE_PADDING_MIN = 3;
const TILE_PADDING_MAX = 12;

const ICON_SIZE_RATIO = 0.85;
const MIN_ICON_SIZE = 12;
const MAX_ICON_SIZE = 200;

const DEFAULT_APP_CANDIDATES = [
	{ ids: ['org.gnome.Nautilus.desktop', 'nautilus.desktop'], name: 'Files' },
	{ ids: ['org.gnome.Console.desktop', 'org.gnome.Terminal.desktop', 'com.raggesilver.BlackBox.desktop'], name: 'Terminal' },
	{ ids: ['firefox.desktop', 'org.mozilla.firefox.desktop', 'org.gnome.Epiphany.desktop'], name: 'Web' },
	{ ids: ['org.gnome.Settings.desktop', 'gnome-control-center.desktop'], name: 'Settings' },
];

let GioUnix = null;
try {
	GioUnix = (await import('gi://GioUnix')).default;
} catch (_error) {
};

function resolveDesktopAppInfo(appKey) {
	try {
		const DesktopAppInfo = GioUnix?.DesktopAppInfo ?? Gio.DesktopAppInfo;
		return DesktopAppInfo?.new(appKey) ?? null;
	} catch (_error) {
		return null;
	};
};

function defaultApps() {
	const defaults = [];
	const seen = new Set();
	for (const candidate of DEFAULT_APP_CANDIDATES) {
		const id = candidate.ids.find(appId => resolveDesktopAppInfo(appId));
		if (id && !seen.has(id)) {
			defaults.push({id, name: candidate.name});
			seen.add(id);
		};
	};

	if (defaults.length < DEFAULT_APP_CANDIDATES.length) {
		try {
			const installed = Gio.AppInfo.get_all()
				.filter(info => info.should_show?.() !== false && info.get_id?.())
				.sort((a, b) => String(a.get_display_name()).localeCompare(String(b.get_display_name())));
			for (const info of installed) {
				const id = info.get_id();
				if (seen.has(id)) {
					continue;
				};
				defaults.push({id, name: info.get_display_name()});
				seen.add(id);
				if (defaults.length >= DEFAULT_APP_CANDIDATES.length) {
					break;
				};
			};
		} catch (error) {
			console.debug(`Could not enumerate default launcher applications: ${error}`);
		};
	};
	return defaults;
};

function validatedApps(data) {
	if (!data || !Array.isArray(data.apps)) return null;
	return data.apps
		.filter(app => app && typeof app.id === 'string' && app.id.length > 0 && app.id.length <= 512)
		.slice(0, MAX_APPS)
		.map(app => ({
			id: app.id,
			name: typeof app.name === 'string' && app.name.trim() ? app.name.trim().slice(0, 128) : '',
		}));
};

function gridContentSize(widgetWidth, widgetHeight) {
	return {
		width: Math.max(1, widgetWidth - (OUTER_MARGIN * 2)),
		height: Math.max(1, widgetHeight - (OUTER_MARGIN * 2)),
	};
};

function computeGridLayout(appCount, widgetWidth, widgetHeight) {
	if (appCount <= 0) return { cols: 1, rows: 1 };

	const content = gridContentSize(widgetWidth, widgetHeight);
	let best = null;

	for (let cols = 1; cols <= appCount; cols++) {
		const rows = Math.ceil(appCount / cols);
		const cellWidth = (content.width - (GRID_GAP * (cols - 1))) / cols;
		const cellHeight = (content.height - (GRID_GAP * (rows - 1))) / rows;
		const minCell = Math.min(cellWidth, cellHeight);
		const empty = (cols * rows) - appCount;

		const better = !best
            || minCell > best.minCell + 0.5
            || (Math.abs(minCell - best.minCell) <= 0.5 && empty < best.empty)
            || (Math.abs(minCell - best.minCell) <= 0.5 && empty === best.empty && rows < best.rows);

		if (better) {
			best = { cols, rows, minCell, empty };
		};
	};

	return { cols: best.cols, rows: best.rows };
};

function maxAppsFor(sizeKey) {
	switch (sizeKey) {
		case 'small':
			return 4;
		case 'medium':
			return 8;
		case 'large':
			return 12;
		case 'huge':
			return 16;
		default:
			return 12;
	};
};

function computeIconMetrics(cols, rows, widgetWidth, widgetHeight) {
	const content = gridContentSize(widgetWidth, widgetHeight);

	const cellWidth = (content.width - (GRID_GAP * (cols - 1))) / cols;
	const cellHeight = (content.height - (GRID_GAP * (rows - 1))) / rows;
	const minCell = Math.max(MIN_ICON_SIZE, Math.min(cellWidth, cellHeight));

	const padding = Math.min(TILE_PADDING_MAX, Math.max(TILE_PADDING_MIN, Math.round(minCell * TILE_PADDING_RATIO)));
	const available = Math.max(MIN_ICON_SIZE, minCell - (padding * 2));

	const iconSize = Math.min(MAX_ICON_SIZE, Math.max(MIN_ICON_SIZE, Math.round(available * ICON_SIZE_RATIO)));

	return { padding, iconSize };
};

function buildTileStyle(tileRgba, padding) {
	return `background-color: ${tileRgba}; padding: ${padding}px;`;
};

export function style(theme) {
	return surfaceStyle(theme);
};

export function render({ body, widget, theme, sizeForWidget }) {
	const textColor = theme.text;
	const tileBaseBg = cssColorToRgba(textColor, TILE_BASE_ALPHA);
	const tileHoverBg = cssColorToRgba(textColor, TILE_HOVER_ALPHA);

	const sizeKey = widget?.size ?? 'medium';
	const [width, height] = sizeForWidget ? sizeForWidget(widget) : [394, 190];

	const dataDirectory = getDataDir('applauncher');
	const dataFileName = `applauncher-${safeStorageId(widget?.id)}.json`;
	const dataFilePath = GLib.build_filenamev([dataDirectory, dataFileName]);

	let apps = defaultApps();

	const container = new St.BoxLayout({
		...VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		y_align: Clutter.ActorAlign.FILL,
		style_class: 'widget-app-launcher-content',
	});

	body.add_child(container);

	const grid = new St.BoxLayout({
		...VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		y_align: Clutter.ActorAlign.FILL,
		style_class: 'widget-app-launcher-grid',
	});

	container.add_child(grid);

	const launchApp = (appInfo, app, displayName) => {
		if (destroyed) return;

		if (appInfo) {
			try {
				appInfo.launch([], null);
				return;
			} catch (e) {
				console.debug(`Failed to launch ${app.id}:`, e);
			};
		};

		Main.notify(_('App Launcher'), _('Could not launch %s').format(displayName));
	};

	let scaleIdleId = 0;
	let destroyed = false;
	const cancellable = new Gio.Cancellable();

	const buildGrid = () => {
		if (scaleIdleId) {
			GLib.Source.remove(scaleIdleId);
			scaleIdleId = 0;
		};

		body.disconnectObject(grid);

		grid.destroy_all_children();

		if (apps.length === 0) {
			const emptyLabel = new St.Label({
				text: _('No apps configured'),
				x_align: Clutter.ActorAlign.CENTER,
				y_align: Clutter.ActorAlign.CENTER,
				x_expand: true,
				y_expand: true,
				style_class: 'widget-app-launcher-empty',
				style: `color: ${textColor};`,
			});
			grid.add_child(emptyLabel);
			return;
		};

		const maxApps = maxAppsFor(sizeKey);
		const displayApps = apps.slice(0, Math.min(maxApps, MAX_APPS));
		const { cols, rows } = computeGridLayout(displayApps.length, width, height);

		const cells = [];

		const updateCell = (cell, padding, iconSize) => {
			cell.padding = padding;
			cell.button.set_style(buildTileStyle(cell.hovered ? tileHoverBg : tileBaseBg, padding));
			cell.icon.set_icon_size(iconSize);
		};

		for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
			const rowBox = new St.BoxLayout({
				...HORIZONTAL,
				x_expand: true,
				y_expand: true,
				x_align: Clutter.ActorAlign.FILL,
				y_align: Clutter.ActorAlign.FILL,
				style_class: 'widget-app-launcher-row',
			});
			grid.add_child(rowBox);

			for (let colIndex = 0; colIndex < cols; colIndex++) {
				const appIndex = rowIndex * cols + colIndex;
				if (appIndex >= displayApps.length) {
					break;
				};

				const app = displayApps[appIndex];
				const appInfo = resolveDesktopAppInfo(app.id);
				const displayName = (app.name && app.name.trim() !== '') ? app.name : app.id.replace(/\.desktop$/i, '');

				const button = new St.Button({
					style_class: 'widget-action-button widget-app-launcher-button',
					reactive: true,
					can_focus: true,
					track_hover: true,
					x_expand: true,
					y_expand: true,
					style: buildTileStyle(tileBaseBg, TILE_PADDING_MIN),
					x_align: Clutter.ActorAlign.CENTER,
					y_align: Clutter.ActorAlign.CENTER,
				});

				const cellBox = new St.BoxLayout({
					...VERTICAL,
					x_align: Clutter.ActorAlign.CENTER,
					y_align: Clutter.ActorAlign.CENTER,
				});

				const appIcon = new St.Icon({
					icon_name: DEFAULT_APP_ICON,
					icon_size: MIN_ICON_SIZE,
					style: `color: ${textColor};`,
					x_align: Clutter.ActorAlign.CENTER,
				});

				const gicon = appInfo ? appInfo.get_icon() : null;
				if (gicon) {
					appIcon.gicon = gicon;
				};

				cellBox.add_child(appIcon);
				button.set_child(cellBox);
				rowBox.add_child(button);

				const cell = { icon: appIcon, button, padding: TILE_PADDING_MIN, hovered: false, pressX: 0, pressY: 0 };

				button.connectObject('enter-event', () => {
					cell.hovered = true;
					button.set_style(buildTileStyle(tileHoverBg, cell.padding));
					return Clutter.EVENT_PROPAGATE;
				}, button);
				button.connectObject('leave-event', () => {
					cell.hovered = false;
					button.set_style(buildTileStyle(tileBaseBg, cell.padding));
					return Clutter.EVENT_PROPAGATE;
				}, button);

				button.connectObject('button-press-event', (_actor, event) => {
					if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
					const [x, y] = event.get_coords();
					cell.pressX = x;
					cell.pressY = y;
					return Clutter.EVENT_STOP;
				}, button);

				button.connectObject('button-release-event', (_actor, event) => {
					if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;

					const [releaseX, releaseY] = event.get_coords();
					const isClickNotDrag = Math.abs(releaseX - cell.pressX) < DRAG_THRESHOLD_PIXELS
                        && Math.abs(releaseY - cell.pressY) < DRAG_THRESHOLD_PIXELS;

					if (isClickNotDrag) {
						launchApp(appInfo, app, displayName);
					};
					return Clutter.EVENT_STOP;
				}, button);

				cells.push(cell);
			};
		};

		const applyScale = () => {
			if (destroyed) return;

			const preview = String(widget?.id).startsWith('preview-');
			const currentWidth = preview || body.width < width / 2 ? width : body.width;
			const currentHeight = preview || body.height < height / 2 ? height : body.height;
			const {padding, iconSize} = computeIconMetrics(cols, rows, currentWidth, currentHeight);
			for (const cell of cells)
				updateCell(cell, padding, iconSize);
		};

		const queueScale = () => {
			if (destroyed || scaleIdleId) return;
			scaleIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
				scaleIdleId = 0;
				applyScale();
				return GLib.SOURCE_REMOVE;
			});
		};
		body.connectObject('notify::width', queueScale,
			'notify::height', queueScale, grid);
		queueScale();
	};

	let reloadTimer = null;
	const reload = () => {
		if (destroyed || reloadTimer) return;
		reloadTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
			reloadTimer = null;
			loadJsonFromFileAsync(dataFilePath, (loaded) => {
				if (destroyed) return;
				const savedApps = validatedApps(loaded);
				if (savedApps) {
					apps = savedApps;
				};
				buildGrid();
			}, cancellable);
			return GLib.SOURCE_REMOVE;
		});
	};

	let fileMonitor = null;
	try {
		fileMonitor = Gio.File.new_for_path(dataDirectory).monitor_directory(Gio.FileMonitorFlags.NONE, null);
		fileMonitor.connectObject('changed', (_monitor, file, otherFile, eventType) => {
			if (destroyed || (file?.get_basename() !== dataFileName && otherFile?.get_basename() !== dataFileName)) return;
			if (eventType === Gio.FileMonitorEvent.CHANGED
                || eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT
                || eventType === Gio.FileMonitorEvent.CREATED
                || eventType === Gio.FileMonitorEvent.DELETED
                || eventType === Gio.FileMonitorEvent.RENAMED
                || eventType === Gio.FileMonitorEvent.MOVED) {
				reload();
			};
		}, container);
	} catch (error) {
		console.debug(`Failed to watch App Launcher data directory: ${error}`);
	};

	container.connectObject('destroy', () => {
		destroyed = true;
		cancellable.cancel();

		if (scaleIdleId) {
			GLib.Source.remove(scaleIdleId);
			scaleIdleId = 0;
		};

		body.disconnectObject(grid);

		if (reloadTimer) {
			GLib.source_remove(reloadTimer);
			reloadTimer = null;
		};

		if (fileMonitor) {
			fileMonitor.disconnectObject(container);
			fileMonitor.cancel();
			fileMonitor = null;
		};
	}, container);

	buildGrid();
	reload();
};
