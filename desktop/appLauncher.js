import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WIDGET_APP_IDS} from './catalog.js';

export class DesktopAppLauncher {
	constructor(renderer) {
		this._renderer = renderer;
		this._lastAppLaunchAt = 0;
	};

	enable() {
		global.stage.connectObject('captured-event', (_stage, event) => this._handleAppClickEvent(event), this);
	};

	destroy() {
		global.stage.disconnectObject(this);
		this._renderer = null;
	};

	_openWidgetApp(type) {
		const appSystem = Shell.AppSystem.get_default();
		for (const appId of WIDGET_APP_IDS[type] ?? []) {
			const app = appSystem.lookup_app(appId);
			if (app) {
				app.activate();
				return;
			};
		};
	};

	_actorIsDescendantOf(actor, ancestor) {
		for (let current = actor; current; current = current.get_parent()) {
			if (current === ancestor) {
				return true;
			};
		};

		return false;
	};

	_viewForPickedActor(actor) {
		if (!actor) {
			return null;
		};

		for (const view of this._renderer.views.values()) {
			if (!WIDGET_APP_IDS[view.widget.type]) {
				continue;
			};

			if (this._actorIsDescendantOf(actor, view.actor)) {
				for (let current = actor; current && current !== view.actor; current = current.get_parent()) {
					if (current instanceof St.Button) {
						return null;
					};
				};
				return view;
			};
		};

		return null;
	};

	_viewForStagePoint(stageX, stageY) {
		for (const view of this._renderer.views.values()) {
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

		return this._actorIsDescendantOf(actor, this._renderer.layer) || this._actorIsDescendantOf(actor, backgroundGroup);
	};

	_handleAppClickEvent(event) {
		if (this._renderer.editMode || event.type() !== Clutter.EventType.BUTTON_RELEASE) {
			return Clutter.EVENT_PROPAGATE;
		};

		if ((event.get_button() ?? 1) !== 1) {
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
};
