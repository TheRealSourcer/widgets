import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {DEFAULT_WIDGETS, WIDGETS, WIDGET_SIZES, GRID_SIZE, WIDGET_GAP, SMALL_WIDGET_SIZE, MEDIUM_WIDGET_WIDTH, supportedWidgetSize} from './catalog.js';

const LAYOUT_KEY = 'layout-json';

const MIN_WIDGET_WIDTH = 180;
const MIN_WIDGET_HEIGHT = 120;

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

export function cloneDefaultWidgets() {
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

export function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
};

export function snap(value) {
	return Math.round(value / GRID_SIZE) * GRID_SIZE;
};

export function firstDesktopGridRow() {
	return Math.ceil(((Main.panel?.height ?? 0) + WIDGET_GAP) / GRID_SIZE) * GRID_SIZE;
};

export function sizeForWidget(widget) {
	const [defaultWidth, defaultHeight] = WIDGET_SIZES[widget.size] ?? WIDGET_SIZES.small;

	return [
		Number.isFinite(widget.width) ? widget.width : defaultWidth,
		Number.isFinite(widget.height) ? widget.height : defaultHeight,
	];
};

export function rectForWidget(widget) {
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

export class DesktopLayout {
	constructor(settings) {
		this._settings = settings;
		this.widgets = [];
	};

	enable() {
		if (!this._settings.get_boolean('style-surface-default-migrated')) {
			this._settings.set_boolean('style-background-blur', false);
			this._settings.set_boolean('style-surface-default-migrated', true);
		};
		this.widgets = this._loadWidgets();
		this.save();
	};

	destroy() {
		this.widgets = [];
		this._settings = null;
	};

	reset() {
		this.widgets = cloneDefaultWidgets();
		this.save();
	};

	remove(id) {
		this.widgets = this.widgets.filter(widget => widget.id !== id);
		this.save();
	};

	_parseWidgets(serialized) {
		const parsed = JSON.parse(serialized);
		if (!Array.isArray(parsed.widgets)) {
			return cloneDefaultWidgets();
		};

		return parsed.widgets
			.filter(widget => widget.id && widget.type)
			.filter(widget => WIDGETS.has(widget.type))
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
		const serialized = this._settings.get_string(LAYOUT_KEY);

		return serialized ? this._parseWidgets(serialized) : cloneDefaultWidgets();
	};

	save() {
		this._settings.set_string(LAYOUT_KEY, JSON.stringify({widgets: this.widgets}));
	};

	add(type, requestedSize = null, dropPoint = null) {
		const widgetModule = WIDGETS.get(type);

		if (!widgetModule) return;

		const index = this.widgets.length;
		const supportedSizes = widgetModule.supportedSizes;
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
			const position = this.findOpenPosition(widget, this.widgets);
			widget.x = position.x;
			widget.y = position.y;
		};
		this.widgets.push(widget);

		this.save();
	};

	clampWidget(widget) {
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

	_positionIsFreeAgainst(widget, x, y, blockingWidgets) {
		const [width, height] = sizeForWidget(widget);
		const rect = {x, y, width, height};

		return !blockingWidgets.some(other => other !== widget && rectsOverlap(rect, rectForWidget(other)));
	};

	findOpenPosition(widget, blockingWidgets = []) {
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

	resolve(anchor = null, animate = false, save = false, onChanged = () => {}) {
		const orderedWidgets = anchor
			? [anchor, ...this.widgets.filter(widget => widget !== anchor)]
			: [...this.widgets];
		const settled = [];
		let changed = false;

		for (const widget of orderedWidgets) {
			const oldX = widget.x;
			const oldY = widget.y;
			const oldWidth = widget.width;
			const oldHeight = widget.height;

			this.clampWidget(widget);

			if (settled.some(other => rectsOverlap(rectForWidget(widget), rectForWidget(other)))) {
				const position = this.findOpenPosition(widget, settled);
				widget.x = position.x;
				widget.y = position.y;
				this.clampWidget(widget);
			};

			settled.push(widget);

			if (widget.x !== oldX || widget.y !== oldY || widget.width !== oldWidth || widget.height !== oldHeight) {
				changed = true;
				onChanged(widget, animate);
			};
		};

		if (changed && save) {
			this.save();
		};

		return changed;
	};
};
