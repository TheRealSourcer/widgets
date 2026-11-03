import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {surfaceStyle} from '../../utils/widget.js';
import {parseCssColor} from '../../utils/colors.js';
import {VERTICAL, HORIZONTAL, boxOrientation} from '../../compatibility.js';
import {readSystemMetrics, formatBytes} from './systemReader.js';

export const type = 'system';
export const label = 'System Monitor';
export const stylesheet = 'widgets/system/stylesheet.css';
export const defaultSize = 'small';
export const supportedSizes = ['small', 'medium'];

function usageColor(percentage, theme) {
	if (percentage >= 85) return [0.93, 0.21, 0.25]; // Red
	if (percentage >= 70) return [0.95, 0.68, 0.19]; // Amber
	if (theme?.accent) {
		const {r, g, b} = parseCssColor(theme.accent);
		return [r, g, b];
	};
	return [0.22, 0.74, 0.96]; // Default blue
};

const SystemRing = GObject.registerClass(
	class SystemRing extends St.DrawingArea {
		_init(percentage, theme) {
			super._init({style_class: 'widget-system-ring'});
			this._percentage = Number.isFinite(percentage) ? percentage : 0;
			this._ringColor = usageColor(this._percentage, theme);
			this._trackColor = theme?.dark ? [1, 1, 1, 0.16] : [0, 0, 0, 0.11];
		};

		update(percentage, theme) {
			this._percentage = Number.isFinite(percentage) ? percentage : 0;
			this._ringColor = usageColor(this._percentage, theme);
			this._trackColor = theme?.dark ? [1, 1, 1, 0.16] : [0, 0, 0, 0.11];
			this.queue_repaint();
		};

		vfunc_repaint() {
			const cr = this.get_context();
			const [width, height] = this.get_surface_size();

			if (width <= 0 || height <= 0) {
				cr.$dispose();
				return;
			};

			const lineWidth = Math.max(4, Math.round(Math.min(width, height) / 10));
			const radius = Math.min(width, height) / 2 - lineWidth / 2 - 2;
			const centerX = width / 2;
			const centerY = height / 2;

			cr.setLineCap(1);
			cr.setLineWidth(lineWidth);
			cr.arc(centerX, centerY, radius, 0, Math.PI * 2);
			cr.setSourceRGBA(...this._trackColor);
			cr.stroke();

			if (this._percentage > 0) {
				const startAngle = -Math.PI / 2;
				const endAngle = startAngle + (Math.PI * 2 * (Math.min(100, this._percentage) / 100));
				cr.arc(centerX, centerY, radius, startAngle, endAngle);
				cr.setSourceRGBA(...this._ringColor, 1);
				cr.stroke();
			};

			cr.$dispose();
		};
	}
);

const SystemBar = GObject.registerClass(
	class SystemBar extends St.DrawingArea {
		_init(percentage, theme) {
			super._init({style_class: 'widget-system-bar', height: 8, x_expand: true});
			this._percentage = Number.isFinite(percentage) ? percentage : 0;
			this._barColor = usageColor(this._percentage, theme);
			this._trackColor = theme?.dark ? [1, 1, 1, 0.16] : [0, 0, 0, 0.11];
		};

		update(percentage, theme) {
			this._percentage = Number.isFinite(percentage) ? percentage : 0;
			this._barColor = usageColor(this._percentage, theme);
			this._trackColor = theme?.dark ? [1, 1, 1, 0.16] : [0, 0, 0, 0.11];
			this.queue_repaint();
		};

		vfunc_repaint() {
			const cr = this.get_context();
			const [width, height] = this.get_surface_size();

			if (width <= 0 || height <= 0) {
				cr.$dispose();
				return;
			};

			const radius = height / 2;
			cr.setLineCap(1);
			cr.setLineWidth(height);
			cr.moveTo(radius, radius);
			cr.lineTo(Math.max(radius, width - radius), radius);
			cr.setSourceRGBA(...this._trackColor);
			cr.stroke();

			if (this._percentage > 0) {
				const fillWidth = Math.max(radius * 2, (width * Math.min(100, this._percentage)) / 100);
				cr.moveTo(radius, radius);
				cr.lineTo(Math.min(width - radius, fillWidth - radius), radius);
				cr.setSourceRGBA(...this._barColor, 1);
				cr.stroke();
			};

			cr.$dispose();
		};
	}
);

export const systemService = {
	timerId: 0,
	listeners: new Set(),
	state: null,
	updating: false,

	subscribe(callback) {
		this.listeners.add(callback);
		if (this.state) {
			callback(this.state);
		};
		if (this.listeners.size === 1) {
			this.start();
		};
		return () => {
			this.listeners.delete(callback);
			if (this.listeners.size === 0) {
				this.stop();
			};
		};
	},

	start() {
		this.stop();
		this.refresh();
		this.timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
			this.refresh();
			return GLib.SOURCE_CONTINUE;
		});
	},

	async refresh() {
		if (this.updating) return;
		this.updating = true;
		try {
			this.state = await readSystemMetrics(this.state);
			for (const callback of [...this.listeners]) {
				if (this.listeners.has(callback)) {
					callback(this.state);
				};
			};
		} catch (_err) {
			// silent fallback
		} finally {
			this.updating = false;
		};
	},

	stop() {
		if (this.timerId) {
			GLib.Source.remove(this.timerId);
			this.timerId = 0;
		};
		this.updating = false;
	},
};

