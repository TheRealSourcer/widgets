import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { bounceButton } from '../../lib/buttonBounce.js';
import { parseCssColor } from '../../utils/ported.js';
import {
	elapsedSinceWall,
	loadWidgetStateAsync,
	saveWidgetState,
	saveWidgetStateSync,
	widgetStatePath,
} from '../../lib/widgetState.js';

export const type = 'stopwatch';
export const label = 'Stopwatch';
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium'];

const TICK_INTERVAL_MS = 10; // 10ms for centiseconds

function formatTime(totalCentiseconds) {
	const totalSeconds = Math.floor(totalCentiseconds / 100);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const centiseconds = totalCentiseconds % 100;

	return {
		minutes: minutes.toString().padStart(2, '0'),
		seconds: seconds.toString().padStart(2, '0'),
		centiseconds: centiseconds.toString().padStart(2, '0'),
	};
}

/*
 * The whole clock lives in render-closure variables, so a theme or style
 * switch (every widget gets rebuilt) used to wipe a running stopwatch.
 * The per-instance JSON file survives those rebuilds — and the wall-clock
 * stamp even carries a running time across a GNOME relogin.
 */
function openStopwatchState({body, widget, isRunning, getCentiseconds, onRestore}) {
	const statePath = widgetStatePath('stopwatch', widget);

	const snapshot = () => ({
		centiseconds: getCentiseconds(),
		running: isRunning(),
		wall: Date.now(),
	});

	loadWidgetStateAsync(statePath, body, onRestore);

	return {
		// Called on control actions and, while running, about once a
		// second so the wall stamp stays fresh for surprise teardowns.
		persist: () => saveWidgetState(statePath, snapshot()),
		// Synchronous flush right before the widget is torn down.
		flush: () => saveWidgetStateSync(statePath, snapshot()),
	};
}

function accentColor(theme) {
	const accent = String(theme?.accent ?? '').trim();
	return accent || '#3584e4';
}

function textOnAccentColor(accent) {
	const { r, g, b } = parseCssColor(accent);
	const lum = 0.299 * r + 0.587 * g + 0.114 * b;
	return lum > 0.55 ? 'rgba(30,30,30,0.92)' : 'rgba(255,255,255,0.92)';
}

