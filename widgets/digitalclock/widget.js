import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import {surfaceStyle} from '../../utils/widget.js';

export const type = 'digitalclock';
export const label = 'Digital Clock';
export const stylesheet = 'widgets/digitalclock/stylesheet.css';
export const defaultSize = 'small';
export const appIds = ['org.gnome.clocks.desktop'];
export const supportedSizes = ['small', 'medium', 'large'];

const TICK_INSET = 3;
const TICK_LENGTH = 7;
const TICK_LINE_WIDTH = 2.5;

const HybridClockFace = GObject.registerClass(
    class HybridClockFace extends St.DrawingArea {
        _init(theme) {
            super._init({
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.FILL,
            });

            this._dark = theme?.dark ?? false;
            this._textColor = this._dark ? [1, 1, 1] : [0.12, 0.11, 0.16];

            this._repaintTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                if (!this.get_parent()) {
                    this._repaintTimeoutId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this.queue_repaint();
                return GLib.SOURCE_CONTINUE;
            });

            this.connect('destroy', this._onDestroy.bind(this));
        }

        _onDestroy() {
            if (this._repaintTimeoutId) {
                GLib.Source.remove(this._repaintTimeoutId);
                this._repaintTimeoutId = 0;
            }
        }

        vfunc_repaint() {
            const cr = this.get_context();
            const [width, height] = this.get_surface_size();

            if (width <= 0 || height <= 0) {
                cr.$dispose();
                return;
            }

            const seconds = new Date().getSeconds();
            const centerX = width / 2;
            const centerY = height / 2;
            const [r, g, b] = this._textColor;

            // Tidak ada fill background di sini; background dan border
            // sepenuhnya diatur oleh CSS dari style().
            const halfW = width / 2 - TICK_INSET;
            const halfH = height / 2 - TICK_INSET;

            cr.setLineCap(1);
            cr.setLineWidth(TICK_LINE_WIDTH);

            for (let tick = 0; tick < 60; tick++) {
                const angle = (tick / 60) * Math.PI * 2 - Math.PI / 2;
                const dx = Math.cos(angle);
                const dy = Math.sin(angle);

                // Titik di tepi kotak persegi panjang (bukan lingkaran)
                const scale = 1.0 / Math.max(Math.abs(dx), Math.abs(dy));
                const outerX = centerX + dx * halfW * scale;
                const outerY = centerY + dy * halfH * scale;
                const innerX = centerX + dx * (halfW * scale - TICK_LENGTH);
                const innerY = centerY + dy * (halfH * scale - TICK_LENGTH);

                cr.moveTo(innerX, innerY);
                cr.lineTo(outerX, outerY);

                const alpha = tick <= seconds ? 0.95 : 0.2;
                cr.setSourceRGBA(r, g, b, alpha);
                cr.stroke();
            }

            cr.$dispose();
        }
    }
);

export function style(theme) {
    return surfaceStyle(theme);
}

export function render({body, theme}) {
    const container = new St.Widget({
        x_expand: true,
        y_expand: true,
        clip_to_allocation: true,
        layout_manager: new Clutter.BinLayout(),
    });

    const clockFace = new HybridClockFace(theme);

    const timeLabel = new St.Label({
        style_class: 'hybrid-digital-time',
        style: `color: ${theme?.text ?? '#241f31'};`,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        y_expand: true,
    });

    // Fungsi untuk menyesuaikan ukuran font secara dinamis berdasarkan lebar/tinggi kotak
    const updateFontSize = () => {
        const [width, height] = container.get_transformed_size();
        if (width > 0 && height > 0) {
            // Skala proporsional (misalnya 35% dari dimensi terkecil kotak)
            const minDim = Math.min(width, height);
            const calculatedFontSize = Math.max(16, Math.floor(minDim * 0.32));
            
            // Terapkan langsung melalui inline style atau manipulasi style string
            timeLabel.set_style(`color: ${theme?.text ?? '#241f31'}; font-size: ${calculatedFontSize}px;`);
        }
    };

    // Pantau perubahan ukuran kontainer widget
    container.connect('notify::allocation', updateFontSize);

    const updateClockText = () => {
        const now = new Date();
        const hour = now.getHours().toString().padStart(2, '0');
        const minute = now.getMinutes().toString().padStart(2, '0');
        timeLabel.set_text(`${hour}:${minute}`);
        return GLib.SOURCE_CONTINUE;
    };

    updateClockText();
    const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, updateClockText);

    container.add_child(clockFace);
    container.add_child(timeLabel);
    body.add_child(container);

    container.connect('destroy', () => {
        if (timeoutId) {
            GLib.Source.remove(timeoutId);
        }
    });
}	];
};

