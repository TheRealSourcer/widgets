import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {configureLogger, resetLogger, warn} from './logger.js';
import {ExtensionController} from './desktop/controller.js';

export {WIDGET_MODULES} from './desktop/catalog.js';

export default class DesktopWidgetsExtension extends Extension {
	enable() {
		configureLogger(this.getLogger?.() ?? null);
		this._galleryKeybindingInstalled = false;
		const settings = this.getSettings();
		this._controller = new ExtensionController(settings, this.dir, () => this.openPreferences());
		this._controller.enable();
		this._installGalleryKeybinding(settings);
	};

	disable() {
		this._removeGalleryKeybinding();
		this._controller?.destroy();
		this._controller = null;
		resetLogger();
	};

	_installGalleryKeybinding(settings) {
		try {
			Main.wm.addKeybinding(
				'toggle-gallery', settings, Meta.KeyBindingFlags.NONE,
				Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
				() => this._controller.toggleGallery());
			this._galleryKeybindingInstalled = true;
		} catch (error) {
			warn('gallery-keybinding', `Could not register the widget gallery shortcut: ${error.message}`);
		};
	};

	_removeGalleryKeybinding() {
		Main.wm.removeKeybinding('toggle-gallery');
		this._galleryKeybindingInstalled = false;
	};

	setEditMode(enabled) {
		this._controller.setEditMode(enabled);
	};

	addWidget(type, size = null, dropPoint = null) {
		this._controller.addWidget(type, size, dropPoint);
	};

	removeWidget(id) {
		this._controller.removeWidget(id);
	};

	resetWidgets() {
		this._controller.resetWidgets();
	};
};