function renderSmallTimer({body, theme, sizeForWidget, widget}) {
	const textColor = theme.text;
	const mutedColor = theme.muted;
	const accentHex = accentColor(theme);
	const accentTextColor = textOnAccentColor(accentHex);
	const [totalWidth, totalHeight] = sizeForWidget(widget);
	const width = totalWidth - 34;
	const height = totalHeight - 34;
	const scale = Math.min(width / 180, height / 180);
	const px = (v) => Math.max(1, Math.round(v * scale));

	let centiseconds = 0;
	let isRunning = false;
	let timerId = null;
	let tickCount = 0;

	const state = openStopwatchState({body, widget,
		isRunning: () => isRunning,
		getCentiseconds: () => centiseconds,
		onRestore: (saved) => {
			if (typeof saved?.centiseconds === 'number' && saved.centiseconds > 0) {
				centiseconds = saved.centiseconds;
			}
			if (saved?.running) {
				// Add every wall-clock millisecond that passed since the
				// save, so the run continues exactly where it was.
				centiseconds += Math.round(elapsedSinceWall(saved.wall) / 10);
				updateDisplay();
				if (!isRunning) {
					startTimer();
				}
			} else {
				updateDisplay();
			}
		},
	});

	const mainBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(12)}px;`,
	});

	body.add_child(mainBox);

	// Time display - vertical stack for 1x1
	const timeBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(4)}px;`,
	});

	// Minutes:Seconds (no centiseconds for the small widget)
	const timeLabel = new St.Label({
		text: '00:00',
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(42)}px; font-weight: 700;`,
	});

	const timeCaption = new St.Label({
		text: _('Min : Sec'),
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${mutedColor}; font-size: ${px(20)}px; font-weight: 600;`,
	});

	timeBox.add_child(timeLabel);
	timeBox.add_child(timeCaption);
	mainBox.add_child(timeBox);

	// Buttons - horizontal for small widget
	const buttonsBox = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(6)}px;`,
	});

	const pauseBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'media-playback-start-symbolic',
			icon_size: px(20),
			style: `color: ${accentTextColor};`,
		}),
		style: `padding: ${px(8)}px ${px(16)}px; border-radius: ${px(8)}px; background-color: ${accentHex};`,
	});

	const resetBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: new St.Icon({
			icon_name: 'view-refresh-symbolic',
			icon_size: px(20),
			style: `color: ${textColor};`,
		}),
		style: `padding: ${px(8)}px ${px(16)}px; border-radius: ${px(8)}px; background-color: transparent; border: 1px solid rgba(255, 255, 255, 0.2);`,
	});

	buttonsBox.add_child(pauseBtn);
	buttonsBox.add_child(resetBtn);
	mainBox.add_child(buttonsBox);

	const updateDisplay = () => {
		const time = formatTime(centiseconds);
		timeLabel.set_text(`${time.minutes}:${time.seconds}`);
	};

	const startTimer = () => {
		if (isRunning) return;
		isRunning = true;
		timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_INTERVAL_MS, () => {
			centiseconds++;
			updateDisplay();
			// Keep the wall stamp fresh (≤ ~1s stale) for surprise teardowns.
			if (++tickCount % 100 === 0) {
				state.persist();
			}
			return GLib.SOURCE_CONTINUE;
		});
		state.persist();
		pauseBtn.child.icon_name = 'media-playback-pause-symbolic';
	};

	const stopTimer = () => {
		if (!isRunning) return;
		isRunning = false;
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
		state.persist();
		pauseBtn.child.icon_name = 'media-playback-start-symbolic';
	};

	const resetTimer = () => {
		stopTimer();
		centiseconds = 0;
		updateDisplay();
		state.persist();
	};

	pauseBtn.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		}
		bounceButton(pauseBtn);
		if (isRunning) {
			stopTimer();
		} else {
			startTimer();
		}
		return Clutter.EVENT_STOP;
	});

	resetBtn.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		}
		bounceButton(resetBtn);
		resetTimer();
		return Clutter.EVENT_STOP;
	});

	body.connect('destroy', () => {
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
		// Exact snapshot for in-process rebuilds and logout marathons.
		state.flush();
	});

	updateDisplay();
}

function renderMediumTimer({body, theme, sizeForWidget, widget}) {
	const textColor = theme.text;
	const mutedColor = theme.muted;
	const accentHex = accentColor(theme);
	const accentTextColor = textOnAccentColor(accentHex);
	const [width, height] = sizeForWidget(widget);
	const contentW = width - 34;
	const contentH = height - 34;
	const scale = Math.min(contentW / 540, contentH / 200);
	const px = (v) => Math.max(1, Math.round(v * scale));

	let centiseconds = 0;
	let isRunning = false;
	let timerId = null;
	let tickCount = 0;

	const state = openStopwatchState({body, widget,
		isRunning: () => isRunning,
		getCentiseconds: () => centiseconds,
		onRestore: (saved) => {
			if (typeof saved?.centiseconds === 'number' && saved.centiseconds > 0) {
				centiseconds = saved.centiseconds;
			}
			if (saved?.running) {
				// Add every wall-clock millisecond that passed since the
				// save, so the run continues exactly where it was.
				centiseconds += Math.round(elapsedSinceWall(saved.wall) / 10);
				updateDisplay();
				if (!isRunning) {
					startTimer();
				}
			} else {
				updateDisplay();
			}
		},
	});

	const mainBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(24)}px;`,
	});

	body.add_child(mainBox);

	// Time display container
	const timeBox = new St.BoxLayout({
		orientation: Clutter.Orientation.HORIZONTAL,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(8)}px;`,
	});

	// Minutes
	const minutesBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(4)}px;`,
	});

	const minutesLabel = new St.Label({
		text: '00',
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(64)}px; font-weight: 700;`,
	});

	const minutesCaption = new St.Label({
		text: _('Minutes'),
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${mutedColor}; font-size: ${px(20)}px; font-weight: 600;`,
	});

	minutesBox.add_child(minutesLabel);
	minutesBox.add_child(minutesCaption);

	// Separator :
	const separator1 = new St.Label({
		text: ':',
		y_align: Clutter.ActorAlign.START,
		style: `color: ${textColor}; font-size: ${px(64)}px; font-weight: 700; margin-top: ${px(-8)}px;`,
	});

	// Seconds
	const secondsBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(4)}px;`,
	});

	const secondsLabel = new St.Label({
		text: '00',
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(64)}px; font-weight: 700;`,
	});

	const secondsCaption = new St.Label({
		text: _('Seconds'),
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${mutedColor}; font-size: ${px(20)}px; font-weight: 600;`,
	});

	secondsBox.add_child(secondsLabel);
	secondsBox.add_child(secondsCaption);

	// Separator :
	const separator2 = new St.Label({
		text: ':',
		y_align: Clutter.ActorAlign.START,
		style: `color: ${textColor}; font-size: ${px(64)}px; font-weight: 700; margin-top: ${px(-8)}px;`,
	});

	// Centiseconds
	const centisecondsBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(4)}px;`,
	});

	const centisecondsLabel = new St.Label({
		text: '00',
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(64)}px; font-weight: 700;`,
	});

	const centisecondsCaption = new St.Label({
		text: _('Centiseconds'),
		x_align: Clutter.ActorAlign.CENTER,
		style: `color: ${mutedColor}; font-size: ${px(23)}px; font-weight: 600;`,
	});

	centisecondsBox.add_child(centisecondsLabel);
	centisecondsBox.add_child(centisecondsCaption);

	timeBox.add_child(minutesBox);
	timeBox.add_child(separator1);
	timeBox.add_child(secondsBox);
	timeBox.add_child(separator2);
	timeBox.add_child(centisecondsBox);

	mainBox.add_child(timeBox);

	// Buttons
	const buttonsBox = new St.BoxLayout({
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(12)}px;`,
	});

	const pauseBtn = new St.Button({
		reactive: true,
		can_focus: true,
		x_expand: false,
		child: new St.Label({
			text: _('Start'),
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
		}),
		style: `font-size: ${px(19)}px; padding: ${px(12)}px ${px(32)}px; border-radius: ${px(12)}px; background-color: ${accentHex}; color: ${accentTextColor}; font-weight: 600;`,
	});

	const resetBtn = new St.Button({
		reactive: true,
		can_focus: true,
		x_expand: false,
		child: new St.Label({
			text: _('Reset'),
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
		}),
		style: `font-size: ${px(19)}px; padding: ${px(12)}px ${px(32)}px; border-radius: ${px(12)}px; background-color: transparent; border: 1px solid rgba(255, 255, 255, 0.2); color: ${textColor}; font-weight: 600;`,
	});

	buttonsBox.add_child(pauseBtn);
	buttonsBox.add_child(resetBtn);
	mainBox.add_child(buttonsBox);

	const updateDisplay = () => {
		const time = formatTime(centiseconds);
		minutesLabel.set_text(time.minutes);
		secondsLabel.set_text(time.seconds);
		centisecondsLabel.set_text(time.centiseconds);
	};

	const startTimer = () => {
		if (isRunning) return;
		isRunning = true;
		timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_INTERVAL_MS, () => {
			centiseconds++;
			updateDisplay();
			// Keep the wall stamp fresh (≤ ~1s stale) for surprise teardowns.
			if (++tickCount % 100 === 0) {
				state.persist();
			}
			return GLib.SOURCE_CONTINUE;
		});
		state.persist();
		pauseBtn.child.text = _('Pause');
		pauseBtn.style = `font-size: ${px(19)}px; padding: ${px(12)}px ${px(32)}px; border-radius: ${px(12)}px; background-color: ${accentHex}; color: ${accentTextColor}; font-weight: 600;`;
	};

	const stopTimer = () => {
		if (!isRunning) return;
		isRunning = false;
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
		state.persist();
		pauseBtn.child.text = _('Start');
		pauseBtn.style = `font-size: ${px(19)}px; padding: ${px(12)}px ${px(32)}px; border-radius: ${px(12)}px; background-color: ${accentHex}; color: ${accentTextColor}; font-weight: 600;`;
	};

	const resetTimer = () => {
		stopTimer();
		centiseconds = 0;
		updateDisplay();
		state.persist();
	};

	pauseBtn.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		}
		bounceButton(pauseBtn);
		if (isRunning) {
			stopTimer();
		} else {
			startTimer();
		}
		return Clutter.EVENT_STOP;
	});

	resetBtn.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		}
		bounceButton(resetBtn);
		resetTimer();
		return Clutter.EVENT_STOP;
	});

	body.connect('destroy', () => {
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
		// Exact snapshot for in-process rebuilds and logout marathons.
		state.flush();
	});

	updateDisplay();
}

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border};`;
}

export function render({body, theme, sizeForWidget, widget}) {
	const sizeKey = widget?.size ?? 'medium';

	if (sizeKey === 'small') {
		renderSmallTimer({body, theme, sizeForWidget, widget});
	} else {
		renderMediumTimer({body, theme, sizeForWidget, widget});
	}
}
