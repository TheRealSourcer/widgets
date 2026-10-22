import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import {surfaceStyle} from '../../utils/widget.js';
import {VERTICAL, boxOrientation} from '../../compatibility.js';

import { warn } from '../../logger.js';

export const type = 'battery';
export const label = 'Battery';
export const stylesheet = 'widgets/battery/stylesheet.css';
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium', 'large'];

const SLOT_COUNT = 4;

const DEVICE_TYPE = {
	BATTERY: 2,
	UPS: 3,
	MOUSE: 5,
	KEYBOARD: 6,
	PDA: 7,
	PHONE: 8,
	MEDIA_PLAYER: 9,
	TABLET: 10,
	COMPUTER: 11,
	GAMING_INPUT: 12,
	PEN: 13,
	TOUCHPAD: 14,
	HEADSET: 17,
	SPEAKERS: 18,
	HEADPHONES: 19,
	OTHER_AUDIO: 21,
};

function variantValue(props, name, fallback = null) {
	return props[name] ? props[name].deep_unpack() : fallback;
};

function batteryColor(percentage) {
	if (percentage <= 20) return [0.93, 0.21, 0.25];
	if (percentage <= 40) return [0.95, 0.68, 0.19];

	return [0.34, 0.89, 0.54];
};

function normalizeName(name) {
	return String(name || '').trim().toLowerCase();
};

function bluezIconName(iconName) {
	if (!iconName) return 'bluetooth-symbolic';

	return iconName.endsWith('-symbolic') ? iconName : `${iconName}-symbolic`;
};

function iconForDevice(device) {
	if (!device) return 'battery-missing-symbolic';

	if (device.source === 'bluez' && device.iconName) return device.iconName;

	switch (device.kind) {
		case DEVICE_TYPE.BATTERY:
		case DEVICE_TYPE.COMPUTER:
			return device.powerSupply ? 'computer-symbolic' : 'battery-symbolic';
		case DEVICE_TYPE.MOUSE:
		case DEVICE_TYPE.GAMING_INPUT:
			return 'input-mouse-symbolic';
		case DEVICE_TYPE.KEYBOARD:
			return 'input-keyboard-symbolic';
		case DEVICE_TYPE.PHONE:
		case DEVICE_TYPE.PDA:
			return 'phone-symbolic';
		case DEVICE_TYPE.TABLET:
		case DEVICE_TYPE.PEN:
		case DEVICE_TYPE.TOUCHPAD:
			return 'input-tablet-symbolic';
		case DEVICE_TYPE.HEADSET:
			return 'audio-headset-symbolic';
		case DEVICE_TYPE.HEADPHONES:
		case DEVICE_TYPE.OTHER_AUDIO:
			return 'audio-headphones-symbolic';
		case DEVICE_TYPE.SPEAKERS:
			return 'audio-speakers-symbolic';
		case DEVICE_TYPE.UPS:
			return 'battery-symbolic';
		default:
			return device.iconName || 'battery-symbolic';
	};
};

function deviceName(props, kind) {
	const model = String(variantValue(props, 'Model', '')).trim();
	const vendor = String(variantValue(props, 'Vendor', '')).trim();

	if (model) return model;
	if (vendor) return vendor;
	if (kind === DEVICE_TYPE.BATTERY) return 'Computer';
	if (kind === DEVICE_TYPE.MOUSE) return 'Mouse';
	if (kind === DEVICE_TYPE.KEYBOARD) return 'Keyboard';

	return 'Device';
};

