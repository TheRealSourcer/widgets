/*
 * Per-widget runtime state persistence.
 *
 * Timer-like widgets (stopwatch/timer/pomodoro) hold their state in render
 * closures, so any rebuild (theme/style change, live refresh, relogin)
 * dropped it and reset the clocks. A small JSON file per widget instance
 * survives those rebuilds; a wall-clock timestamp lets a running timer
 * continue exactly where it was — even across GNOME session restarts.
 */

import GLib from 'gi://GLib';
import { getDataDir, isActorDestroyed, loadJsonFromFileAsync, saveJsonToFile, saveJsonToFileSync } from '../utils/ported.js';

export function widgetStatePath(kind, widget) {
	return GLib.build_filenamev([
		getDataDir(kind),
		`${kind}-${widget?.id ?? 'default'}.json`,
	]);
};

export function loadWidgetStateAsync(path, body, onLoaded) {
	loadJsonFromFileAsync(path, (saved) => {
		// Skip the restore if the widget died before the load landed.
		if (isActorDestroyed(body)) {
			return;
		};
		onLoaded(saved && typeof saved === 'object' ? saved : null);
	});
};

export function saveWidgetState(path, state) {
	saveJsonToFile(path, state);
};

// Flushed once just before the widget dies: synchronous, so a surprise
// teardown cannot race the write.
export function saveWidgetStateSync(path, state) {
	saveJsonToFileSync(path, state);
};

// A running timer memorizes its wall-clock lapse; the loader adds every
// millisecond that passed since then.
export function elapsedSinceWall(wallMs) {
	const now = Date.now();
	if (typeof wallMs !== 'number' || wallMs <= 0 || now <= wallMs) {
		return 0;
	};
	return now - wallMs;
};
