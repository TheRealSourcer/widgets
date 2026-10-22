import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class GalleryDrag {
	constructor(owner) {
		this._owner = owner;
		this._drag = null;
		this.suppressClick = false;
	};

	get pending() {
		return this._drag !== null;
	};

	begin(source, record, event, size) {
		if (event.get_button() !== 1 || this._drag) {
			return Clutter.EVENT_PROPAGATE;
		};

		const [startX, startY] = event.get_coords();
		this.suppressClick = false;
		this._drag = {source, record, size, startX, startY, active: false, ghost: null};
		const handleDragEvent = (_stage, capturedEvent) => {
			if (!this._drag || this._drag.source !== source) {
				return Clutter.EVENT_PROPAGATE;
			};

			const type = capturedEvent.type();
			if (type === Clutter.EventType.KEY_RELEASE &&
          [Clutter.KEY_Super_L, Clutter.KEY_Super_R].includes(capturedEvent.get_key_symbol())) {
				return Clutter.EVENT_STOP;
			};
			if (type === Clutter.EventType.KEY_PRESS) {
				const key = capturedEvent.get_key_symbol();
				if (key === Clutter.KEY_Escape) {
					this.finish();
					return Clutter.EVENT_STOP;
				};
				if (key === Clutter.KEY_Super_L || key === Clutter.KEY_Super_R) {
					Main.overview.toggle();
					return Clutter.EVENT_STOP;
				};
			};
			if (type !== Clutter.EventType.MOTION && type !== Clutter.EventType.BUTTON_RELEASE) {
				return Clutter.EVENT_PROPAGATE;
			};
			const [stageX, stageY] = capturedEvent.get_coords();
			if (type === Clutter.EventType.MOTION) {
				if (!this._drag.active && Math.hypot(stageX - startX, stageY - startY) >= 8) {
					this._drag.active = true;
					this.suppressClick = true;
					this._drag.ghost = new St.BoxLayout({
						style_class: 'widget-gallery-drag-ghost',
						reactive: true,
					});
					this._drag.ghost.add_child(new St.Icon({icon_name: record.iconName, icon_size: 24}));
					this._drag.ghost.add_child(new St.Label({text: record.label, y_align: Clutter.ActorAlign.CENTER}));
					Main.uiGroup.add_child(this._drag.ghost);
					this._drag.ghost.connectObject('event', handleDragEvent, this._drag.ghost);
					global.stage.disconnectObject(this);
					this._drag.grab = global.stage.grab(this._drag.ghost);
					this._owner.close(true);
					this._owner.hideLauncher();
				};
				if (this._drag.active) {
					this._drag.ghost?.set_position(Math.round(stageX + 12), Math.round(stageY + 12));
				};
				return this._drag.active ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
			};

			if (type === Clutter.EventType.BUTTON_RELEASE) {
				const active = this._drag.active;
				this.finish();
				if (active) {
					this._owner.onDrop(record.type, size, stageX, stageY);
					return Clutter.EVENT_STOP;
				};
			};
			return Clutter.EVENT_PROPAGATE;
		};
		global.stage.connectObject('captured-event', handleDragEvent, this);
		return Clutter.EVENT_PROPAGATE;
	};

	finish() {
		global.stage.disconnectObject(this);
		const drag = this._drag;
    this._drag = null;

    if (!drag) return;
		drag.grab?.dismiss();
		drag.ghost?.destroy();
		drag.source = null;
		drag.record = null;
		drag.grab = null;
		drag.ghost = null;
		this._owner.onFinish();
	};

	destroy() {
		this.finish();
		global.stage.disconnectObject(this);
		this._owner = null;
	};
};