function isBatteryLike(props) {
	const kind = variantValue(props, 'Type', 0);
	const percentage = Number(variantValue(props, 'Percentage', Number.NaN));
	const rechargeable = variantValue(props, 'IsRechargeable', false);
	const present = variantValue(props, 'IsPresent', true);

	if (!present || !Number.isFinite(percentage)) return false;

	return rechargeable || [
		DEVICE_TYPE.BATTERY,
		DEVICE_TYPE.UPS,
		DEVICE_TYPE.MOUSE,
		DEVICE_TYPE.KEYBOARD,
		DEVICE_TYPE.PDA,
		DEVICE_TYPE.PHONE,
		DEVICE_TYPE.MEDIA_PLAYER,
		DEVICE_TYPE.TABLET,
		DEVICE_TYPE.COMPUTER,
		DEVICE_TYPE.GAMING_INPUT,
		DEVICE_TYPE.PEN,
		DEVICE_TYPE.TOUCHPAD,
		DEVICE_TYPE.HEADSET,
		DEVICE_TYPE.SPEAKERS,
		DEVICE_TYPE.HEADPHONES,
		DEVICE_TYPE.OTHER_AUDIO,
	].includes(kind);
};

function busCall(busName, path, iface, method, params, cancellable) {
	return new Promise((resolve, reject) => {
		Gio.DBus.system.call(busName, path, iface, method, params, null,
			Gio.DBusCallFlags.NONE, 1000, cancellable, (connection, result) => {
				try {
					resolve(connection.call_finish(result));
				} catch (error) {
					reject(error);
				};
			});
	});
};

async function readUPowerDevices(cancellable) {
	try {
		const reply = await busCall('org.freedesktop.UPower', '/org/freedesktop/UPower',
			'org.freedesktop.UPower', 'EnumerateDevices', null, cancellable);
		const [paths] = reply.deep_unpack();
		const replies = await Promise.all(paths.map(path => busCall('org.freedesktop.UPower', path,
			'org.freedesktop.DBus.Properties', 'GetAll',
			new GLib.Variant('(s)', ['org.freedesktop.UPower.Device']), cancellable)));
		const devices = [];

		for (const deviceReply of replies) {
			const [props] = deviceReply.deep_unpack();

			if (!isBatteryLike(props)) {
				continue;
			};

			const kind = variantValue(props, 'Type', 0);
			const percentage = Math.round(Math.max(0, Math.min(100, Number(variantValue(props, 'Percentage', 0)))));

			devices.push({
				source: 'upower',
				name: deviceName(props, kind),
				kind,
				percentage,
				powerSupply: variantValue(props, 'PowerSupply', false),
				iconName: variantValue(props, 'IconName', null),
				nativePath: variantValue(props, 'NativePath', null),
			});
		};

		return devices;
	} catch (error) {
		if (!cancellable.is_cancelled()) {
			warn('upower-read', `Could not read UPower batteries: ${error.message}`);
		};
		return [];
	};
};

async function readBlueZDevices(cancellable) {
	try {
		const reply = await busCall('org.bluez', '/', 'org.freedesktop.DBus.ObjectManager',
			'GetManagedObjects', null, cancellable);
		const [objects] = reply.deep_unpack();
		const devices = [];

		for (const [path, interfaces] of Object.entries(objects)) {
			const deviceProps = interfaces['org.bluez.Device1'];
			const batteryProps = interfaces['org.bluez.Battery1'];

			if (!deviceProps || !batteryProps || !variantValue(deviceProps, 'Connected', false)) {
				continue;
			};

			const percentage = Number(variantValue(batteryProps, 'Percentage', Number.NaN));

			if (!Number.isFinite(percentage)) {
				continue;
			};

			const iconName = bluezIconName(variantValue(deviceProps, 'Icon', null));

			devices.push({
				source: 'bluez',
				name: String(variantValue(deviceProps, 'Alias', '') || variantValue(deviceProps, 'Name', '') || 'Bluetooth'),
				percentage: Math.round(Math.max(0, Math.min(100, percentage))),
				powerSupply: false,
				iconName,
				nativePath: path,
			});
		};

		return devices;
	} catch (error) {
		if (!cancellable.is_cancelled()) {
			warn('bluez-read', `Could not read Bluetooth batteries: ${error.message}`);
		};
		return [];
	};
};

function deviceKey(device) {
	const path = String(device.nativePath || '');

	if (path.startsWith('/org/bluez/')) return path;

	return normalizeName(device.name);
};

