import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {getDataDir, loadJsonFromFileAsync, saveJsonToFile} from './storage.js';

const TICK_INTERVAL_MS = 1000;
const SAVE_THROTTLE_MS = 15000;
const MICROSECONDS_PER_SECOND = 1000000;
const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;
const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
const MAX_ACCOUNT_INTERVAL_SECONDS = 5;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dataDir() {
	return getDataDir('screen-time');
};

function dateString(dateTime) {
	return `${dateTime.get_year()}-${String(dateTime.get_month()).padStart(2, '0')}-${String(dateTime.get_day_of_month()).padStart(2, '0')}`;
};

function todayDateString() {
	return dateString(GLib.DateTime.new_now_local());
};

function dayFilePath(day) {
	return GLib.build_filenamev([dataDir(), `${day}.json`]);
};

function validDateString(day) {
	return typeof day === 'string' && DATE_PATTERN.test(day);
};

function cleanHours(value) {
	const hours = new Array(HOURS_PER_DAY).fill(0);
	if (!Array.isArray(value)) {
		return hours;
	};

	for (let index = 0; index < HOURS_PER_DAY; index++) {
		const seconds = Number(value[index]);
		if (Number.isFinite(seconds) && seconds >= 0) {
			hours[index] = Math.min(SECONDS_PER_HOUR, seconds);
		};
	};
	return hours;
};

function mapFromData(data, expectedDate = null) {
	const apps = new Map();
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		return apps;
	};
	if (expectedDate && data.date !== undefined && data.date !== expectedDate) {
		return apps;
	};
	if (!data.apps || typeof data.apps !== 'object' || Array.isArray(data.apps)) {
		return apps;
	};

	for (const [key, value] of Object.entries(data.apps)) {
		if (!key || key.length > 512 || !Array.isArray(value)) {
			continue;
		};
		apps.set(key, cleanHours(value));
	};
	return apps;
};

function mergeMaps(saved, accumulated) {
	const merged = new Map(saved);
	for (const [key, localHours] of accumulated) {
		const hours = merged.get(key) ?? new Array(HOURS_PER_DAY).fill(0);
		for (let index = 0; index < HOURS_PER_DAY; index++)
			hours[index] = Math.min(SECONDS_PER_HOUR, (hours[index] ?? 0) + (localHours[index] ?? 0));
		merged.set(key, hours);
	};
	return merged;
};

function cleanupOldFiles(retentionDays) {
	const cutoff = GLib.DateTime.new_now_local().add_days(-(retentionDays - 1));
	const cutoffDate = dateString(cutoff);
	let enumerator = null;

	try {
		const directory = Gio.File.new_for_path(dataDir());
		enumerator = directory.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
		let info;
		while ((info = enumerator.next_file(null)) !== null) {
			const name = info.get_name();
			const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
			if (match && match[1] < cutoffDate) {
				try {
					directory.get_child(name).delete(null);
				} catch (error) {
					console.error(`Failed to delete old screen time file ${name}: ${error}`);
				};
			};
		};
	} catch (error) {
		console.error(`Failed to clean old screen time files: ${error}`);
	} finally {
		try {
			enumerator?.close(null);
		} catch (error) {
			console.error(`Failed to close screen time directory enumerator: ${error}`);
		};
	};
};

function saveContext(context) {
	if (!context.loaded) {
		context.pendingSave = true;
		return;
	};

	context.pendingSave = false;
	saveJsonToFile(dayFilePath(context.date), {
		date: context.date,
		apps: Object.fromEntries(context.apps),
	});
};

