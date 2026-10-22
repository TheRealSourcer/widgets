import {WorkspaceIntegration} from '../workspaceIntegration.js';

import {DesktopLayout} from './layout.js';
import {DesktopTheme} from './theme.js';
import {DesktopRenderer} from './renderer.js';
import {DesktopGallery} from './gallery.js';
import {WidgetResources} from './resources.js';

export class ExtensionController {
	constructor(settings, directory, openPreferences) {
		this._openPreferences = openPreferences;
		this._layout = new DesktopLayout(settings);
		this._theme = new DesktopTheme(settings);
		this._resources = new WidgetResources(settings, directory);
		this._workspaceIntegration = new WorkspaceIntegration();
		this._renderer = new DesktopRenderer(settings, this._layout, this._theme,
			this._workspaceIntegration, id => this.removeWidget(id));
		this._gallery = new DesktopGallery(settings, this._theme, this._renderer,
			this._workspaceIntegration, this);
	};

	enable() {
		this._layout.enable();
		this._resources.enable();
		this._theme.enable(() => this._renderer.rebuild(),
			accent => this._gallery.setAccentColor(accent));
		this._renderer.enable();
		this._gallery.enable();
		this._workspaceIntegration.enable(this._renderer.layer);
	};

	destroy() {
		this._workspaceIntegration.destroy();
		this._gallery.destroy();
		this._renderer.destroy();
		this._theme.destroy();
		this._resources.destroy();
		this._layout.destroy();
		this._openPreferences = null;
		this._workspaceIntegration = null;
		this._gallery = null;
		this._renderer = null;
		this._theme = null;
		this._resources = null;
		this._layout = null;
	};

	toggleGallery() {
		this._gallery.toggle();
	};

	get editMode() {
		return this._renderer.editMode;
	};

	setEditMode(enabled) {
		this._renderer.setEditMode(enabled);
	};

	addWidget(type, size = null, dropPoint = null) {
		this._layout.add(type, size, dropPoint);
		this._renderer.rebuild();
	};

	removeWidget(id) {
		this._layout.remove(id);
		this._renderer.rebuild();
	};

	resetWidgets() {
		this._layout.reset();
		this._renderer.rebuild();
	};

	openPreferences() {
		this._openPreferences();
	};
};