function mergeDevices(devices) {
	const merged = new Map();

	for (const device of devices) {
		const key = deviceKey(device);
		const existing = merged.get(key);

		if (!existing || (existing.source !== 'upower' && device.source === 'upower')) {
			merged.set(key, device);
		};
	};

	return [...merged.values()].sort((a, b) => Number(b.powerSupply) - Number(a.powerSupply) || a.name.localeCompare(b.name));
};

async function readDevices(cancellable) {
	const [upower, bluez] = await Promise.all([
		readUPowerDevices(cancellable), readBlueZDevices(cancellable),
	]);
	return mergeDevices([...upower, ...bluez]);
};

export const batteryService = {
	listeners: new Set(),
	devices: [],
	signalIds: [],
	timerId: 0,
	cancellable: null,
	updating: false,
	refreshAgain: false,

	subscribe(callback) {
		if (this.listeners.size === 0) {
			this.start();
		};
		this.listeners.add(callback);
		callback(this.devices);
		return () => {
			this.listeners.delete(callback);
			if (this.listeners.size === 0) {
				this.stop();
			};
		};
	},

	start() {
		this.cancellable = new Gio.Cancellable();
		const refresh = () => this.refresh();
		const refreshBlueZ = (_connection, _sender, _path, _iface, _signal, parameters) => {
			const [iface] = parameters.deep_unpack();
			if (['org.bluez.Device1', 'org.bluez.Battery1'].includes(iface)) {
				this.refresh();
			};
		};
		const bus = Gio.DBus.system;
		const subscribe = (name, iface, signal, path, arg, callback) =>
			bus.signal_subscribe(name, iface, signal, path, arg, Gio.DBusSignalFlags.NONE, callback);
		this.signalIds = [
			subscribe('org.freedesktop.UPower', 'org.freedesktop.UPower', 'DeviceAdded', '/org/freedesktop/UPower', null, refresh),
			subscribe('org.freedesktop.UPower', 'org.freedesktop.UPower', 'DeviceRemoved', '/org/freedesktop/UPower', null, refresh),
			subscribe('org.freedesktop.UPower', 'org.freedesktop.DBus.Properties', 'PropertiesChanged', null, 'org.freedesktop.UPower.Device', refresh),
			subscribe('org.bluez', 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded', '/', null, refresh),
			subscribe('org.bluez', 'org.freedesktop.DBus.ObjectManager', 'InterfacesRemoved', '/', null, refresh),
			subscribe('org.bluez', 'org.freedesktop.DBus.Properties', 'PropertiesChanged', null, null, refreshBlueZ),
    ];

    if (this.timerId) {
      GLib.Source.remove(this.timerId);
      this.timerId = 0
    };

		this.timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
			this.refresh();
			return GLib.SOURCE_CONTINUE;
		});
		this.refresh();
	},

	async refresh() {
		if (!this.cancellable) return;
		if (this.updating) {
			this.refreshAgain = true;
			return;
		};
		const cancellable = this.cancellable;
		this.updating = true;
		try {
			const devices = await readDevices(cancellable);
			if (cancellable.is_cancelled()) return;
			this.devices = devices;
			for (const callback of [...this.listeners]) {
				if (this.listeners.has(callback)) {
					callback(devices);
				};
			};
		} catch (error) {
			if (!cancellable.is_cancelled()) {
				warn('battery-refresh', error.message);
			};
		} finally {
			if (cancellable === this.cancellable) {
				this.updating = false;
				if (this.refreshAgain) {
					this.refreshAgain = false;
					this.refresh();
				};
			};
		};
	},

	stop() {
		this.cancellable?.cancel();
		this.cancellable = null;
		if (this.timerId) {
			GLib.Source.remove(this.timerId);
		};
		this.timerId = 0;
		for (const id of this.signalIds) Gio.DBus.system.signal_unsubscribe(id);
		this.signalIds = [];
		this.updating = false;
		this.refreshAgain = false;
	},
};

export function cleanup() {
	batteryService.stop();
	batteryService.listeners.clear();
	batteryService.devices = [];
};