export const screenTimeEngine = {
	_refCount: 0,
	_context: null,
	_loadCancellable: null,
	_focusedKey: null,
	_focusStartWall: null,
	_focusStartMonotonic: null,
	_tickId: 0,

	_saveThrottleId: 0,
	_listeners: new Set(),
	_retentionDays: DEFAULT_RETENTION_DAYS,

	setRetentionDays(days = DEFAULT_RETENTION_DAYS) {
		const parsed = Number(days);
		const value = Number.isFinite(parsed) && parsed > 0
			? Math.min(MAX_RETENTION_DAYS, Math.floor(parsed))
			: DEFAULT_RETENTION_DAYS;
		if (value === this._retentionDays) return;
		this._retentionDays = value;
		cleanupOldFiles(value);
	},

	acquire() {
		this._refCount++;
		if (this._refCount === 1) {
			this._start();
		};

		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.release();
		};
	},

	release() {
		if (this._refCount <= 0) return;
		this._refCount--;
		if (this._refCount === 0) {
			this._stop();
		};
	},

	addListener(callback) {
		if (typeof callback !== 'function') {
			return () => {};
		};
		this._listeners.add(callback);
		return () => this.removeListener(callback);
	},

	removeListener(callback) {
		this._listeners.delete(callback);
	},

	getTodayDate() {
		return this._context?.date ?? todayDateString();
	},

	getTodaySnapshot() {
		const context = this._context;
		return this._buildSnapshot(context?.date ?? todayDateString(), context?.apps ?? new Map());
	},

	loadDayAsync(day, callback) {
		if (!validDateString(day)) {
			callback(this._buildSnapshot(day, new Map()));
			return;
		};
		if (this._context?.date === day) {
			callback(this._buildSnapshot(day, this._context.apps));
			return;
		};
		this._loadRawAsync(day, apps => callback(this._buildSnapshot(day, apps)));
	},

	_loadRawAsync(day, callback) {
		loadJsonFromFileAsync(dayFilePath(day), data => callback(mapFromData(data, day)), this._loadCancellable);
	},

	_buildSnapshot(day, appsMap) {
		const hours = new Array(HOURS_PER_DAY).fill(0);
		const apps = [];
		let totalSeconds = 0;

		for (const [key, rawHours] of appsMap) {
			const appHours = cleanHours(rawHours);
			let appTotal = 0;
			for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
				appTotal += appHours[hour];
				hours[hour] += appHours[hour];
			};
			totalSeconds += appTotal;
			if (appTotal > 0) {
				apps.push({key, seconds: appTotal});
			};
		};

		apps.sort((a, b) => b.seconds - a.seconds);
		return {date: day, totalSeconds, apps, hours};
	},

	_start() {
		this._loadCancellable = new Gio.Cancellable();
		cleanupOldFiles(this._retentionDays);
		const today = todayDateString();
		if (!this._context || this._context.date !== today) {
			this._beginDate(today);
		};

		this._focusedKey = this._resolveFocusedKey();
		const nowWall = GLib.get_real_time();
		const nowMonotonic = GLib.get_monotonic_time();
		this._focusStartWall = this._focusedKey ? nowWall : null;
		this._focusStartMonotonic = this._focusedKey ? nowMonotonic : null;
		global.display.connectObject('notify::focus-window', () => this._onFocusChanged(), this);
		this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_INTERVAL_MS, () => {
			this._tick();
			return GLib.SOURCE_CONTINUE;
		});
	},

	_stop() {
		if (this._tickId) {
			GLib.Source.remove(this._tickId);
			this._tickId = 0;
		};
		global.display.disconnectObject(this);
		if (this._saveThrottleId) {
			GLib.Source.remove(this._saveThrottleId);
			this._saveThrottleId = 0;
		};

		this._flushFocused(GLib.get_real_time(), GLib.get_monotonic_time());
		if (this._context) {
			if (this._context.loaded) {
				saveContext(this._context);
			};
			this._context = null;
		};
		this._loadCancellable.cancel();
		this._loadCancellable = null;
		this._focusedKey = null;
		this._focusStartWall = null;
		this._focusStartMonotonic = null;
	},

	_beginDate(day) {
		if (this._context) {
			saveContext(this._context);
		};

		const context = {date: day, apps: new Map(), loaded: false, pendingSave: false};
		this._context = context;
		this._loadRawAsync(day, savedApps => {
			context.apps = mergeMaps(savedApps, context.apps);
			context.loaded = true;
			if (context.pendingSave) {
				saveContext(context);
			};
			if (this._context === context) {
				this._notifyListeners();
				if (this._refCount === 0) {
					this._context = null;
				};
			};
		});
	},

	_onFocusChanged() {
		const nowWall = GLib.get_real_time();
		const nowMonotonic = GLib.get_monotonic_time();
		this._flushFocused(nowWall, nowMonotonic);
		this._focusedKey = this._resolveFocusedKey();
		this._focusStartWall = this._focusedKey ? nowWall : null;
		this._focusStartMonotonic = this._focusedKey ? nowMonotonic : null;
	},

	_tick() {
		this._flushFocused(GLib.get_real_time(), GLib.get_monotonic_time());
		const today = todayDateString();
		if (this._context?.date !== today) {
			this._beginDate(today);
		};
		this._scheduleSave();
		this._notifyListeners();
	},

	_notifyListeners() {
		for (const callback of [...this._listeners]) {
			try {
				callback();
			} catch (error) {
				console.error(`Screen Time listener failed: ${error}`);
			};
		};
	},

	_flushFocused(nowWall, nowMonotonic) {
		if (!this._focusedKey || this._focusStartWall === null || this._focusStartMonotonic === null) return;

		const elapsed = Math.max(0, Math.min(
			MAX_ACCOUNT_INTERVAL_SECONDS * MICROSECONDS_PER_SECOND,
			nowMonotonic - this._focusStartMonotonic));
		const startWall = nowWall - elapsed;
		if (elapsed > 0) {
			this._recordInterval(this._focusedKey, startWall, nowWall);
		};
		this._focusStartWall = nowWall;
		this._focusStartMonotonic = nowMonotonic;
	},

	_recordInterval(appKey, startMicro, endMicro) {
		let cursor = startMicro;
		while (cursor < endMicro) {
			const epochSecond = Math.floor(cursor / MICROSECONDS_PER_SECOND);
			const segmentStart = GLib.DateTime.new_from_unix_local(epochSecond);
			const day = dateString(segmentStart);
			if (this._context?.date !== day) {
				this._beginDate(day);
			};

			const secondsIntoHour = segmentStart.get_minute() * 60 + segmentStart.get_second();
			const boundaryMicro = (epochSecond - secondsIntoHour + SECONDS_PER_HOUR) * MICROSECONDS_PER_SECOND;
			const segmentEnd = Math.min(endMicro, Math.max(cursor + 1, boundaryMicro));
			this._addSeconds(appKey, segmentStart.get_hour(), (segmentEnd - cursor) / MICROSECONDS_PER_SECOND);
			cursor = segmentEnd;
		};
	},

	_addSeconds(appKey, hour, seconds) {
		if (!this._context || !Number.isFinite(seconds) || seconds <= 0) return;
		let hours = this._context.apps.get(appKey);
		if (!hours) {
			hours = new Array(HOURS_PER_DAY).fill(0);
			this._context.apps.set(appKey, hours);
		};
		hours[hour] = Math.min(SECONDS_PER_HOUR, hours[hour] + seconds);
	},

	_resolveFocusedKey() {
		try {
			const focusedWindow = global.display.focus_window;
			if (!focusedWindow) {
				return null;
			};
			const app = Shell.WindowTracker.get_default().get_window_app(focusedWindow);
			return app?.get_id() || app?.get_name() || null;
		} catch (error) {
			console.debug(`Could not resolve focused application: ${error}`);
			return null;
		};
	},

	_scheduleSave() {
		if (this._saveThrottleId || !this._context) return;
		this._saveThrottleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_THROTTLE_MS, () => {
			this._saveThrottleId = 0;
			if (this._context) {
				saveContext(this._context);
			};
			return GLib.SOURCE_REMOVE;
		});
	},

	cleanup() {
		if (this._refCount > 0) {
			this._stop();
		};
		this._refCount = 0;
		this._listeners.clear();
		this._context = null;
		this._retentionDays = DEFAULT_RETENTION_DAYS;
	},
};
