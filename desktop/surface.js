import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import {createBlurEffect} from '../compatibility.js';


export function raiseActor(actor) {
	const parent = actor.get_parent();
	if (parent) {
		parent.set_child_above_sibling(actor, null);
	};
};

class BlurredSurface {
	constructor(owner) {
		this._owner = owner;
		this._surface = null;
		this._manager = null;
	};

	create() {
		try {
			const monitor = Main.layoutManager.primaryMonitor;
			this._surface = new St.Widget({
				reactive: false,
				layout_manager: new Clutter.FixedLayout(),
				x_expand: true,
				y_expand: true,
				x_align: Clutter.ActorAlign.FILL,
				y_align: Clutter.ActorAlign.FILL,
				clip_to_allocation: true,
			});
			this._surface.connectObject('destroy', () => this._releaseResources(), this._surface);
			const wallpaper = new St.Widget({width: monitor.width, height: monitor.height});
			this._surface.add_child(wallpaper);
			this._manager = new Background.BackgroundManager({
				container: wallpaper, monitorIndex: Main.layoutManager.primaryIndex,
				controlPosition: false,
			});
			const syncPosition = () => wallpaper.set_position(-this._owner.x, -this._owner.y);
			this._owner.connectObject('notify::x', syncPosition, 'notify::y', syncPosition, this._surface);
			syncPosition();
			this._surface.add_effect(createBlurEffect({
				brightness: 1,
				radius: 18,
				mode: Shell.BlurMode.ACTOR,
			}));
			return this._surface;
		} catch (error) {
			this.destroy();
			throw error;
		};
	};

	destroy() {
		if (!this._surface) return;

		const surface = this._surface;
		this._releaseResources();
		surface.destroy();
	};

	_releaseResources() {
		if (!this._surface) return;

		const surface = this._surface;
		const manager = this._manager;
		const owner = this._owner;
		this._surface = null;
		this._manager = null;
		this._owner = null;
		owner.disconnectObject(surface);
		manager?.destroy();

	};
};

export function createBlurredSurface(owner) {
	return new BlurredSurface(owner).create();
};
