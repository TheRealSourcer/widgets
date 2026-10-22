import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {CHILD_ADDED, getMediaContainer, getMediaMessages} from '../../compatibility.js';

export class SystemMediaControls {
	constructor(settings) {
		this._settings = settings;
		this._messageList = null;
		this._emitters = new Set();
		this._syncId = 0;
	};

	enable() {
		this._messageList = Main.panel.statusArea.dateMenu?._messageList ?? null;
		const view = getMediaContainer(this._messageList);
		if (view) {
			this._emitters.add(view);
			view.connectObject(CHILD_ADDED, () => {
				if (!this._syncId) {
					this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
						this._syncId = 0;
						this.sync();
						return GLib.SOURCE_REMOVE;
					});
				};
			}, this);
		};
		const section = this._messageList?._mediaSection;
		if (section) {
			this._emitters.add(section);
			section.connectObject('notify::visible', () => this.sync(), this);
		};
		this._emitters.add(this._settings);
		this._settings.connectObject('changed::hide-system-media-controls', () => this.sync(), this);
		this.sync();
	};

	sync() {
		const hide = this._settings.get_boolean('hide-system-media-controls');
		const section = this._messageList?._mediaSection;
		if (hide) {
			section?.hide();
		} else {
			section?._sync();
		};
		for (const message of getMediaMessages(this._messageList)) {
			if (hide) {
				message.hide();
			} else {
				message.show();
			};
		};
	};

	destroy() {
		if (this._syncId) {
			GLib.source_remove(this._syncId);
		};
		this._syncId = 0;
		for (const object of this._emitters) {
			object.disconnectObject(this);
		};
		this._emitters.clear();
		for (const message of getMediaMessages(this._messageList)) {
			message.show();
		};
		this._messageList?._mediaSection?._sync();
		this._messageList = null;
		this._settings = null;
	};
};
