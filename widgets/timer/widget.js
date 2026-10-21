/*
 * Timer widget (Countdown Timer)
 * Countdown timer with manual time adjustment and clean running view
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { attachBounce } from '../../lib/buttonBounce.js';
import { widgetResourcePath } from '../../paths.js';
import { parseCssColor } from '../../utils/ported.js';
import {
	elapsedSinceWall,
	loadWidgetStateAsync,
	saveWidgetState,
	saveWidgetStateSync,
	widgetStatePath,
} from '../../lib/widgetState.js';

export const type = 'timer';
export const label = 'Timer';
export const defaultSize = 'medium';
export const supportedSizes = ['medium'];

const TICK_INTERVAL_MS = 100;

function formatTime(seconds) {
	const mins = Math.floor(seconds / 60);
	const secs = Math.floor(seconds % 60);
	return {
		minutes: mins.toString().padStart(2, '0'),
		seconds: secs.toString().padStart(2, '0'),
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

// Control glyphs come from the shared music icon set (icons/widgets_settings/
// music/dw-<name>.svg, with -black/-white variants for painting on light or
// dark surfaces). Same files, same look as the music widget's buttons.
function controlIcon(iconName, suffix = '') {
	const file = widgetResourcePath('music', `dw-${iconName}${suffix}.svg`);

	return file && Gio.File.new_for_path(file).query_exists(null)
		? Gio.FileIcon.new(Gio.File.new_for_path(file))
		: null;
}

function iconOnAccentSuffix(accent) {
	// Same luminance rule as textOnAccentColor: a light accent surface takes
	// the black glyph, a dark one the white glyph.
	const { r, g, b } = parseCssColor(accent);
	const lum = 0.299 * r + 0.587 * g + 0.114 * b;
	return lum > 0.55 ? '-black' : '-white';
}

// Bundled dw glyph with the symbolic icon as a fallback so the button never
// paints empty if the SVG file is missing.
function dwControlIcon(iconName, suffix, size, fallbackName, fallbackColor) {
	const icon = new St.Icon({ icon_size: size });
	const gicon = controlIcon(iconName, suffix);

	if (gicon) {
		icon.gicon = gicon;
	} else {
		icon.icon_name = fallbackName;
		icon.style = `color: ${fallbackColor};`;
	};

	return icon;
}

// Ghost controls read against the surface: the white wash was invisible
// on light cards, so light mode draws an ink wash plus a visible outline;
// dark keeps the tuned look.
function ghostBorderColor(theme) {
	return theme?.dark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.18)';
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

	let totalSeconds = 0;
	let remainingSeconds = 0;
	let isRunning = false;
	let timerId = null;
	let tickCount = 0;

	/*
	 * The countdown lives in render-closure variables, so a theme or style
	 * switch (every widget gets rebuilt) used to wipe a running timer.
	 * The per-instance JSON file survives those rebuilds — and the
	 * wall-clock stamp even carries a running countdown across a
	 * GNOME relogin.
	 */
	const statePath = widgetStatePath('timer', widget);

	const snapshot = () => ({
		seconds: remainingSeconds,
		totalSeconds,
		running: isRunning,
		wall: Date.now(),
	});

	const saveState = () => saveWidgetState(statePath, snapshot());
	const flushState = () => saveWidgetStateSync(statePath, snapshot());

	loadWidgetStateAsync(statePath, body, (saved) => {
		const savedSeconds = typeof saved?.seconds === 'number' ? saved.seconds : 0;
		if (savedSeconds <= 0) {
			return;
		}
		// A running countdown keeps ticking from wall-clock truth.
		remainingSeconds = saved.running
			? Math.max(0, savedSeconds - elapsedSinceWall(saved.wall) / 1000)
			: savedSeconds;
		totalSeconds = typeof saved?.totalSeconds === 'number' && saved.totalSeconds > 0
			? saved.totalSeconds
			: remainingSeconds;
		updateDisplay();
		if (saved.running && remainingSeconds > 0 && !isRunning) {
			startTimer();
		}
	});

	const container = new St.Widget({
		x_expand: true,
		y_expand: true,
		layout_manager: new Clutter.BinLayout(),
	});
	body.add_child(container);

	// Setup view (when not running)
	const setupBox = new St.BoxLayout({
		orientation: Clutter.Orientation.HORIZONTAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(24)}px; padding: ${px(16)}px;`,
	});
	container.add_child(setupBox);

	// Left: circular progress
	const leftBox = new St.Widget({
		width: px(120),
		height: px(120),
		layout_manager: new Clutter.BinLayout(),
	});
	setupBox.add_child(leftBox);

	const circleSize = px(120);
	const setupCircleCanvas = new St.DrawingArea({
		width: circleSize,
		height: circleSize,
	});
	leftBox.add_child(setupCircleCanvas);

	const setupCircleTimeLabel = new St.Label({
		text: '00:00',
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(24)}px; font-weight: 700;`,
	});
	leftBox.add_child(setupCircleTimeLabel);

	// Center: big time with +/- controls
	const centerBox = new St.BoxLayout({
		orientation: Clutter.Orientation.HORIZONTAL,
		x_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(8)}px;`,
	});
	setupBox.add_child(centerBox);

	// Stepper columns. Ubuntu digits are tabular (measured: two digits at
	// 72px bold = exactly 80px), so every row gets one exact width: the
	// digits slot is 88px (80 ink + 4px padding each side) and the button
	// rows are 42 + 4 + 42 = 88px. Zero slack anywhere means the GNOME 51
	// BoxLayout cross-axis rule (children get full cross width, x_align
	// ignored) cannot misplace anything — all three rows align by design.
	const buildStepper = () => {
		const makeRowButton = (text, big) => new St.Button({
			reactive: true,
			can_focus: true,
			child: new St.Label({ text, style: `color: ${textColor};` }),
			style: `font-size: ${px(big ? 20 : 16)}px; width: ${px(42)}px; height: ${px(big ? 36 : 32)}px; ` +
				(theme.dark
					? `background-color: rgba(255, 255, 255, ${big ? 0.1 : 0.08}); `
					: `background-color: rgba(0, 0, 0, 0.05); border: 1px solid ${ghostBorderColor(theme)}; `) +
				`border-radius: ${px(big ? 10 : 8)}px; font-weight: 700;`,
		});

		const plusRow = new St.BoxLayout({ style: `spacing: ${px(4)}px;` });
		const plus10Btn = makeRowButton('+', true);
		const plus1Btn = makeRowButton('+', false);
		plusRow.add_child(plus10Btn);
		plusRow.add_child(plus1Btn);

		// Fixed slot == the rows' width, and the height is the digits' INK
		// height: measured Ubuntu Bold 72px paints an 54px-tall ink inside a
		// 73px font box (1px above, 18px below), so the box is forced to 54
		// and the residual 1px offset is cancelled with a paint-only nudge.
		// font-family is pinned (inherited theme fonts drift off center) and
		// a symmetric 4px horizontal padding centers the 80px ink in the slot.
		const label = new St.Label({
			text: '00',
			x_align: Clutter.ActorAlign.CENTER,
			style: `color: ${textColor}; font-family: Ubuntu; font-size: ${px(72)}px; font-weight: 700; padding: 0 ${px(4)}px; width: ${px(88)}px; height: ${px(54)}px;`,
		});
		label.translation_y = -px(1);

		const minusRow = new St.BoxLayout({ style: `spacing: ${px(4)}px;` });
		const minus10Btn = makeRowButton('−', true);
		const minus1Btn = makeRowButton('−', false);
		minusRow.add_child(minus10Btn);
		minusRow.add_child(minus1Btn);

		const column = new St.BoxLayout({
			orientation: Clutter.Orientation.VERTICAL,
			x_align: Clutter.ActorAlign.CENTER,
			style: `spacing: ${px(10)}px;`,
		});
		column.add_child(plusRow);
		column.add_child(label);
		column.add_child(minusRow);

		return { column, plus10Btn, plus1Btn, minus10Btn, minus1Btn, label };
	};

	const {
		column: minutesBox,
		plus10Btn: minutesPlus10Btn,
		plus1Btn: minutesPlus1Btn,
		minus10Btn: minutesMinus10Btn,
		minus1Btn: minutesMinus1Btn,
		label: minutesLabel,
	} = buildStepper();
	centerBox.add_child(minutesBox);

	// Colon. Paint-only nudge: the ':' glyph's ink sits a couple of px right
	// of the midpoint between the two digit groups, so shift the painting
	// only — translation does not touch the layout (same trick as the
	// system-widget icon alignment).
	const colonLabel = new St.Label({
		text: ':',
		y_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(72)}px; font-weight: 700;`,
	});
	colonLabel.translation_x = -px(3);
	centerBox.add_child(colonLabel);

	const {
		column: secondsBox,
		plus10Btn: secondsPlus10Btn,
		plus1Btn: secondsPlus1Btn,
		minus10Btn: secondsMinus10Btn,
		minus1Btn: secondsMinus1Btn,
		label: secondsLabel,
	} = buildStepper();
	centerBox.add_child(secondsBox);

	// Right: Play button (in setup view)
	const setupRightBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.END,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(12)}px;`,
	});

	const startBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: dwControlIcon('play', iconOnAccentSuffix(accentHex), px(34),
			'media-playback-start-symbolic', accentTextColor),
		style: `padding: ${px(18)}px; border-radius: 999px; background-color: ${accentHex};`,
	});
	setupRightBox.add_child(startBtn);

	setupBox.add_child(setupRightBox);

	// Running view (when timer is running)
	const runningBox = new St.BoxLayout({
		orientation: Clutter.Orientation.HORIZONTAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(32)}px; padding: ${px(16)}px;`,
		visible: false,
	});
	container.add_child(runningBox);

	// Left: circular progress (running)
	const runningLeftBox = new St.Widget({
		width: px(140),
		height: px(140),
		layout_manager: new Clutter.BinLayout(),
	});
	runningBox.add_child(runningLeftBox);

	const runningCircleSize = px(140);
	const runningCircleCanvas = new St.DrawingArea({
		width: runningCircleSize,
		height: runningCircleSize,
	});
	runningLeftBox.add_child(runningCircleCanvas);

	const runningCircleTimeLabel = new St.Label({
		text: '00:00',
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(28)}px; font-weight: 700;`,
	});
	runningLeftBox.add_child(runningCircleTimeLabel);

	// Big time display (center)
	const runningTimeLabel = new St.Label({
		text: '00:00',
		x_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${px(72)}px; font-weight: 700; line-height: 0.9;`,
	});
	runningBox.add_child(runningTimeLabel);

	// Right: Pause and Stop buttons
	const runningRightBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.END,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${px(12)}px;`,
	});

	const pauseBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: dwControlIcon('pause', iconOnAccentSuffix(accentHex), px(38),
			'media-playback-pause-symbolic', accentTextColor),
		style: `padding: ${px(20)}px; border-radius: 999px; background-color: ${accentHex}; border: ${px(3)}px solid rgba(255, 255, 255, 0.2);`,
	});
	runningRightBox.add_child(pauseBtn);

	const stopBtn = new St.Button({
		reactive: true,
		can_focus: true,
		child: dwControlIcon('stop', theme?.dark ? '-white' : '-black', px(38),
			'media-playback-stop-symbolic', textColor),
		style: `padding: ${px(18)}px; border-radius: 999px; background-color: rgba(255, 255, 255, 0.12); border: ${px(3)}px solid rgba(255, 255, 255, 0.3);`,
	});
	runningRightBox.add_child(stopBtn);

	runningBox.add_child(runningRightBox);

	let progress = 0;

	const drawCircle = (canvas) => {
		const ctx = canvas.get_context();
		const [w, h] = canvas.get_surface_size();
		const centerX = w / 2;
		const centerY = h / 2;
		const lineWidth = canvas === runningCircleCanvas ? px(10) : px(8);
		const radius = Math.min(w, h) / 2 - lineWidth;

		// Background circle
		ctx.setSourceRGBA(0.5, 0.5, 0.5, 0.2);
		ctx.setLineWidth(lineWidth);
		ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
		ctx.stroke();

		// Progress arc
		if (progress > 0) {
			const accentRgb = parseCssColor(accentHex);
			ctx.setSourceRGBA(accentRgb.r, accentRgb.g, accentRgb.b, 1.0);
			ctx.setLineWidth(lineWidth);
			ctx.setLineCap(1);
			const startAngle = -Math.PI / 2;
			const endAngle = startAngle + (2 * Math.PI * progress);
			ctx.arc(centerX, centerY, radius, startAngle, endAngle);
			ctx.stroke();
		}

		ctx.$dispose();
	};

	setupCircleCanvas.connect('repaint', (canvas) => drawCircle(canvas));
	runningCircleCanvas.connect('repaint', (canvas) => drawCircle(canvas));

	const updateDisplay = () => {
		const time = formatTime(remainingSeconds);
		minutesLabel.set_text(time.minutes);
		secondsLabel.set_text(time.seconds);
		setupCircleTimeLabel.set_text(`${time.minutes}:${time.seconds}`);
		runningCircleTimeLabel.set_text(`${time.minutes}:${time.seconds}`);
		runningTimeLabel.set_text(`${time.minutes}:${time.seconds}`);
		
		if (totalSeconds > 0) {
			progress = Math.max(0, Math.min(1, remainingSeconds / totalSeconds));
		} else {
			progress = 0;
		}
		
		setupCircleCanvas.queue_repaint();
		runningCircleCanvas.queue_repaint();

		// Show/hide views based on running state
		if (isRunning) {
			setupBox.visible = false;
			runningBox.visible = true;
		} else {
			setupBox.visible = true;
			runningBox.visible = false;
		}
	};

	const setTimer = (seconds) => {
		if (!isRunning) {
			totalSeconds = Math.max(0, Math.min(5999, seconds));
			remainingSeconds = totalSeconds;
			updateDisplay();
			saveState();
		}
	};

	const startTimer = () => {
		if (isRunning || remainingSeconds <= 0) return;
		isRunning = true;
		totalSeconds = remainingSeconds; // Lock in the total time
		const startTime = GLib.get_monotonic_time() / 1000;
		const targetEndTime = startTime + (remainingSeconds * 1000);
		timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_INTERVAL_MS, () => {
			const now = GLib.get_monotonic_time() / 1000;
			remainingSeconds = Math.max(0, (targetEndTime - now) / 1000);
			updateDisplay();
			// Keep the wall stamp fresh (≤ ~1s stale) for surprise teardowns.
			if (++tickCount % 10 === 0) {
				saveState();
			}
			if (remainingSeconds <= 0) {
				stopTimerInternal();
				Main.notify(_('Timer'), _('Timer finished!'));
				return GLib.SOURCE_REMOVE;
			}
			return GLib.SOURCE_CONTINUE;
		});
		saveState();
		updateDisplay();
	};

	const pauseTimer = () => {
		if (!isRunning) return;
		isRunning = false;
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
		updateDisplay();
		saveState();
	};

	const stopTimerInternal = () => {
		pauseTimer();
		remainingSeconds = 0;
		totalSeconds = 0;
		updateDisplay();
		saveState();
	};

	// Minutes controls
	minutesPlus10Btn.connect('clicked', () => setTimer(remainingSeconds + 600));
	minutesPlus1Btn.connect('clicked', () => setTimer(remainingSeconds + 60));
	minutesMinus10Btn.connect('clicked', () => setTimer(remainingSeconds - 600));
	minutesMinus1Btn.connect('clicked', () => setTimer(remainingSeconds - 60));

	// Seconds controls
	secondsPlus10Btn.connect('clicked', () => setTimer(remainingSeconds + 10));
	secondsPlus1Btn.connect('clicked', () => setTimer(remainingSeconds + 1));
	secondsMinus10Btn.connect('clicked', () => setTimer(remainingSeconds - 10));
	secondsMinus1Btn.connect('clicked', () => setTimer(remainingSeconds - 1));

	startBtn.connect('clicked', () => {
		if (remainingSeconds > 0) {
			startTimer();
		}
	});

	pauseBtn.connect('clicked', () => pauseTimer());
	stopBtn.connect('clicked', () => stopTimerInternal());

	// Squash-and-spring feedback (shared with music) on every control.
	for (const button of [minutesPlus10Btn, minutesPlus1Btn, minutesMinus10Btn, minutesMinus1Btn,
		secondsPlus10Btn, secondsPlus1Btn, secondsMinus10Btn, secondsMinus1Btn,
		startBtn, pauseBtn, stopBtn]) {
		attachBounce(button);
	};

	body.connect('destroy', () => {
		if (timerId) {
			GLib.Source.remove(timerId);
			timerId = null;
		}
		// Exact snapshot for in-process rebuilds and logout teardowns.
		flushState();
	});

	updateDisplay();
}

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border};`;
}

export function render({body, theme, sizeForWidget, widget}) {
	renderMediumTimer({body, theme, sizeForWidget, widget});
}
