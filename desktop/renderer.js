import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {clipRounded} from '../utils/roundedClip.js';
import {ease} from '../utils/animation.js';
import {VERTICAL} from '../compatibility.js';
import {warn} from '../logger.js';
import {WIDGETS, WIDGET_SIZES} from './catalog.js';
import {sizeForWidget} from './layout.js';
import {createBlurredSurface, raiseActor} from './surface.js';
import {DesktopEditor} from './editor.js';
import {DesktopAppLauncher} from './appLauncher.js';


export class DesktopRenderer {
	constructor(settings, layout, theme, workspaceIntegration, onRemove) {
		this._layoutSettings = settings;
		this._layout = layout;
		this._theme = theme;
		this._workspaceIntegration = workspaceIntegration;
		this._layer = null;
		this._views = new Map();
		this._editMode = false;
		this._editor = new DesktopEditor(this, layout, theme, onRemove);
		this._appLauncher = new DesktopAppLauncher(this);
	};

	enable() {
		this._createLayer();
		this.rebuild();
		this._appLauncher.enable();
		Main.layoutManager.connectObject('monitors-changed', () => this._syncLayerGeometry(), this);
	};

	destroy() {
		Main.layoutManager.disconnectObject(this);
		this._appLauncher.destroy();
		this._destroyLayer();
		this._editor.destroy();
		this._layoutSettings = null;
		this._layout = null;
		this._theme = null;
		this._workspaceIntegration = null;
	};

	get layer() {
		return this._layer;
	};

	get views() {
		return this._views;
	};

	get editMode() {
		return this._editMode;
	};

	setEditMode(enabled) {
		enabled = Boolean(enabled);
		if (enabled === this._editMode) return;

		this._editMode = enabled;
		this.rebuild();
	};

	resolveLayout(anchor = null, animate = false, save = false) {
		return this._layout.resolve(anchor, animate, save,
			(widget, shouldAnimate) => this.animateWidget(widget, shouldAnimate));
	};

	_clearViews() {
		this._editor.clearViews();
		this._views.clear();
	};

	_destroyLayer() {
		this._workspaceIntegration.setSource(null);
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
		this.resolveLayout(null, false, true);

		this._workspaceIntegration.queueSync();
	};

	createPreview(type, size, availableWidth, availableHeight) {
		const [width, height] = WIDGET_SIZES[size] ?? WIDGET_SIZES.small;
		const theme = {...this._theme.current(), blur: false};
		theme.background = theme.dark ? '#242424' : '#ffffff';
		const widget = {id: `preview-${type}-${size}`, type, size, width, height, data: {}};
		const surface = new St.BoxLayout({
			...VERTICAL,
			style_class: `widget widget-${type}`,
			style: this._theme.styleForWidget(widget, theme), width, height,
			clip_to_allocation: true,
		});
		try {
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
		} catch (error) {
			surface.destroy();
			throw error;
		};
	};

	rebuild() {
		if (!this._layer) return;

		this._editor.cancelDrag();
		const oldViews = [...this._views.values()];
		this._clearViews();

		for (const view of oldViews) view.actor.destroy();

		this.resolveLayout(null, false, true);

		for (const widget of this._layout.widgets) {
			this._createWidget(widget);
		};
	};

	_createWidget(widget) {
		const [width, height] = sizeForWidget(widget);
		const theme = this._theme.current();
		const surface = WIDGETS.get(widget.type)?.surface;
		const blurredSurface = theme.blur && surface?.blur !== false;
		const actorParams = {
			style_class: `widget widget-${widget.type}`,
			reactive: true,
			can_focus: true,
			track_hover: true,
		};
		const style = this._theme.styleForWidget(widget);
		actorParams.style = style;

		const actor = blurredSurface
			? new St.Widget({...actorParams, layout_manager: new Clutter.BinLayout(),
				style_class: `${actorParams.style_class} widget-blurred-surface`,
				style: `color: ${theme.text};`})
			: new St.BoxLayout({...actorParams, ...VERTICAL});
		this._layer.add_child(actor);
		actor.set_clip_to_allocation(true);
		actor.set_size(width, height);
		clipRounded(actor, theme.radius);

		if (blurredSurface) {
			try {
				const blurredBackground = createBlurredSurface(actor);
				actor.add_child(blurredBackground);
				clipRounded(blurredBackground, theme.radius, 1);
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

		const view = {
			widget,
			actor,
			body,
			editBorder: null,
			removeButton: null,
		};
		this._views.set(widget.id, view);

		if (this._editMode) {
			this._editor.makeDraggable(view);
			this._editor.addControls(view);
		};

		this._renderWidget(widget, body, this._theme.current(), this._editMode);
	};


	_renderWidget(widget, host, theme, editMode, interactive = true) {
		host.destroy_all_children();
		const widgetModule = WIDGETS.get(widget.type);

		if (!widgetModule?.render) {
			host.set_child(this._label('Unknown widget', 'widget-text'));
			return;
		};

		let body = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true,
			x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL});
		host.set_child(body);
		body.connectObject('destroy', () => { body = null; }, body);
		host.connectObject('destroy', () => { body = null; }, body);
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
				const parent = body?.get_parent();
				if (!parent) return;

				this._renderWidget(widget, parent, theme, editMode, interactive);
			},
		});
		if (!interactive && body) {
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

	animateWidget(widget, animate) {
		const view = this._views.get(widget.id);

		if (!view) return;

		if (!animate) {
			view.actor.set_position(widget.x, widget.y);
			view.actor.set_size(widget.width, widget.height);
			this._editor.syncControls(widget);
			return;
		};

		ease(view.actor, {
			x: widget.x,
			y: widget.y,
			width: widget.width,
			height: widget.height,
			duration: 130,
			mode: Clutter.AnimationMode.EASE_OUT_QUAD,
		});

		this._editor.syncControls(widget, true);
	};
};
