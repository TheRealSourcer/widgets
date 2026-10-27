import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const HOUR_FORMATS = ['12', '24'];
const PROJECT_URL = 'https://extensions.gnome.org/extension/10607/widgets/';
const SOURCE_URL = 'https://github.com/TheRealSourcer/widgets';
const ISSUES_URL = `${SOURCE_URL}/issues`;
const OPEN_METEO_URL = 'https://open-meteo.com/';

export default class WidgetsPreferences extends ExtensionPreferences {
	fillPreferencesWindow(window) {
		const settings = this.getSettings();
		const page = new Adw.PreferencesPage({
			title: _('Preferences'),
			icon_name: 'preferences-system-symbolic',
		});

		window.set_default_size(720, 760);
		window.set_title(_('Widgets Preferences'));
		window.add(page);

		page.add(this._createGeneralGroup(settings));
		page.add(this._createWidgetsGroup(settings));
		page.add(this._createAboutGroup(window));
	};

	_createGeneralGroup(settings) {
		const group = new Adw.PreferencesGroup({
			title: _('General'),
			description: _('Control how the widget gallery and desktop launcher behave.'),
		});

		group.add(this._switchRow(
			settings,
			'edge-launcher-enabled',
			_('Show top-panel launcher'),
			_('Show the widget gallery button in the GNOME top panel')
		));

		const bindingRow = new Adw.EntryRow({
			title: _('Widget gallery shortcut'),
			text: settings.get_strv('toggle-gallery')[0] ?? '',
			show_apply_button: true,
		});
		bindingRow.set_tooltip_text(_('Enter a GTK accelerator such as <Super>w, or leave empty to disable it'));
		bindingRow.connect('apply', () => {
			const binding = bindingRow.get_text().trim();
			settings.set_strv('toggle-gallery', binding ? [binding] : []);
		});
		group.add(bindingRow);

		const resetRow = new Adw.ActionRow({
			title: _('Reset widget layout'),
			subtitle: _('Restore the default widgets and their positions'),
			activatable: true,
		});
		resetRow.add_suffix(new Gtk.Image({
			icon_name: 'view-refresh-symbolic',
			valign: Gtk.Align.CENTER,
		}));
		resetRow.connect('activated', () => settings.set_string('layout-json', ''));
		group.add(resetRow);

		return group;
	};

