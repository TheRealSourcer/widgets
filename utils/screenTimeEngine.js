import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import { warn } from '../logger.js';

// Desktop-widgets screen time engine: tracks focused windows and accumulates
// per-app, per-hour seconds. Persists one JSON file per day.

const TICK_INTERVAL_MS = 2000;
const SAVE_THROTTLE_MS = 15000;
const MICROSECONDS_PER_SECOND = 1000000;
const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;
const DEFAULT_RETENTION_DAYS = 30; // Keep data for this many days by default

// Pseudo entry crediting unlocked desktop time (wallpaper, overview,
// widgets) when no window holds focus. Locked screens never count.
const DESKTOP_APP_KEY = 'desktop@shell-session';

function getDataDir() {
	const userDataDir = GLib.get_user_data_dir();
	const dir = GLib.build_filenamev([userDataDir, 'desktop-widgets', 'screen-time']);
	GLib.mkdir_with_parents(dir, 0o755);
	return dir;
}

function todayDateString() {
	const now = GLib.DateTime.new_now_local();
	return `${now.get_year()}-${String(now.get_month()).padStart(2, '0')}-${String(now.get_day_of_month()).padStart(2, '0')}`;
}

function dayFilePath(dateString) {
	return GLib.build_filenamev([getDataDir(), `${dateString}.json`]);
}

function cleanupOldFiles(retentionDays) {
	const dir = getDataDir();
	const cutoff = GLib.DateTime.new_now_local().add_days(-retentionDays);
	const cutoffDate = `${cutoff.get_year()}-${String(cutoff.get_month()).padStart(2, '0')}-${String(cutoff.get_day_of_month()).padStart(2, '0')}`;
	const dirFile = Gio.File.new_for_path(dir);

	// Enumerate asynchronously so startup and midnight rollover don't block the UI thread.
	dirFile.enumerate_children_async(
		'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null,
		(source, result) => {
			let enumerator;
			try {
				enumerator = source.enumerate_children_finish(result);
			} catch (e) {
				// Directory may not exist yet — that's fine.
				return;
			}

			const deleteNext = () => {
				enumerator.next_files_async(10, GLib.PRIORITY_LOW, null, (src, res) => {
					let infos;
					try {
						infos = src.next_files_finish(res);
					} catch (e) {
						warn('screen-time-cleanup', `Error iterating screen time files: ${e.message}`);
						enumerator.close_async(GLib.PRIORITY_LOW, null, null);
						return;
					}

					if (infos.length === 0) {
						enumerator.close_async(GLib.PRIORITY_LOW, null, null);
						return;
					}

					for (const info of infos) {
						const name = info.get_name();
						const match = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
						if (match && match[1] < cutoffDate) {
							dirFile.get_child(name).delete_async(GLib.PRIORITY_LOW, null, (_f, r) => {
								try { _f.delete_finish(r); } catch (e) {
									warn('screen-time-cleanup', `Failed to delete old screen time file ${name}: ${e.message}`);
								}
							});
						}
					}

					deleteNext();
				});
			};

			deleteNext();
		},
	);
}

function loadJsonFromFileAsync(filePath, callback) {
	const file = Gio.File.new_for_path(filePath);
	file.load_contents_async(null, (source, result) => {
		try {
			const [ok, contents] = source.load_contents_finish(result);
			if (ok) {
				const data = JSON.parse(new TextDecoder('utf-8').decode(contents));
				callback(data);
			} else {
				callback(null);
			}
		} catch (e) {
			callback(null);
		}
	});
}

function saveJsonToFile(filePath, data) {
	try {
		const dir = GLib.path_get_dirname(filePath);
		GLib.mkdir_with_parents(dir, 0o755);
		const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
		Gio.File.new_for_path(filePath).replace_contents_bytes_async(
			GLib.Bytes.new(bytes), null, false, Gio.FileCreateFlags.NONE, null,
			(file, result) => {
				try {
					file.replace_contents_finish(result);
				} catch (e) {
					warn('screen-time-save', `Failed to save screen time data: ${e.message}`);
				}
			});
	} catch (e) {
		warn('screen-time-save', `Failed to save screen time data: ${e.message}`);
	}
}

