// Widget glass manager - integrates LiquidGlass with desktop widgets.
//
// The widget actor is a plain St widget on the widget layer: it draws the
// widget's own background and content. For every widget in Glass style we add
// a LiquidGlass actor as a sibling right below it, sized and positioned to the
// widget's stage rect. The widget itself becomes transparent (see
// _styleForWidget in extension.js), so the glass shows through.
//
// In Solid style the glass actor is detached and the widget keeps the normal
// opaque CSS background. This also keeps all custom background/border/shadow
// settings working exactly as before.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

import {LiquidGlass} from './glass.js';
import {macColors} from './colors.js';
import {parseCssColor} from '../utils/ported.js';

const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';
const HOVER_FADE_MS = 180;

export class WidgetGlass {
    /**
     * @param {object} options
     * @param {() => Gio.Settings} options.settings
     */
    constructor({settings, isDark = null}) {
        this._settings = settings;
        this._isDark = isDark;
        this._interfaceSettings = new Gio.Settings({schema_id: INTERFACE_SCHEMA});

        // Map: widget id -> record
        this._records = new Map();
    }

    sync(views) {
        const s = this._settings();
        const isGlass = s.get_int('style-mode') === 0;

        if (!isGlass) {
            this.destroy();
            return;
        }

        const viewsArray = Array.from(views);
        const live = new Set();

        for (const view of viewsArray) {
            if (!view?.actor || !view?.widget) {
                continue;
            }

            live.add(view.id);
            this._syncView(view);
        }

        for (const id of [...this._records.keys()]) {
            if (!live.has(id)) {
                this._detach(id);
            }
        }
    }

    destroy() {
        for (const id of [...this._records.keys()]) {
            this._detach(id);
        }
    }

    _syncView(view) {
        let record = this._records.get(view.id);

        // If actor changed, detach old and create new
        if (record && record.actor !== view.actor) {
            this._detach(view.id);
            record = null;
        }

        if (!record) {
            record = this._attach(view);
            if (!record) {
                return;
            }
            this._records.set(view.id, record);
        }

        this._updateGlassParams(record);
        this._updateGeometry(record);
    }

    _attach(view) {
        const {actor, widget} = view;
        const container = actor.get_parent();

        if (!container) {
            console.warn(`[desktop-widgets glass] Widget ${widget.type} has no parent container`);
            return null;
        }

        const glass = new LiquidGlass();

        // Keep the glass right below its widget, not at the bottom of the
        // layer: another widget may overlap this one.
        container.insert_child_at_index(glass, 0);
        if (container.set_child_below_sibling)
            container.set_child_below_sibling(glass, actor);

        // Force container to relayout so glass gets allocation
        container.queue_relayout();
        
        const record = {
            actor,
            widget,
            glass,
            container,
            signalIds: [],
            pointer: [-1, -1],
            hoverFade: 0,
            fadeFrom: 0,
            fadeTo: 0,
            timeline: null,
        };

        const updateGeometry = () => this._updateGeometry(record);
        const updateParams = () => this._updateGlassParams(record);

        record.signalIds.push(actor.connect('notify::x', updateGeometry));
        record.signalIds.push(actor.connect('notify::y', updateGeometry));
        record.signalIds.push(actor.connect('notify::width', updateGeometry));
        record.signalIds.push(actor.connect('notify::height', updateGeometry));
        record.signalIds.push(actor.connect('notify::opacity', updateParams));
        // allocation-changed doesn't exist on St widgets, use notify::allocation instead
        record.signalIds.push(actor.connect('notify::allocation', updateGeometry));

        // Specular highlight follows the pointer, like liquidglass-widgets.
        record.signalIds.push(actor.connect('motion-event', (_actor, event) => {
            const [sx, sy] = event.get_coords();
            const [ok, lx, ly] = actor.transform_stage_point(sx, sy);
            const [width, height] = actor.get_size();
            record.pointer = ok && width > 0 && height > 0
                ? [lx / width, ly / height]
                : [-1, -1];
            this._syncPointer(record);
            return Clutter.EVENT_PROPAGATE;
        }));
        record.signalIds.push(actor.connect('notify::hover', () => {
            this._animateHover(record, actor.hover ? 1 : 0);
        }));

        record.signalIds.push(actor.connect('destroy', () => {
            this._detach(view.id);
        }));

        // Try immediate update
        this._updateGeometry(record);
        this._updateGlassParams(record);

        // If actor doesn't have valid coordinates yet, schedule retry
        const [x, y] = actor.get_transformed_position();
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            // Wait for stage paint - most reliable way to ensure allocation
            const stage = actor.get_stage();
            if (stage) {
                const paintId = stage.connect('after-paint', () => {
                    this._updateGeometry(record);
                    this._updateGlassParams(record);
                    stage.disconnect(paintId);
                });
            }
        }