	_createWidgetsGroup(settings) {
		const group = new Adw.PreferencesGroup({
			title: _('Widgets'),
			description: _('Configure widget appearance, content, and history.'),
		});

		const formatRow = new Adw.ComboRow({
			title: _('Digital clock format'),
			subtitle: _('Choose a 12-hour or 24-hour clock'),
			model: Gtk.StringList.new([_('12-hour'), _('24-hour')]),
		});
		formatRow.set_selected(Math.max(0,
			HOUR_FORMATS.indexOf(settings.get_string('digitalclock-hour-format'))));
		formatRow.connect('notify::selected', () => {
			settings.set_string(
				'digitalclock-hour-format',
				HOUR_FORMATS[formatRow.get_selected()] ?? '24'
			);
		});
		group.add(formatRow);

		group.add(this._switchRow(
			settings,
			'digitalclock-show-seconds',
			_('Show seconds'),
			_('Display seconds when supported by the selected clock size')
		));

		const amPmRow = this._switchRow(
			settings,
			'digitalclock-show-ampm',
			_('Show AM/PM'),
			_('Display the period indicator in 12-hour mode')
		);
		amPmRow.set_sensitive(formatRow.get_selected() === 0);
		formatRow.connect('notify::selected', () => {
			amPmRow.set_sensitive(formatRow.get_selected() === 0);
		});
		group.add(amPmRow);

		const usernameRow = new Adw.EntryRow({
			title: _('GitHub username'),
			text: settings.get_string('github-username'),
			show_apply_button: true,
		});
		usernameRow.set_tooltip_text(_('Public profile used by all GitHub Activity widgets'));
		usernameRow.connect('apply', () => {
			settings.set_string(
				'github-username',
				usernameRow.get_text().trim().replace(/^@/, '')
			);
		});
		group.add(usernameRow);

		group.add(this._switchRow(
			settings,
			'github-use-green',
			_('Use GitHub green colors'),
			_('Use GitHub’s contribution colors instead of the system accent color')
		));

		group.add(this._switchRow(
			settings,
			'music-ignore-browsers',
			_('Ignore web browsers'),
			_('Prevent browser media sessions from taking over the Music widget')
		));

		group.add(this._switchRow(
			settings,
			'music-blurred-background',
			_('Tint Music with album artwork'),
			_('Use enlarged, dimmed artwork behind high-contrast playback controls')
		));

		group.add(this._switchRow(
			settings,
			'hide-system-media-controls',
			_('Hide GNOME media controls'),
			_('Hide the built-in media cards when using the Music widget')
		));

		const stocksRow = new Adw.EntryRow({
			title: _('Stock symbols'),
			text: settings.get_strv('stocks-symbols').join(', '),
			show_apply_button: true,
		});
		stocksRow.set_tooltip_text(_('Comma-separated market symbols, for example ^GSPC, AAPL, MSFT'));
		stocksRow.connect('apply', () => {
			const symbols = stocksRow.get_text().split(',')
				.map(value => value.trim().toUpperCase())
				.filter(Boolean)
				.slice(0, 8);
			settings.set_strv('stocks-symbols', symbols);
		});
		group.add(stocksRow);

		const weatherRow = new Adw.EntryRow({
			title: _('Weather location'),
			text: settings.get_string('weather-location'),
			show_apply_button: true,
		});
		weatherRow.set_tooltip_text(_('City for Open-Meteo, for example New York. When empty, the city saved in the GNOME Weather app is used if it is installed'));
		weatherRow.connect('apply', () => {
			settings.set_string('weather-location', weatherRow.get_text().trim());
		});
		group.add(weatherRow);

		group.add(this._spinRow(
			settings,
			'screentime-retention-days',
			_('Screen Time retention'),
			_('Number of days of local per-application history to keep'),
			1,
			3650,
			1,
			30
		));

		group.add(this._switchRow(
			settings,
			'style-background-blur',
			_('Translucent blurred widgets'),
			_('Make widget surfaces semi-transparent and blur the wallpaper behind them')
		));

		group.add(this._spinRow(
			settings,
			'style-border-radius',
			_('Widget corner radius'),
			_('Roundness of widget corners in pixels'),
			12,
			40,
			1,
			4
		));

		return group;
	};

	_createAboutGroup(window) {
		const group = new Adw.PreferencesGroup({
			title: _('About'),
			description: _('Widgets for GNOME Shell'),
		});

		group.add(this._linkRow(
			window,
			_('Project page'),
			_('View the extension on extensions.gnome.org'),
			'web-browser-symbolic',
			PROJECT_URL
		));
		group.add(this._linkRow(
			window,
			_('Source code'),
			_('View and contribute on GitHub'),
			'folder-publicshare-symbolic',
			SOURCE_URL
		));
		group.add(this._linkRow(
			window,
			_('Report a problem'),
			_('Open the GitHub issue tracker'),
			'dialog-warning-symbolic',
			ISSUES_URL
		));
		group.add(this._linkRow(
			window,
			_('Weather data'),
			_('Powered by Open-Meteo.com'),
			'weather-clear-symbolic',
			OPEN_METEO_URL
		));

		return group;
	};

	_switchRow(settings, key, title, subtitle) {
		const row = new Adw.SwitchRow({title, subtitle});
		settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
		return row;
	};

	_spinRow(settings, key, title, subtitle, lower, upper, step, page) {
		const row = new Adw.SpinRow({
			title,
			subtitle,
			adjustment: new Gtk.Adjustment({
				lower,
				upper,
				step_increment: step,
				page_increment: page,
			}),
			digits: 0,
			numeric: true,
		});
		row.set_value(settings.get_int(key));
		row.connect('notify::value', () => {
			settings.set_int(key, Math.round(row.get_value()));
		});
		return row;
	};

	_linkRow(window, title, subtitle, iconName, uri) {
		const row = new Adw.ActionRow({title, subtitle, activatable: true});
		row.add_prefix(new Gtk.Image({icon_name: iconName}));
		row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
		row.connect('activated', () => {
			const launcher = new Gtk.UriLauncher({uri});
			launcher.launch(window, null, (_launcher, result) => {
				try {
					launcher.launch_finish(result);
				} catch (error) {
					console.error(`Unable to open ${uri}: ${error.message}`);
				};
			});
		});
		return row;
	};

	_disclosureRow(title, subtitle, iconName) {
		const row = new Adw.ActionRow({title, subtitle});
		row.add_prefix(new Gtk.Image({icon_name: iconName}));
		return row;
	};
};