const BatteryRing = GObject.registerClass(
	class BatteryRing extends St.DrawingArea {
		_init(device, theme) {
			super._init({style_class: 'widget-battery-ring'});
			this._percentage = device?.percentage ?? null;
			this._ringColor = batteryColor(this._percentage);
			this._trackColor = theme?.dark ? [1, 1, 1, 0.16] : [0, 0, 0, 0.11];
		};

		vfunc_repaint() {
			const cr = this.get_context();
			const [width, height] = this.get_surface_size();

			if (width <= 0 || height <= 0) {
				cr.$dispose();
				return;
			};

			const lineWidth = Math.max(4, Math.round(Math.min(width, height) / 12));
			const radius = Math.min(width, height) / 2 - lineWidth / 2 - 1;
			const centerX = width / 2;
			const centerY = height / 2;

			cr.setLineCap(1);
			cr.setLineWidth(lineWidth);
			cr.arc(centerX, centerY, radius, 0, Math.PI * 2);
			cr.setSourceRGBA(...this._trackColor);
			cr.stroke();

			if (Number.isFinite(this._percentage)) {
				cr.arc(centerX, centerY, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (this._percentage / 100));
				cr.setSourceRGBA(...this._ringColor, 1);
				cr.stroke();
			};

			cr.$dispose();
		};
	});

export function style(theme) {
	return surfaceStyle(theme);
};

function createSlot(device, theme, createLabel, small = false) {
	const slot = new St.BoxLayout({
		...VERTICAL,
		style_class: small ? 'widget-battery-slot widget-battery-slot-small' : 'widget-battery-slot',
		x_expand: !small,
		x_align: Clutter.ActorAlign.CENTER,
	});
	const gauge = new St.Widget({style_class: 'widget-battery-gauge'});
	const ring = new BatteryRing(device, theme);
	const gaugeSize = small ? 60 : 84;
	const iconSize = small ? 20 : 30;
	const icon = new St.Icon({
		icon_name: iconForDevice(device),
		style_class: 'widget-battery-icon',
		style: `color: ${device ? theme.text : theme.muted};`,
	});

	gauge.set_size(gaugeSize, gaugeSize);
	ring.set_size(gaugeSize, gaugeSize);
	icon.set_size(iconSize, iconSize);
	icon.set_position((gaugeSize - iconSize) / 2, (gaugeSize - iconSize) / 2);
	gauge.add_child(ring);
	gauge.add_child(icon);
	slot.add_child(gauge);

	const label = createLabel(device ? `${device.percentage}%` : '', 'widget-battery-percent', `color: ${device ? theme.text : theme.muted};`);

	label.x_expand = false;
	label.x_align = Clutter.ActorAlign.CENTER;
	slot.add_child(label);
	return slot;
};

export function render({body, widget, createLabel, theme}) {
	const small = widget.size === 'small';
	const tray = new St.BoxLayout({
		...boxOrientation(small),
		style_class: small ? 'widget-battery-tray widget-battery-tray-small' : 'widget-battery-tray',
		x_expand: true,
		y_expand: true,
		...(small ? {x_align: Clutter.ActorAlign.CENTER} : {}),
		y_align: Clutter.ActorAlign.CENTER,
	});

	const populate = allDevices => {
		const devices = allDevices.slice(0, SLOT_COUNT);
		tray.destroy_all_children();
		if (small) {
			for (let rowIndex = 0; rowIndex < 2; rowIndex++) {
				const row = new St.BoxLayout({style_class: 'widget-battery-row', x_align: Clutter.ActorAlign.CENTER});
				for (let column = 0; column < 2; column++) {
					const index = rowIndex * 2 + column;
					row.add_child(createSlot(devices[index] ?? null, theme, createLabel, true));
				};
				tray.add_child(row);
			};
		} else {
			for (let index = 0; index < SLOT_COUNT; index++)
				tray.add_child(createSlot(devices[index] ?? null, theme, createLabel));
		};
	};
	body.add_child(tray);
	const unsubscribe = batteryService.subscribe(populate);
	tray.connectObject('destroy', unsubscribe, tray);
};
