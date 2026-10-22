import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WidgetGallery} from '../widgetGallery.js';
import {widgetCatalog} from './catalog.js';


export class DesktopGallery {
	constructor(settings, theme, renderer, workspaceIntegration, controller) {
		this._settings = settings;
		this._theme = theme;
		this._renderer = renderer;
		this._workspaceIntegration = workspaceIntegration;
		this._controller = controller;
		this._gallery = null;
	};

	enable() {
		this._gallery = new WidgetGallery({
			accentColor: this._theme.accent,
			catalog: widgetCatalog(),
			createPreview: (type, size, width, height) => this._renderer.createPreview(type, size, width, height),
			onAdd: (type, size) => {
				this._controller.setEditMode(true);
				this._controller.addWidget(type, size);
				this._gallery.close();
			},
			onDrop: (type, size, stageX, stageY) => this._drop(type, size, stageX, stageY),
			onEditToggle: () => this._controller.setEditMode(!this._controller.editMode),
			onReset: () => this._controller.resetWidgets(),
			onSettings: () => this._controller.openPreferences(),
			getEditMode: () => this._controller.editMode,
		});
		this._syncLauncher();
		this._settings.connectObject('changed::edge-launcher-enabled', () => this._syncLauncher(), this);
	};

	destroy() {
		this._settings.disconnectObject(this);
		this._gallery?.destroy();
		this._gallery = null;
		this._settings = null;
		this._theme = null;
		this._renderer = null;
		this._workspaceIntegration = null;
		this._controller = null;
	};

	toggle() {
		this._gallery.toggle();
	};

	setAccentColor(accent) {
		if (this._gallery) {
			this._gallery.setAccentColor(accent);
		};
	};

	_syncLauncher() {
		this._gallery.setLauncherEnabled(this._settings.get_boolean('edge-launcher-enabled'));
	};

	_drop(type, size, stageX, stageY) {
		const overviewPoint = this._workspaceIntegration.desktopPointForStagePoint(stageX, stageY);
		if (Main.overview.visible || Main.overview.visibleTarget) {
			if (!overviewPoint) return;
		} else {
			const monitor = Main.layoutManager.primaryMonitor;
			if (!monitor || stageX < monitor.x || stageX >= monitor.x + monitor.width ||
				stageY < monitor.y + Main.panel.height || stageY >= monitor.y + monitor.height) return;

			const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, stageX, stageY);
			for (let current = picked; current; current = current.get_parent()) {
				const window = current.meta_window ??
					(current instanceof Meta.WindowActor ? current.get_meta_window() : null);
				if (window) return;
			};
		};
		this._controller.setEditMode(true);
		this._controller.addWidget(type, size, overviewPoint ?? {x: stageX, y: stageY});
	};
};