export function cleanup() {
	systemService.stop();
	systemService.listeners.clear();
	systemService.state = null;
};

export function style(theme) {
	return surfaceStyle(theme);
};

function createGaugeSlot(title, percentage, theme, createLabel) {
	const slot = new St.BoxLayout({
		...VERTICAL,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style_class: 'widget-system-slot',
	});

	const gaugeBox = new St.Widget({
		layout_manager: new Clutter.BinLayout(),
		style_class: 'widget-system-gauge-container',
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
	});

	const ring = new SystemRing(percentage, theme);
	const percentLabel = createLabel(
		`${percentage}%`,
		'widget-system-percent',
		`color: ${theme.text}; text-align: center;`
	);
	percentLabel.set_x_align(Clutter.ActorAlign.CENTER);
	percentLabel.set_y_align(Clutter.ActorAlign.CENTER);

	gaugeBox.add_child(ring);
	gaugeBox.add_child(percentLabel);
	slot.add_child(gaugeBox);

	const titleLabel = createLabel(
		title,
		'widget-system-title',
		`color: ${theme.text}; text-align: center;`
	);
	titleLabel.set_x_align(Clutter.ActorAlign.CENTER);
	slot.add_child(titleLabel);

	return {
		actor: slot,
		update(newPercent, newTheme) {
			ring.update(newPercent, newTheme);
			percentLabel.text = `${newPercent}%`;
		},
	};
};

function createDetailBar(title, valueText, percentage, theme, createLabel) {
	const group = new St.BoxLayout({
		...VERTICAL,
		x_expand: true,
		style_class: 'widget-system-bar-group',
	});

	const header = new St.BoxLayout({
		...HORIZONTAL,
		x_expand: true,
		style_class: 'widget-system-bar-header',
	});

	const titleLabel = createLabel(title, 'widget-system-bar-name', `color: ${theme.text};`);
	const valLabel = createLabel(valueText, 'widget-system-bar-value', `color: ${theme.muted};`);
	valLabel.set_x_align(Clutter.ActorAlign.END);
	valLabel.set_x_expand(true);

	header.add_child(titleLabel);
	header.add_child(valLabel);
	group.add_child(header);

	const bar = new SystemBar(percentage, theme);
	group.add_child(bar);

	return {
		actor: group,
		update(newValText, newPercent, newTheme) {
			valLabel.text = newValText;
			bar.update(newPercent, newTheme);
		},
	};
};

export function render({body, widget, createLabel, theme}) {
	const isMedium = widget.size === 'medium';
	const tray = new St.BoxLayout({
		...HORIZONTAL,
		style_class: 'widget-system-tray',
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
	});

	const ringsContainer = new St.BoxLayout({
		...HORIZONTAL,
		style_class: 'widget-system-rings',
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
	});

	const cpuGauge = createGaugeSlot('CPU', 0, theme, createLabel);
	const ramGauge = createGaugeSlot('RAM', 0, theme, createLabel);

	ringsContainer.add_child(cpuGauge.actor);
	ringsContainer.add_child(ramGauge.actor);
	tray.add_child(ringsContainer);

	let memBar = null;
	let diskBar = null;

	if (isMedium) {
		const details = new St.BoxLayout({
			...VERTICAL,
			style_class: 'widget-system-details',
			x_expand: true,
			y_align: Clutter.ActorAlign.CENTER,
		});

		memBar = createDetailBar('Memory', '0 / 0 GB (0%)', 0, theme, createLabel);
		diskBar = createDetailBar('Disk (/)', '0 / 0 GB (0%)', 0, theme, createLabel);

		details.add_child(memBar.actor);
		details.add_child(diskBar.actor);
		tray.add_child(details);
	};

	body.add_child(tray);

	const updateMetrics = metrics => {
		if (!metrics) return;

		const cpuUsage = metrics.cpu?.usage ?? 0;
		const ramUsage = metrics.memory?.usage ?? 0;
		const diskUsage = metrics.disk?.usage ?? 0;

		cpuGauge.update(cpuUsage, theme);
		ramGauge.update(ramUsage, theme);

		if (isMedium) {
			const memUsed = formatBytes(metrics.memory?.usedBytes ?? 0);
			const memTotal = formatBytes(metrics.memory?.totalBytes ?? 0);
			memBar?.update(`${memUsed} / ${memTotal} (${ramUsage}%)`, ramUsage, theme);

			const diskUsed = formatBytes(metrics.disk?.usedBytes ?? 0);
			const diskTotal = formatBytes(metrics.disk?.totalBytes ?? 0);
			diskBar?.update(`${diskUsed} / ${diskTotal} (${diskUsage}%)`, diskUsage, theme);
		};
	};

	const unsubscribe = systemService.subscribe(updateMetrics);
	tray.connectObject('destroy', unsubscribe, tray);
};
