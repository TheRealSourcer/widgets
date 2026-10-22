import Gio from 'gi://Gio';
import {hasSetting} from '../compatibility.js';
import {surfaceStyle} from '../utils/widget.js';
import {WIDGETS} from './catalog.js';


const ACCENT_COLORS = {
	blue: '#3584e4',
	teal: '#2190a4',
	green: '#3a944a',
	yellow: '#c88800',
	orange: '#ed5b00',
	red: '#e62d42',
	pink: '#d56199',
	purple: '#9141ac',
	slate: '#6f8396',
};

function accentColor(settings) {
	const accent = hasSetting(settings, 'accent-color') ? settings.get_string('accent-color') : 'blue';

	return ACCENT_COLORS[accent] ?? ACCENT_COLORS.blue;
};

function darkStyleEnabled(settings) {
	return settings.get_string('color-scheme') === 'prefer-dark';
};

export class DesktopTheme {
	constructor(settings) {
		this._layoutSettings = settings;
		this._interfaceSettings = null;
	};

	enable(onChanged, onAccentChanged) {
		this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
		this._interfaceSettings.connectObject('changed::color-scheme', onChanged, this);

		if (hasSetting(this._interfaceSettings, 'accent-color')) {
			this._interfaceSettings.connectObject('changed::accent-color', () => {
				onChanged();
				onAccentChanged(this.accent);
			}, this);
		};
		this._layoutSettings.connectObject(
			'changed::style-border-radius', onChanged,
			'changed::style-background-blur', onChanged,
			this);
	};

	destroy() {
		this._interfaceSettings?.disconnectObject(this);
		this._layoutSettings.disconnectObject(this);
		this._interfaceSettings = null;
		this._layoutSettings = null;
	};

	get accent() {
		return accentColor(this._interfaceSettings);
	};

	current() {
		const dark = darkStyleEnabled(this._interfaceSettings);
		const blur = this._layoutSettings.get_boolean('style-background-blur');

		return {
			dark,
			blur,
			accent: accentColor(this._interfaceSettings),
			background: blur
				? dark ? 'rgba(36, 36, 36, 0.68)' : 'rgba(255, 255, 255, 0.68)'
				: dark ? '#242424' : '#ffffff',
			border: dark ? '#3d3d3d' : '#deddda',
			text: dark ? '#ffffff' : '#241f31',
			muted: dark ? '#c0bfbc' : '#5e5c64',
			radius: this._layoutSettings.get_int('style-border-radius'),
		};
	};

	styleForWidget(widget, theme = this.current()) {
		return WIDGETS.get(widget.type)?.style?.(theme) ?? surfaceStyle(theme);
	};
};
