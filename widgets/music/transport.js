import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {PLAYER_IFACE, PLAYER_PATH, DBUS_IFACE, isBrowserName, variantValue, parseMetadata} from './helpers.js';
import {warn} from '../../logger.js';

let cachedBus = null;

export function sessionBus() {
	if (cachedBus === null) {
		try {
			cachedBus = Gio.DBus.session;
		} catch (error) {
			warn('music-session-bus', `Could not connect to the session bus: ${error.message}`);
			cachedBus = undefined;
		};
	};

	return cachedBus;
};

export function resetSessionBus() {
	cachedBus = null;
};

export class MprisTransport {
	constructor(bus, cancellable) {
		this._bus = bus;
		this._cancellable = cancellable;
	};

	_report(error, iface, method, quiet) {
		if (this._cancellable.is_cancelled() ||
					(error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))) return;

		const remote = error instanceof GLib.Error ? Gio.DBusError.get_remote_error(error) : null;
		if (['org.freedesktop.DBus.Error.NameHasNoOwner', 'org.freedesktop.DBus.Error.ServiceUnknown'].includes(remote)) return;
		if (quiet && ['org.freedesktop.DBus.Error.UnknownMethod', 'org.freedesktop.DBus.Error.UnknownProperty',
			'org.freedesktop.DBus.Error.NotSupported', 'org.mpris.MediaPlayer2.Player.Error.NotSupported'].includes(remote)) return;

		warn(`music-dbus-${iface}-${method}`, `MPRIS ${iface}.${method} failed: ${error.message}`);
	};

	call(busName, path, iface, method, params, type, quiet = false) {
		if (this._cancellable.is_cancelled() || !this._bus) {
			return Promise.resolve(null);
		};

		return new Promise(resolve => {
			try {
				this._bus.call(busName, path, iface, method, params, type,
					Gio.DBusCallFlags.NONE, -1, this._cancellable,
					(connection, result) => {
						try {
							const reply = connection.call_finish(result);
							resolve(this._cancellable.is_cancelled() ? null : reply);
						} catch (error) {
							this._report(error, iface, method, quiet);
							resolve(null);
						};
					});
			} catch (error) {
				this._report(error, iface, method, quiet);
				resolve(null);
			};
		});
	};

	async listCandidates() {
		const result = await this.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
			'org.freedesktop.DBus', 'ListNames', null, GLib.VariantType.new('(as)'));
		const names = result?.deep_unpack()?.[0] ?? [];

		return names.filter(name => name.startsWith('org.mpris.MediaPlayer2.'));
	};

	async pickActive(ignoreBrowsers, lastPlayingAt) {
		const rows = [];

		for (const candidate of await this.listCandidates()) {
			if (this._cancellable.is_cancelled()) {
				return null;
			};
			const props = await this._readProps(candidate);

			if (this._cancellable.is_cancelled()) {
				return null;
			};

			if (!props) {
				continue;
			};

			const status = variantValue(props.PlaybackStatus);
			const meta = parseMetadata(variantValue(props.Metadata));
			const hasTitle = Boolean(meta.title && meta.title.length);
			const isBrowser = isBrowserName(candidate);
			
			if (ignoreBrowsers && isBrowser) {
				continue;
			};

			const isProxy = candidate.toLowerCase().includes('playerctld');
			let value = 0;

			if (status === 'Playing' && hasTitle) {
				value = 500;

				if (!isBrowser) {
					lastPlayingAt[candidate] = Date.now();
				};
			} else if (status === 'Paused' && hasTitle) {
				value = 100;
			} else if (hasTitle) {
				value = 50;
			};

			rows.push({name: candidate, props, status, hasTitle, value,
				recency: lastPlayingAt[candidate] ?? 0, isBrowser, isProxy});
		};

		let bestNonBrowser = null;
		let bestBrowser = null;

		for (const row of rows) {
			if (row.value <= 0) {
				continue;
			};

			const current = row.isBrowser ? bestBrowser : bestNonBrowser;

			if (!current || row.value > current.value ||
				(row.value === current.value && row.recency > current.recency)) {
				if (row.isBrowser) {
					bestBrowser = row;
				} else {
					bestNonBrowser = row;
				};
			};
		};

		if (bestNonBrowser && !(bestNonBrowser.isProxy && bestBrowser && bestNonBrowser.value <= bestBrowser.value)) {
			return bestNonBrowser;
		};

		return bestBrowser;
	};

	async _readProps(name) {
		const result = await this.call(name, PLAYER_PATH, DBUS_IFACE, 'GetAll',
			GLib.Variant.new('(s)', [PLAYER_IFACE]), GLib.VariantType.new('(a{sv})'));
		const props = result?.deep_unpack()?.[0] ?? null;

		return props && typeof props === 'object' ? props : null;
	};

	destroy() {
		this._cancellable.cancel();
		this._bus = null;
	};
};