        return record;
    }

    _updateGeometry(record) {
        const {actor, glass} = record;

        const [width, height] = actor.get_size();
        if (width <= 0 || height <= 0)
            return;

        const [stageX, stageY] = actor.get_transformed_position();
        
        // Guard against NaN values when actor doesn't have allocation yet
        if (!Number.isFinite(stageX) || !Number.isFinite(stageY))
            return;

        const parent = glass.get_parent();

        if (parent) {
            const [parentX, parentY] = parent.get_transformed_position();
            if (!Number.isFinite(parentX) || !Number.isFinite(parentY))
                return;
            
            glass.set_position(Math.round(stageX - parentX), Math.round(stageY - parentY));

            // Keep the backdrop directly below its widget even after the
            // widget is raised (dragging, edit mode) or another widget moves.
            if (parent.set_child_below_sibling)
                parent.set_child_below_sibling(glass, actor);
        }

        const geomX = Math.round(stageX);
        const geomY = Math.round(stageY);
        const geomW = Math.round(width);
        const geomH = Math.round(height);

        glass.setGeometry(geomX, geomY, geomW, geomH);
        glass.opacity = actor.opacity;

        // Force glass to realize and allocate if it hasn't yet
        if (!glass.get_stage()) {
            glass.realize();
        }
        
        // Force allocation to ensure glass is visible
        const glassBox = new Clutter.ActorBox();
        glassBox.x1 = glass.x;
        glassBox.y1 = glass.y;
        glassBox.x2 = glass.x + geomW;
        glassBox.y2 = glass.y + geomH;
        glass.allocate(glassBox);
    }

    _updateGlassParams(record) {
        const {actor, glass, widget} = record;
        const s = this._settings();
        const systemIsDark = this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
        const dark = this._isDark
            ? this._isDark()
            : (s.get_int('appearance') === 0 ||
                (s.get_int('appearance') === 2 && systemIsDark));
        const colors = macColors(0, dark ? 0 : 1, systemIsDark);

        // The custom background colour doubles as the glass tint when set;
        // otherwise the palette's tint (white on light glass, black on dark).
        const background = s.get_string('style-background').trim();
        let tint = colors.glassTint;
        let tintAlpha = s.get_int('tint-alpha-pct') / 100;

        if (background && /^(#[0-9a-fA-F]{3,8}|rgba?\(.+\))$/.test(background)) {
            tint = parseCssColor(background);
            if (typeof tint.a === 'number')
                tintAlpha *= tint.a;
        }

        // Try to extract border-radius from the actor's style
        let radius = s.get_int('style-border-radius');
        
        // Get the actual border-radius from the actor's style if available
        if (actor.get_style) {
            const style = actor.get_style();
            if (style) {
                const radiusMatch = style.match(/border-radius:\s*(\d+(?:\.\d+)?)\s*px/);
                if (radiusMatch) {
                    radius = parseFloat(radiusMatch[1]);
                }
            }
        }

        glass.setParams({
            radius: radius,
            roundness: 6.1,  // Fixed squircle shape like liquidglass-widgets default
            refractThickness: s.get_int('refract-thickness'),
            refractIOR: s.get_int('refract-ior-x100') / 100,
            refractScale: s.get_int('refract-scale'),
            chromaStrength: s.get_int('chroma-strength-pct') / 100,
            tint,
            tintAlpha,
            specStrength: s.get_int('spec-strength-pct') / 100,
            blurRadius: s.get_int('blur-radius-px'),
            solid: false,
        });

        glass.opacity = actor.opacity;
    }

    _syncPointer(record) {
        if (record.hoverFade <= 0) {
            record.glass.setPointer(-1, -1, 0);
            return;
        }

        const [u, v] = record.pointer;
        record.glass.setPointer(u, v, record.hoverFade);
    }

    _animateHover(record, target) {
        if (!record.timeline) {
            record.timeline = new Clutter.Timeline({actor: record.glass, duration: HOVER_FADE_MS});
            record.timeline.connect('new-frame', () => {
                const t = record.timeline.get_progress();
                record.hoverFade = record.fadeFrom + (record.fadeTo - record.fadeFrom) * t;
                this._syncPointer(record);
            });
        }

        record.timeline.stop();
        record.fadeFrom = record.hoverFade;
        record.fadeTo = target;
        record.timeline.rewind();
        record.timeline.start();
    }

    _detach(id) {
        const record = this._records.get(id);
        if (!record)
            return;

        record.timeline?.stop();

        for (const signalId of record.signalIds) {
            try {
                record.actor.disconnect(signalId);
            } catch (e) {
                // Actor might be destroyed already
            }
        }

        if (record.glass) {
            record.glass.get_parent()?.remove_child(record.glass);
            record.glass.destroy();
        }

        this._records.delete(id);
    }
}