function escapeMarkup(text) {
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
};

function roundedRectangle(cr, x, y, width, height, radius) {
	const r = Math.min(radius, width / 2, height / 2);

	cr.moveTo(x + r, y);
	cr.lineTo(x + width - r, y);
	cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
	cr.lineTo(x + width, y + height - r);
	cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
	cr.lineTo(x + r, y + height);
	cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
	cr.lineTo(x, y + r);
	cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
	cr.closePath();
};

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
			this.connectObject('destroy', this._onDestroy.bind(this), this);
			this.connectObject('notify::width', this._onSizeChange.bind(this), this);
			this.connectObject('notify::height', this._onSizeChange.bind(this), this);
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
			const delay = 1000 - (Date.now() % 1000);

			this._repaintTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
				this._repaintTimeoutId = 0;

				if (!this.get_parent()) return GLib.SOURCE_REMOVE;

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
			const heightRatio = this._sizeKey === 'medium' ? 0.50 : 0.38;
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
			const {width, inset, availWidth, availHeight, dpi, textColor} = opts;
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
			const inset = clamp(Math.round(minSide * 0.045), 3, 10);
			const dash = clamp(minSide * 4 / 180, 2.4, 12);
			const gap = dash * 1.5;
			const lineWidth = clamp(minSide * 3.5 / 180, 1.6, 5);
			const frameRadius = clamp(this._radius, 0, Math.floor(minSide / 2));
			const textColor = colorFromHex(this._theme.text, this._dark ? [1, 1, 1] : [0.1, 0.09, 0.16]);
			const tickColor = colorFromHex(this._theme.muted, this._dark ? [1, 1, 1] : [0.1, 0.09, 0.16]);

			roundedRectangle(cr, inset, inset, width - inset * 2, height - inset * 2, frameRadius);
			cr.setLineWidth(lineWidth);
			cr.setDash([dash, gap], 0);
			cr.setSourceRGBA(tickColor[0], tickColor[1], tickColor[2], this._dark ? 0.34 : 0.2);
			cr.stroke();
			cr.setDash([], 0);

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
	return surfaceStyle(theme);
};

function setting(settings, getter, key, fallback) {
	if (!settings) return fallback;

	try {
		return settings[getter](key);
	} catch (_error) {
		return fallback;
	};
};

export function render({body, theme, settings, widget, refresh}) {
	watchSettings(body, settings,
		['digitalclock-hour-format', 'digitalclock-show-seconds', 'digitalclock-show-ampm'], refresh);
	const sizeKey = String(widget?.size ?? defaultSize);
	const use24h = setting(settings, 'get_string', 'digitalclock-hour-format', '24') !== '12';
	const showSeconds = setting(settings, 'get_boolean', 'digitalclock-show-seconds', false) &&
		['medium', 'large', 'wide', 'huge'].includes(sizeKey);
	const showAmPm = setting(settings, 'get_boolean', 'digitalclock-show-ampm', true);
	const face = new DigitalClockFace({
		theme,
		use24h,
		showSeconds,
		showAmPm,
		radius: theme?.radius ?? CORNER_RADIUS,
		vertical: false,
		sizeKey,
	});

	body.add_child(face);
};
