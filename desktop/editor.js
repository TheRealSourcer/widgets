import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WIDGET_GAP} from './catalog.js';
import {clamp, snap, firstDesktopGridRow, sizeForWidget, rectForWidget} from './layout.js';
import {raiseActor} from './surface.js';
import {ease} from '../utils/animation.js';


const REMOVE_BUTTON_SIZE = 32;
const REMOVE_BUTTON_INSET = 12;

export class DesktopEditor {
	constructor(renderer, layout, theme, onRemove) {
		this._renderer = renderer;
		this._layout = layout;
		this._theme = theme;
		this._onRemove = onRemove;
		this._controls = new Set();
	};

	destroy() {
		this.clearViews();
		this._renderer = null;
		this._layout = null;
		this._theme = null;
		this._onRemove = null;
	};

	clearViews() {
		this.cancelDrag();
		for (const view of this._renderer.views.values()) view.actor.disconnectObject(this);
		for (const actor of this._controls) actor.destroy();
		this._controls.clear();
	};

	_removeButtonPosition(widget) {
		const [width] = sizeForWidget(widget);

		return {
			x: widget.x + width - REMOVE_BUTTON_SIZE - REMOVE_BUTTON_INSET,
			y: widget.y + REMOVE_BUTTON_INSET,
		};
	};

	syncControls(widget, animate = false) {
		const view = this._renderer.views.get(widget.id);

		if (!view || !view.editBorder) return;

		const overlay = rectForWidget(widget);
		const button = this._removeButtonPosition(widget);

		if (animate) {
			ease(view.editBorder, {
				x: overlay.x,
				y: overlay.y,
				width: overlay.width,
				height: overlay.height,
				duration: 130,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			});

			ease(view.removeButton, {
				x: button.x,
				y: button.y,
				duration: 130,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			});
		} else {
			view.editBorder.set_position(overlay.x, overlay.y);
			view.editBorder.set_size(overlay.width, overlay.height);
			view.removeButton.set_position(button.x, button.y);
		};

		raiseActor(view.editBorder);
		raiseActor(view.removeButton);
	};

	addControls(view) {
		const theme = this._theme.current();
		const editBorder = new St.Widget({
			style_class: 'widget-edit-border',
			style: `border-color: ${theme.accent}; border-radius: ${theme.radius}px;`,
			reactive: false,
		});

		this._controls.add(editBorder);
		this._renderer.layer.add_child(editBorder);
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

		this._controls.add(removeButton);
		this._renderer.layer.add_child(removeButton);

		removeButton.connectObject('clicked', () => this._onRemove(view.widget.id), this);

		view.editBorder = editBorder;
		view.removeButton = removeButton;
		this.syncControls(view.widget);
	};

	makeDraggable(view) {
		const {actor, widget} = view;
		let drag = null;

		const finishDrag = () => {
			if (!drag) return;

			drag = null;
			this._layout.clampWidget(widget);
			this._renderer.resolveLayout(widget, true, false);
			this._renderer.animateWidget(widget, true);
			this.cancelDrag();
			this._layout.save();
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
			this.syncControls(widget);
			this._renderer.resolveLayout(widget, false, false);
		};

		actor.connectObject('captured-event', (_source, event) => {
			if (event.type() !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== 1) {
				return Clutter.EVENT_PROPAGATE;
			};

			if (!this._renderer.editMode) {
				return Clutter.EVENT_PROPAGATE;
			};

			this.cancelDrag();

			const [stageX, stageY] = event.get_coords();
			drag = {
				stageX,
				stageY,
				actorX: widget.x,
				actorY: widget.y,
			};

			raiseActor(actor);
			this.syncControls(widget);

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
			}, this);

			return Clutter.EVENT_STOP;
		}, this);
	};

	cancelDrag() {
		global.stage.disconnectObject(this);
	};
};
