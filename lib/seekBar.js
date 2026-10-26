// Port of the SeekBar from liquidglass-widgets (widgets/music.js): a reactive
// drawing area that paints the seek bar and its time labels, animates its
// thickness on hover (3 -> 8 px, ease-out-cubic), and lets the user drag to
// seek with a stage grab. Positions are in microseconds, like MPRIS.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

// Register once: GType registrations persist for the whole shell process, so a
// re-import after disable/enable must reuse the existing class, and the
// explicit GTypeName avoids a collision with liquidglass-widgets.
const SEEK_BAR_KEY = 'DesktopWidgets_SeekBar_class';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function formatTime(us) {
    const total = Math.floor(Math.max(0, us) / 1e6);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

// Real pixel line height of the painted time markup. The markup `size=` is in
// POINTS (1/1024 pt), which renders ~1.33× larger in pixels at 96dpi — any
// fixed 1.25× guess undersizes the widget and the drawing surface then shaves
// the digits' bottoms. Probed once against the same font map/resolution the
// shell paints with.
function measureTimeHeight(fontSize) {
    try {
        const context = PangoCairo.FontMap.get_default().create_context();
        const layout = Pango.Layout.new(context);
        layout.set_markup(`<span font_family="Sans" weight="medium" size="${Math.round(fontSize * 1024)}">0:00</span>`, -1);
        const [, logical] = layout.get_pixel_extents();
        if (logical && logical.height > 0)
            return logical.height;
    } catch (e) {}
    return Math.ceil(fontSize * 1.6);
}

export const SeekBar = (globalThis[SEEK_BAR_KEY] ??= GObject.registerClass({
    GTypeName: 'DesktopWidgets_SeekBar',
    Properties: {
        'thickness': GObject.ParamSpec.double('thickness', null, null,
            GObject.ParamFlags.READWRITE, 0, 100, 3),
    },
}, class SeekBar extends St.DrawingArea {
    /**
     * @param {object} opts
     * @param {[number, number, number]|null} opts.accent RGB 0..1 fill color
     * @param {[number, number, number]|null} opts.fg     RGB 0..1 bar/text color
     * @param {number} [opts.fontSize]
     * @param {number} [opts.trackAlpha]  rgba alpha of the idle track (default 0.2)
     * @param {number} [opts.disabledOpacity] actor opacity while not seekable (default 90)
     * @param {function(number): void} [opts.onSeek] called on release with a 0..1 fraction
     */
    _init({accent = null, fg = null, fontSize = 10, trackAlpha = 0.2, disabledOpacity = 90, onSeek = null} = {}) {
        super._init({reactive: true, track_hover: true, can_focus: false});
        this._thickness = 3;
        this._dragging = false;
        this._dragPos = 0;   // µs while dragging
        this._position = 0;  // current playback position (µs)
        this._length = 0;    // track length (µs)
        this._enabled = true;
        this._trackAlpha = trackAlpha;
        this._disabledOpacity = disabledOpacity;
        this.fontSize = fontSize;
        this._timePixelH = measureTimeHeight(fontSize);
        this._accent = accent ?? [0.35, 0.55, 1];
        this._fg = fg ?? [1, 1, 1];
        this._onSeek = onSeek;
        this.connect('repaint', () => {
            const cr = this.get_context();
            this._paint(cr);
            cr.$dispose();
        });
        this.connect('notify::hover', () => this._syncThickness());
        this.connect('destroy', () => this._endDrag());
        this.connect('notify::width', () => this.queue_repaint());
        this.connect('notify::height', () => this.queue_repaint());
    }

    get thickness() {
        return this._thickness;
    }

    // Real pixel height of the time labels painted below the bar; callers
    // size the widget from this so the digits never run past the surface.
    get timeLabelHeight() {
        return this._timePixelH;
    }

    set thickness(v) {
        this._thickness = v;
        this.notify('thickness');
        this.queue_repaint();
    }

    // Playback state; queue a repaint so the bar follows every tick.
    setPosition(us) {
        const v = Math.max(0, Number(us) || 0);
        if (v !== this._position) {
            this._position = v;
            if (!this._dragging)
                this.queue_repaint();
        }
    }

    setLength(us) {
        const v = Math.max(0, Number(us) || 0);
        if (v !== this._length) {
            this._length = v;
            this.queue_repaint();
        }
    }

    // Dim/hide the bar when the player cannot seek.
    setEnabled(enabled) {
        this._enabled = Boolean(enabled);
        this.opacity = this._enabled ? 255 : this._disabledOpacity;
        this.queue_repaint();
    }

    _syncThickness() {
        this.ease_property('thickness', this.hover || this._dragging ? 8 : 3, {
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _ratioAt(event) {
        const [ok, x] = this.transform_stage_point(...event.get_coords());
        return ok ? clamp(x / Math.max(1, this.width), 0, 1) : 0;
    }

    vfunc_button_press_event(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY ||
            !this._enabled || !(this._length > 0))
            return Clutter.EVENT_PROPAGATE;
        this._grab = global.stage.grab(this);
        this._dragging = true;
        this._dragPos = this._ratioAt(event) * this._length;
        this._syncThickness();
        this.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;
        this._dragPos = this._ratioAt(event) * this._length;
        this.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._dragging || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._endDrag();
        this._onSeek?.(Math.floor(this._dragPos) / Math.max(1, this._length));
        this._syncThickness();
        this.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        this._grab?.dismiss();
        this._grab = null;
        this._dragging = false;
    }

    _drawTime(cr, text, x, y, align) {
        const layout = PangoCairo.create_layout(cr);
        const markup = `<span font_family="Sans" weight="medium" size="${Math.round(this.fontSize * 1024)}">${text}</span>`;
        layout.set_markup(markup, -1);
        layout.set_alignment(align === 1 ? Pango.Alignment.RIGHT : Pango.Alignment.LEFT);
        const [ink] = layout.get_pixel_extents();
        cr.moveTo(align === 1 ? x - ink.width : x, y);
        PangoCairo.show_layout(cr, layout);
    }

    _paint(cr) {
        const [w, surfaceH] = this.get_surface_size();
        const t = this._thickness;
        const barY = 7 - t / 2;
        const length = this._length;
        const position = this._dragging ? this._dragPos : this._position;

        // Track
        cr.setSourceRGBA(this._fg[0], this._fg[1], this._fg[2], this._trackAlpha);
        roundedRect(cr, 0, barY, Math.max(t, w), t, t / 2);
        cr.fill();

        // Fill
        if (length > 0) {
            cr.setSourceRGBA(this._accent[0], this._accent[1], this._accent[2], 1);
            roundedRect(cr, 0, barY, Math.max(t, w * clamp(position / length, 0, 1)), t, t / 2);
            cr.fill();
        }

        // Times: 16px below the bar top when the surface is tall enough,
        // otherwise anchored flush to the bottom — a cairo surface clips at
        // its own bounds, so an undersized allocation must not shave glyphs.
        const timeY = Math.min(16, Math.max(0, surfaceH - this._timePixelH));
        cr.setSourceRGBA(this._fg[0], this._fg[1], this._fg[2], 0.5);
        this._drawTime(cr, formatTime(position), 0, timeY, 0);
        this._drawTime(cr, formatTime(length), w, timeY, 1);
    }
}));
