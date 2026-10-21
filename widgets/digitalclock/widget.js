import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { perimeterTicks } from '../../lib/squircle.js';

export const type = 'digitalclock';
export const label = 'Digital Clock';
export const stylesheet = 'widgets/digitalclock/stylesheet.css';
export const appIds = ['org.gnome.clocks'];
export const defaultSize = 'small';
export const supportedSizes = ['small', 'medium', 'mini', 'minismall', 'portrait', 'portraitmini'];

const CORNER_RADIUS = 16;
// Port of liquidglass clock-digital: how long the comet trail behind the
// current-second tick is, in degrees of the 60-tick ring.
const TRAIL_DEGREES = 270;
// Squircle exponent matching our glass shader (exact circular arcs).
const TICK_ROUNDNESS = 2.0;

function pad(value) {
	return String(value).padStart(2, '0');
};

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
};

function colorFromHex(hex, fallback) {
	const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));

	if (!match) {
		return fallback;
	};

	const value = Number.parseInt(match[1], 16);

	return [
		((value >> 16) & 0xff) / 255,
		((value >> 8) & 0xff) / 255,
		(value & 0xff) / 255,
	];
};

function escapeMarkup(text) {
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
};

// Port of liquidglass clock-digital's tick ring: 60 ticks that follow the
// widget's silhouette, the current second lights up (smooth, every frame)
// and a comet trail fades out behind it over 270 degrees.
const DigitalClockRing = GObject.registerClass(
	class DigitalClockRing extends St.DrawingArea {
		_init(options) {
			super._init({
				x_expand: true,
				y_expand: true,
				x_align: Clutter.ActorAlign.FILL,
				y_align: Clutter.ActorAlign.FILL,
			});

			this._theme = options?.theme ?? {};
			this._radius = options?.radius ?? CORNER_RADIUS;
			this._dark = this._theme.dark ?? false;
			// Smooth (default) repaints every frame; stepped pins the head to
			// whole seconds and repaints once per second — the reference
			// clock-digital's off state for its smooth-seconds toggle.
			this._smooth = options?.smoothSeconds ?? true;

			this._ticks = null;
			this._tickSize = null;

			// Smooth seconds — repaint every frame while mapped. Clutter's
			// map/unmap are vfuncs, not signals — track notify::mapped.
			this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
			this._timeline.connect('new-frame', () => this.queue_repaint());
			this._tickSourceId = 0;

			this._syncTicker = () => {
				if (this._timeline)
					this._timeline.stop();
				if (this._tickSourceId) {
					GLib.Source.remove(this._tickSourceId);
					this._tickSourceId = 0;
				}
				if (!this.mapped)
					return;
				if (this._smooth) {
					this._timeline.start();
				} else {
					// Repaint at the next second boundary, then once a second.
					this._tickSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000 - (Date.now() % 1000) + 1, () => {
						this._tickSourceId = 0;
						this.queue_repaint();
						this._syncTicker();
						return GLib.SOURCE_REMOVE;
					});
				}
			};

			this.connect('notify::mapped', () => {
				if (!this._timeline)
					return;
				this._syncTicker();
			});
			this.connect('destroy', () => {
				this._timeline?.stop();
				this._timeline = null;
				if (this._tickSourceId) {
					GLib.Source.remove(this._tickSourceId);
					this._tickSourceId = 0;
				}
			});
			this.connect('notify::width', () => {
				this._ticks = null;
				this.queue_repaint();
			});
			this.connect('notify::height', () => {
				this._ticks = null;
				this.queue_repaint();
			});
		};

		vfunc_repaint() {
			const cr = this.get_context();
			const [width, height] = this.get_surface_size();

			if (width <= 0 || height <= 0) {
				cr.$dispose();
				return;
			};

			const minSide = Math.min(width, height);
			if (!this._ticks || this._tickSize?.w !== width || this._tickSize?.h !== height) {
				this._ticks = perimeterTicks(width, height, this._radius, TICK_ROUNDNESS);
				this._tickSize = {w: width, h: height};
			};

			const tickColor = colorFromHex(this._theme.muted, this._dark ? [1, 1, 1] : [0.1, 0.09, 0.16]);
			const base = 0.26;

			const ms = Date.now() % 60000;
			// Smooth: fractional second (every frame); stepped: whole seconds.
			const pos = this._smooth ? ms / 1000 : Math.floor(ms / 1000);
			const current = Math.floor(pos) % 60;
			const previous = (current + 59) % 60;
			const frac = pos - Math.floor(pos);
			const headFade = frac * frac * (3 - 2 * frac);

			// cairo_line_cap_t: BUTT=0, ROUND=1
			cr.setLineCap(1);

			const baseWidth = Math.max(1.2, Math.min(2.2, minSide * 0.012));

			this._ticks.forEach((tick, i) => {
				let lit = 0;
				if (i === current) {
					lit = headFade;
				} else {
					const behind = ((previous - i) * 6 + 360) % 360;
					if (behind <= TRAIL_DEGREES)
						lit = (1 - behind / TRAIL_DEGREES) ** 0.6;
				}

				cr.setLineWidth(baseWidth * (lit > 0 ? 1.4 : 1));
				cr.setSourceRGBA(tickColor[0], tickColor[1], tickColor[2], base + (1 - base) * lit);
				cr.moveTo(tick.inner.x, tick.inner.y);
				cr.lineTo(tick.outer.x, tick.outer.y);
				cr.stroke();
			});

			cr.setLineCap(0);
			cr.$dispose();
		};
	}
);

