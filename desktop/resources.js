import St from 'gi://St';
import {WIDGET_MODULES} from './catalog.js';
import * as Storage from '../utils/storage.js';

export class WidgetResources {
	constructor(settings, directory) {
		this._settings = settings;
		this._directory = directory;
		this._stylesheets = [];
		this._modules = [];
		this._theme = null;
	};

	enable() {
		this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
		for (const widgetModule of WIDGET_MODULES) {
			if (!widgetModule.stylesheet) {
				continue;
			};

			const file = this._directory.resolve_relative_path(widgetModule.stylesheet);
			this._theme.load_stylesheet(file);
			this._stylesheets.push(file);
		};
		for (const widgetModule of WIDGET_MODULES) {
			this._modules.push(widgetModule);
			widgetModule.initialize?.({settings: this._settings});
		};
	};

	destroy() {
		for (const widgetModule of this._modules) widgetModule.cleanup?.();
		this._modules = [];
		Storage.cleanup();
		for (const file of this._stylesheets) this._theme.unload_stylesheet(file);
		this._stylesheets = [];
		this._settings = null;
		this._directory = null;
		this._theme = null;
	};
};
