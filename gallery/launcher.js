import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export class GalleryLauncher {
	constructor(owner) {
		this._owner = owner;
	};

	create() {
		if (this._launcher) {
			return this._launcher;
		};

		this._launcher = new PanelMenu.Button(0.5, _('Widgets'), true);
		this._launcher.add_child(new St.Icon({
			icon_name: 'view-grid-symbolic',
			style_class: 'system-status-icon',
		}));
		this._launcher.accessible_name = _('Open widget gallery');
		this._launcher.connectObject('button-release-event', (_actor, event) => {
			if (event.get_button() === 1) {
				this._owner.toggle();
				return Clutter.EVENT_STOP;
			};
			if (event.get_button() === 3) {
				this._openLauncherMenu();
				return Clutter.EVENT_STOP;
			};
			return Clutter.EVENT_PROPAGATE;
		}, this._launcher);
		this._launcher.connectObject('key-press-event', (_actor, event) => {
			const symbol = event.get_key_symbol();
			if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space].includes(symbol)) {
				this._owner.toggle();
				return Clutter.EVENT_STOP;
			};
			return Clutter.EVENT_PROPAGATE;
		}, this._launcher);
		Main.panel.addToStatusArea('widgets-gallery', this._launcher, 0, 'right');
		return this._launcher;
	};

	_openLauncherMenu() {
		if (!this._launcherMenu) {
			this._launcherMenu = new PopupMenu.PopupMenu(this._launcher, 0.5, St.Side.TOP);
			this._launcherMenu.actor.add_style_class_name('panel-menu');
			this._launcherMenu.actor.hide();
			Main.uiGroup.add_child(this._launcherMenu.actor);
			this._launcherMenuManager = new PopupMenu.PopupMenuManager(this._launcher);
			this._launcherMenuManager.addMenu(this._launcherMenu);
			this._toggleMenuItem = new PopupMenu.PopupMenuItem(_('Open Widget Gallery'));
			this._toggleMenuItem.connectObject('activate', () => this._owner.toggle(), this._toggleMenuItem);
			this._launcherMenu.addMenuItem(this._toggleMenuItem);
			this._launcherMenu.addAction(_('Extension Settings'), () => this._owner.onSettings());
			this._launcherMenu.connectObject('open-state-changed', (_menu, open) => {
				if (open) {
					this._toggleMenuItem.label.text = this._owner.isOpen ? _('Close Widget Gallery') : _('Open Widget Gallery');
				};
			}, this._launcherMenu.actor);
		};
		this._toggleMenuItem.label.text = this._owner.isOpen ? _('Close Widget Gallery') : _('Open Widget Gallery');
		this._launcherMenu.open();
	};

	destroy() {
		this._launcherMenu?.destroy();
		this._launcherMenu = null;
		this._launcherMenuManager = null;
		this._toggleMenuItem = null;
		this._launcher?.destroy();
		this._launcher = null;
		this._owner = null;
	};
};
