import GLib from 'gi://GLib';

let EXTENSION_PATH = null;

try {
	const [path] = GLib.filename_from_uri(import.meta.url);

	EXTENSION_PATH = GLib.path_get_dirname(path);
} catch (error) {
	EXTENSION_PATH = null;
};

function assetPath(name) {
	return EXTENSION_PATH ? GLib.build_filenamev([EXTENSION_PATH, 'assets', String(name ?? '')]) : null;
};

/**
 Path to a settings icon (`icons/settings/<name>.svg`).
 *
 Needed in the shell, where GTK does no icon-theme lookup: dw-* icons
 have two color variants (-light/-dark) and no -symbolic suffix,
 so they cannot be passed as icon_name — only as a file path.
 */
function settingsIconPath(name) {
	return EXTENSION_PATH
		? GLib.build_filenamev([EXTENSION_PATH, 'icons', 'settings', `${String(name ?? '')}.svg`])
		: null;
};

/**
 Path to widget-internal resources (`icons/widgets_settings/<widgetType>/<name>`).
 Used for control icons, GIF animations, etc.
 */
function widgetResourcePath(widgetType, name) {
	return EXTENSION_PATH
		? GLib.build_filenamev([EXTENSION_PATH, 'icons', 'widgets_settings', String(widgetType ?? ''), String(name ?? '')])
		: null;
};


export { EXTENSION_PATH, assetPath, settingsIconPath, widgetResourcePath };