const DigitalClockFace = GObject.registerClass(
	class DigitalClockFace extends St.DrawingArea {
		_init(options) {
			super._init({
				x_expand: true,
				y_expand: true,
				x_align: Clutter.ActorAlign.FILL,
				y_align: Clutter.ActorAlign.FILL,
			});

			this._theme = options?.theme ?? {};
			this._use24h = options?.use24h ?? true;
			this._showSeconds = options?.showSeconds ?? false;
			this._showAmPm = options?.showAmPm ?? true;
			this._radius = options?.radius ?? CORNER_RADIUS;
			this._vertical = options?.vertical ?? false;
			this._sizeKey = options?.sizeKey ?? 'small';
			this._dark = this._theme.dark ?? false;

			this._scheduleRepaint();
			this.connect('destroy', this._onDestroy.bind(this));
			this.connect('notify::width', this._onSizeChange.bind(this));
			this.connect('notify::height', this._onSizeChange.bind(this));
		};

		_onSizeChange() {
			this.queue_repaint();
		};

		_onDestroy() {
			if (this._repaintTimeoutId) {
				GLib.Source.remove(this._repaintTimeoutId);
				this._repaintTimeoutId = 0;
			};
		};

		_scheduleRepaint() {
			// Adaptive interval: update once per minute when seconds are hidden
			const showSeconds = this._showSeconds;
			let delay;
			
			if (showSeconds) {
				// With seconds shown: update every second
				delay = 1000 - (Date.now() % 1000);
			} else {
				// Without seconds: update once per minute
				const now = Date.now();
				const msInMinute = 60000;
				delay = msInMinute - (now % msInMinute);
			}

			this._repaintTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
				this._repaintTimeoutId = 0;

				if (!this.get_parent()) {
					return GLib.SOURCE_REMOVE;
				};

				this.queue_repaint();
				this._scheduleRepaint();
				return GLib.SOURCE_REMOVE;
			});

			GLib.Source.set_name_by_id(this._repaintTimeoutId, '[widgets] digital clock repaint');
		};

		_buildTimeParts(now) {
			const hours = now.getHours();
			const minutes = now.getMinutes();
			const seconds = now.getSeconds();
			let hourStr;
			let suffix = null;

			if (this._use24h) {
				hourStr = pad(hours);
			} else {
				hourStr = String(hours % 12 || 12);
			};

			if (!this._use24h && this._showAmPm) {
				suffix = hours < 12 ? _('AM') : _('PM');
			};

			return {
				hours: hourStr,
				minutes: pad(minutes),
				seconds: pad(seconds),
				suffix,
			};
		};

	_drawHorizontal(cr, parts, opts) {
			const {width, height, inset, availWidth, availHeight, dpi, textColor} = opts;
			const main = this._showSeconds
				? `${parts.hours}:${parts.minutes}:${parts.seconds}`
				: `${parts.hours}:${parts.minutes}`;
			const digits = main.length;
			const units = digits * 0.62 + (parts.suffix ? parts.suffix.length * 0.62 : 0);
			const heightRatio = this._sizeKey === 'medium' || this._sizeKey === 'mini' ? 0.50 : 0.38;
			const fontSize = clamp(
				Math.floor(Math.min(availWidth / Math.max(1, units), availHeight * heightRatio)),
				12,
				160);
			const suffixSize = Math.max(8, fontSize);
			let markup = `<span font_family="Sans" font_weight="bold" size="${(fontSize * 72 / dpi).toFixed(1)}pt">${escapeMarkup(main)}</span>`;

			if (parts.suffix) {
				markup += `<span font_family="Sans" font_weight="bold" size="${(suffixSize * 72 / dpi).toFixed(1)}pt"> ${escapeMarkup(parts.suffix)}</span>`;
			};

			const layout = PangoCairo.create_layout(cr);
			layout.set_markup(markup, -1);
			const [ink] = layout.get_pixel_extents();
			const textX = Math.floor((width - ink.width) / 2) - ink.x;
			const textY = Math.max(inset, Math.floor((height - ink.height) / 2) - ink.y);

			cr.setSourceRGBA(textColor[0], textColor[1], textColor[2], 1);
			cr.moveTo(textX, textY);
			PangoCairo.show_layout(cr, layout);
		};

		_drawVertical(cr, parts, opts) {
			const {width, height, inset, availWidth, availHeight, dpi, textColor} = opts;
			const rowTexts = [parts.hours, parts.minutes];

			if (this._showSeconds) {
				rowTexts.push(parts.seconds);
			};

			if (parts.suffix) {
				rowTexts.push(parts.suffix);
			};

			const maxChars = Math.max(...rowTexts.map(text => text.length), 1);
			const fontSize = clamp(
				Math.floor(Math.min(availWidth / (maxChars * 0.62), availHeight / rowTexts.length * 0.8)),
				12,
				160);
			const rowHeight = availHeight / rowTexts.length;
			const size = (fontSize * 72 / dpi).toFixed(1);

			rowTexts.forEach((text, index) => {
				const markup = `<span font_family="Sans" font_weight="bold" size="${size}pt">${escapeMarkup(text)}</span>`;
				const layout = PangoCairo.create_layout(cr);
				layout.set_markup(markup, -1);
				const [ink] = layout.get_pixel_extents();
				const textX = Math.floor((width - ink.width) / 2) - ink.x;
				const textY = Math.floor(inset + index * rowHeight + (rowHeight - ink.height) / 2) - ink.y;

				cr.setSourceRGBA(textColor[0], textColor[1], textColor[2], 1);
				cr.moveTo(textX, textY);
				PangoCairo.show_layout(cr, layout);
			});
		};

		vfunc_repaint() {
			const cr = this.get_context();
			const [width, height] = this.get_surface_size();

			if (width <= 0 || height <= 0) {
				cr.$dispose();
				return;
			};

			const now = new Date();
			const parts = this._buildTimeParts(now);
			const minSide = Math.min(width, height);
			// Ticks closer to the widget edges get a thinner stroke inset.
			const inset = clamp(Math.round(minSide * 0.02), 2, 6);
			const textColor = colorFromHex(this._theme.text, this._dark ? [1, 1, 1] : [0.1, 0.09, 0.16]);

			const availWidth = Math.max(10, width - inset * 2 - 6);
			const availHeight = Math.max(10, height - inset * 2);
			const dpi = PangoCairo.font_map_get_default()?.get_resolution() || 96;
			const opts = {
				width,
				height,
				inset,
				availWidth,
				availHeight,
				dpi,
				textColor,
			};

			if (this._vertical) {
				this._drawVertical(cr, parts, opts);
			} else {
				this._drawHorizontal(cr, parts, opts);
			};

			cr.$dispose();
		};
	}
);

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border}; border-radius: ${theme?.radius ?? CORNER_RADIUS}px; padding: 10px;`;
};

export function render({body, theme, settings, widget}) {
	const use24h = settings?.get_string('digitalclock-hour-format') !== '12';
	const sizeKey = String(widget?.size ?? 'small');
	const vertical = sizeKey === 'portrait' || sizeKey === 'portraitmini';
	const showSeconds = settings?.get_boolean('digitalclock-show-seconds') === true &&
		(sizeKey === 'medium' || sizeKey === 'mini' || vertical);
	const showAmPm = settings?.get_boolean('digitalclock-show-ampm') !== false;
	const smoothSeconds = settings?.get_boolean('digitalclock-smooth-seconds') !== false;

	// The tick ring and the digits overlap: a plain St.Widget with a
	// BinLayout stacks both children in the same box (a vertical BoxLayout
	// would hand each of them its own row, like the glass bug).
	const stage = new St.Widget({
		layout_manager: new Clutter.BinLayout(),
		x_expand: true,
		y_expand: true,
	});
	const ring = new DigitalClockRing({theme, radius: theme.radius, smoothSeconds});
	const face = new DigitalClockFace({theme, use24h, showSeconds, showAmPm, radius: theme.radius, vertical, sizeKey});

	stage.add_child(ring);   // below the digits
	stage.add_child(face);   // digits on top

	body.add_child(stage);
};