export const screenTimeEngine = {
	_refCount: 0,
	_appHours: new Map(),
	_focusedKey: null,
	_focusStartMicro: null,
	_currentDate: null,
	_tickId: 0,
	_focusSignalId: 0,
	_saveThrottleId: 0,
	_listeners: new Set(),
	_retentionDays: DEFAULT_RETENTION_DAYS,
	_paused: false,

	/** Sets how many days of history to keep; older files are cleaned up on next start/rollover. */
	setRetentionDays(days) {
		const value = Math.max(1, Math.floor(Number(days) || DEFAULT_RETENTION_DAYS));
		if (value === this._retentionDays) return;
		this._retentionDays = value;
		cleanupOldFiles(this._retentionDays);
	},

	/** Pause/resume screen time tracking (e.g., when fullscreen or screen locked). */
	setPaused(paused) {
		if (this._paused === paused) return;
		this._paused = paused;

		const now = GLib.get_real_time();

		if (paused) {
			// Keep the current focus and elapsed time while paused
			this._flushFocused(now);
			this._saveNow();
		} else {
			// Resume: re-anchor the focus start so the paused stretch
			// (fullscreen / locked — not screen time) is not credited to the
			// focused app on the next flush. The next tick re-resolves focus.
			this._focusStartMicro = now;
		}
	},

	acquire() {
		this._refCount++;
		if (this._refCount === 1) this._start();
		return () => this.release();
	},

	release() {
		if (this._refCount === 0) return;
		this._refCount--;
		if (this._refCount === 0) this._stop();
	},

	addListener(callback) {
		this._listeners.add(callback);
	},

	removeListener(callback) {
		this._listeners.delete(callback);
	},

	getTodayDate() {
		return this._currentDate;
	},

	getTodaySnapshot() {
		return this._buildSnapshot(this._currentDate, this._appHours);
	},

	loadDayAsync(dateString, callback) {
		this._loadRawAsync(dateString, (appsMap) => {
			callback(this._buildSnapshot(dateString, appsMap));
		});
	},

	_loadRawAsync(dateString, callback) {
		loadJsonFromFileAsync(dayFilePath(dateString), (data) => {
			const appsMap = new Map();
			if (data && typeof data.apps === 'object') {
				for (const [key, hours] of Object.entries(data.apps)) {
					if (Array.isArray(hours))
						appsMap.set(key, hours.slice(0, HOURS_PER_DAY));
				}
			}
			callback(appsMap);
		});
	},

	_buildSnapshot(dateString, appsMap) {
		const hoursAggregate = new Array(HOURS_PER_DAY).fill(0);
		// Per-hour dominant app (null where the hour has no activity) — the
		// widgets color hour buckets and legends after it.
		const hourKeys = new Array(HOURS_PER_DAY).fill(null);
		const hourPeak = new Array(HOURS_PER_DAY).fill(0);
		const apps = [];
		let totalSeconds = 0;

		for (const [key, hours] of appsMap) {
			let appTotal = 0;
			for (let hour = 0; hour < hours.length; hour++) {
				const bucket = hours[hour] || 0;
				appTotal += bucket;
				hoursAggregate[hour] += bucket;
				if (bucket > hourPeak[hour]) {
					hourPeak[hour] = bucket;
					hourKeys[hour] = key;
				}
			}
			totalSeconds += appTotal;
			if (appTotal > 0)
				apps.push({ key, seconds: appTotal });
		}

		apps.sort((a, b) => b.seconds - a.seconds);
		return { date: dateString, totalSeconds, apps, hours: hoursAggregate, hourKeys };
	},

	_start() {
		this._currentDate = todayDateString();
		cleanupOldFiles(this._retentionDays);
		this._focusedKey = this._resolveFocusedKey();
		this._focusStartMicro = this._focusedKey ? GLib.get_real_time() : null;
		this._focusSignalId = global.display.connect('notify::focus-window', () => this._onFocusChanged());
		this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_INTERVAL_MS, () => {
			this._tick();
			return GLib.SOURCE_CONTINUE;
		});

		const loadDate = this._currentDate;
		this._loadRawAsync(loadDate, (loadedMap) => {
			if (this._refCount === 0 || this._currentDate !== loadDate)
				return;
			for (const [key, hours] of loadedMap) {
				if (!this._appHours.has(key))
					this._appHours.set(key, hours);
			}
		});
	},

	_stop() {
		if (this._tickId) {
			GLib.Source.remove(this._tickId);
			this._tickId = 0;
		}
		if (this._focusSignalId) {
			global.display.disconnect(this._focusSignalId);
			this._focusSignalId = 0;
		}
		this._flushFocused(GLib.get_real_time());
		this._saveNow();
		this._appHours.clear();
		this._listeners.clear();
		this._focusedKey = null;
		this._focusStartMicro = null;
		// A stopped engine must not wake up still paused: the next widget to
		// acquire it defines its own pause state.
		this._paused = false;
	},

	_onFocusChanged() {
		const now = GLib.get_real_time();
		this._flushFocused(now);
		this._focusedKey = this._resolveFocusedKey();
		this._focusStartMicro = this._focusedKey ? now : null;
	},

	_tick() {
		// Skip ticks while paused (e.g. a fullscreen window)
		if (this._paused) {
			return;
		}

		const now = GLib.get_real_time();
		// Re-resolve every tick: transitions the focus signal cannot see
		// (lock/unlock, desktop <-> null focus) otherwise stick until the
		// next real focus change and those stretches went uncounted.
		const resolved = this._resolveFocusedKey();
		if (resolved !== this._focusedKey) {
			this._flushFocused(now);
			this._focusedKey = resolved;
			this._focusStartMicro = resolved ? now : null;
		} else {
			this._flushFocused(now);
		}
		this._maybeRollover();
		this._scheduleSave();
		for (const callback of this._listeners)
			callback();
	},

	_maybeRollover() {
		const today = todayDateString();
		if (today === this._currentDate) return;
		this._saveNow();
		this._currentDate = today;
		this._appHours.clear();
		cleanupOldFiles(this._retentionDays);
	},

	_flushFocused(nowMicro) {
		if (!this._focusedKey || this._focusStartMicro === null) return;

		let cursor = this._focusStartMicro;
		while (cursor < nowMicro) {
			const epochSecond = Math.floor(cursor / MICROSECONDS_PER_SECOND);
			const segmentStart = GLib.DateTime.new_from_unix_local(epochSecond);
			const secondsIntoHour = segmentStart.get_minute() * 60 + segmentStart.get_second();

			// Rollover happens per-SEGMENT, not per-flush: a flush spanning
			// midnight must credit the pre-midnight hour to the old day's
			// file (the rollover is what switches the in-memory map, so doing
			// it first would write hour 23 of yesterday into today's file).
			const segmentDate = `${segmentStart.get_year()}-${String(segmentStart.get_month()).padStart(2, '0')}-${String(segmentStart.get_day_of_month()).padStart(2, '0')}`;
			if (segmentDate !== this._currentDate) {
				this._saveNow();
				this._currentDate = segmentDate;
				this._appHours.clear();
				cleanupOldFiles(this._retentionDays);
			}

			const boundaryEpochSecond = epochSecond - secondsIntoHour + SECONDS_PER_HOUR;
			const cursorEnd = Math.min(nowMicro, boundaryEpochSecond * MICROSECONDS_PER_SECOND);
			const seconds = Math.floor((cursorEnd - cursor) / MICROSECONDS_PER_SECOND);
			if (seconds > 0)
				this._addSeconds(this._focusedKey, segmentStart.get_hour(), seconds);

			cursor = cursorEnd;
		}
		this._focusStartMicro = nowMicro;
	},

	_addSeconds(appKey, hour, seconds) {
		let hours = this._appHours.get(appKey);
		if (!hours) {
			hours = new Array(HOURS_PER_DAY).fill(0);
			this._appHours.set(appKey, hours);
		}
		hours[hour] += seconds;
	},

	_resolveFocusedKey() {
		const focusedWindow = global.display.focus_window;

		if (focusedWindow) {
			const app = Shell.WindowTracker.get_default().get_window_app(focusedWindow);
			if (app) {
				const key = app.get_id() || app.get_name();
				if (key) return key;
			}
			return null;
		}

		// No window holds focus, yet the session is on: the user lives on the
		// desktop (wallpaper widgets, overview) — that time is real screen
		// time too. The previously un-credited stretches were the main reason
		// the widget showed less time than actually spent. The locked screen
		// stays exempt.
		if (global.sessionMode?.isLocked) return null;
		return DESKTOP_APP_KEY;
	},

	_scheduleSave() {
		if (this._saveThrottleId) return;
		this._saveThrottleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_THROTTLE_MS, () => {
			this._saveThrottleId = 0;
			this._saveNow();
			return GLib.SOURCE_REMOVE;
		});
	},

	_saveNow() {
		if (this._saveThrottleId) {
			GLib.Source.remove(this._saveThrottleId);
			this._saveThrottleId = 0;
		}
		saveJsonToFile(dayFilePath(this._currentDate), {
			date: this._currentDate,
			apps: Object.fromEntries(this._appHours),
		});
	},
};
