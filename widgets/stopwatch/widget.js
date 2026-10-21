import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
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

	// Time display container — a plain St.Widget with hand-set positions.
	// BoxLayout semantics have drifted this row too many times (full cross
	// sizes, ignored child aligns), so nothing depends on alignment anymore:
	// every child gets exact design offsets and the row centers itself with
	// a paint-only translation fallback. The row is built FROM THE MIDDLE
	// OUTWARD (see placeRow below).
	const timeBox = new St.Widget({x_align: Clutter.ActorAlign.CENTER, x_expand: true});

	// One shared digit slot for all three columns plus fixed 16-unit colon
	// blocks between them. Slot 133 fits the 19px/700 "Centiseconds" caption
	// (ink 127) with symmetric pads and keeps the row inside the 540 canvas.
	const digitSlot = px(133);
	const colonSlot = px(16);
	const colonGap = px(8);
	const timeRowH = px(96);

	// Minutes
	const minutesBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		style: `spacing: ${px(4)}px;`,
	});

	// Ink is centered at runtime from the text's measured extents — no
	// hardcoded pads, nothing to drift if the real font differs from the
	// harness numbers. Captions are translated, so only live text counts.
	const minutesLabel = new St.Label({
		text: '00',
		style: `color: ${textColor}; font-family: Ubuntu; font-size: ${px(64)}px; font-weight: 700; font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; width: ${digitSlot}px;`,
	});

	const minutesCaption = new St.Label({
		text: _('Minutes'),
		style: `color: ${mutedColor}; font-family: Ubuntu; font-size: ${px(19)}px; font-weight: 700; width: ${digitSlot}px; padding: 0 ${px(30)}px;`,
	});

	minutesBox.add_child(minutesLabel);
	minutesBox.add_child(minutesCaption);
	minutesBox.set_size(digitSlot, timeRowH);

	// Two-dot colon separators drawn in canvas, in the reference digital
	// clock's style: fat round dots instead of the thin font glyph. Geometry
	// from the target look: dot radius 5 units, centers 18 units apart, the
	// stack leaning toward the digit baseline (center at +33 of the ~49-tall
	// ink row). Paint coordinates come from the KNOWN design constants, not
	// the surface size — an undead surface report can't shift the dots.
	const buildColon = () => {
		const area = new St.DrawingArea();
		area.connect('repaint', (canvas) => {
			const ctx = canvas.get_context();
			const rgb = parseCssColor(textColor) ?? {r: 1, g: 1, b: 1, a: 1};
			ctx.setSourceRGBA(rgb.r, rgb.g, rgb.b, 1);
			const cx = px(8);
			const cy = px(33);
			const r = px(5);
			for (const dy of [-px(9), px(9)]) {
				ctx.arc(cx, cy + dy, r, 0, 2 * Math.PI);
				ctx.fill();
			};
			ctx.$dispose();
		});
		area.set_size(colonSlot, timeRowH);
		return area;
	};

	const separator1 = buildColon();

	// Seconds
	const secondsBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		style: `spacing: ${px(4)}px;`,
	});

	const secondsLabel = new St.Label({
		text: '00',
		style: `color: ${textColor}; font-family: Ubuntu; font-size: ${px(64)}px; font-weight: 700; font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; width: ${digitSlot}px;`,
	});

	const secondsCaption = new St.Label({
		text: _('Seconds'),
		style: `color: ${mutedColor}; font-family: Ubuntu; font-size: ${px(19)}px; font-weight: 700; width: ${digitSlot}px; padding: 0 ${px(25)}px;`,
	});

	secondsBox.add_child(secondsLabel);
	secondsBox.add_child(secondsCaption);
	secondsBox.set_size(digitSlot, timeRowH);

	// Separator (two-dot canvas, same builder)
	const separator2 = buildColon();

	// Centiseconds
	const centisecondsBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		style: `spacing: ${px(4)}px;`,
	});

	const centisecondsLabel = new St.Label({
		text: '00',
		style: `color: ${textColor}; font-family: Ubuntu; font-size: ${px(64)}px; font-weight: 700; font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; width: ${digitSlot}px;`,
	});

	const centisecondsCaption = new St.Label({
		text: _('Centiseconds'),
		style: `color: ${mutedColor}; font-family: Ubuntu; font-size: ${px(19)}px; font-weight: 700; width: ${digitSlot}px; padding: 0 ${px(2)}px;`,
	});

	// The caption content budget equals the LOGICAL text width (pads above
	// are logical-measured), but Clutter still trims its layout at one-line
	// tightness: forbid the ellipsis outright — a couple of paint px of
	// bleed into the inter-block air beats a truncated "Minu…".
	for (const caption of [minutesCaption, secondsCaption, centisecondsCaption]) {
		caption.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.NONE);
	};

	centisecondsBox.add_child(centisecondsLabel);
	centisecondsBox.add_child(centisecondsCaption);
	centisecondsBox.set_size(digitSlot, timeRowH);

	// Fixed child sizes; the plain parent never repositions anything — only
	// placeRow below decides the coordinates.
	timeBox.add_child(minutesBox);
	timeBox.add_child(separator1);
	timeBox.add_child(secondsBox);
	timeBox.add_child(separator2);
	timeBox.add_child(centisecondsBox);

	// The row is built FROM THE MIDDLE OUTWARD: the seconds column is pinned
	// to the widget's horizontal center on every allocation and both sides
	// are placed at symmetric offsets from that anchor, so the spacing
	// around both colons is identical by construction. (Runtime ink
	// centering keeps every glyph centered inside its slot.)
	const placeRow = () => {
		const W = timeBox.allocation.get_width();
		if (W <= 0) return;
		const cx = Math.round(W / 2);
		const start = cx - Math.round(digitSlot / 2);
		secondsBox.set_position(start, 0);
		separator2.set_position(start + digitSlot + colonGap, 0);
		centisecondsBox.set_position(start + digitSlot + colonGap + colonSlot + colonGap, 0);
		separator1.set_position(start - colonGap - colonSlot, 0);
		minutesBox.set_position(start - colonGap - colonSlot - colonGap - digitSlot, 0);
	};
	timeBox.connect('notify::allocation', placeRow);
	placeRow();

	// Ink constants — harness-measured and journal-verified in the shell
	// (digits ink 46 = 69 * scale exactly): digits '00' at 64px bold Ubuntu
	// ink 69; captions at 17px/700 ink 63 / 69 / 108 (pads in their styles).
	// The LIVE get_pixel_extents state turned out timing-dependent — ink.x
	// flipped between +1 and −14 across identical renders, and with the
	// flipped value the paint lands ~15px right of slot center, gluing the
	// colon to the digit to its left. Nothing is measured at runtime now:
	// digits translate by the constant (slot − 69)/2; captions center
	// through content==ink padding baked into the styles.
	// (Ubuntu digits aren't tabular — '01' ink 60 vs '00' 69 — while running
	// the deviation stays within a couple of paint pixels; tabular-nums is
	// requested in CSS to tighten that when the font supports it.)
	// Captions at 19px/700: inks 71 / 81 / 127.
	const digitAlignment = Math.round((digitSlot - px(69)) / 2);
	minutesLabel.translation_x = digitAlignment;
	secondsLabel.translation_x = digitAlignment;
	centisecondsLabel.translation_x = digitAlignment;

	// DEBUG(probe): one-shot journal dump of the row's real numbers, to
	// verify against the design (slot 123, gap 8, colon 16). Remove after
	// the next verification round.
	GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
		const geo = (c) => `${Math.round(c.x)},${Math.round(c.y)} ${Math.round(c.allocation.get_width())}x${Math.round(c.allocation.get_height())}`;
		const inkOf = (label) => {
			const layout = label.get_clutter_text()?.get_layout();
			return layout ? Math.round(layout.get_pixel_extents()[0].width) : -1;
		};
		console.warn(`[stopwatch-debug] row alloc ${Math.round(timeBox.allocation.get_width())}x${Math.round(timeBox.allocation.get_height())} tx ${Math.round(timeBox.translation_x)} | ${[minutesBox, separator1, secondsBox, separator2, centisecondsBox].map(geo).join(' | ')}`);
		console.warn(`[stopwatch-debug] digit tx ${[minutesLabel, secondsLabel, centisecondsLabel].map((l) => Math.round(l.translation_x)).join(' / ')} ink ${inkOf(minutesLabel)} ${inkOf(secondsLabel)} ${inkOf(centisecondsLabel)}`);
		const absInk = (col, label) => {
			const layout = label.get_clutter_text()?.get_layout();
			if (!layout) return 'no-layout';
			const ink = layout.get_pixel_extents()[0];
			const base = Math.round(col.x + label.allocation.get_x() + ink.x + label.translation_x);
			return `${base}..${base + Math.round(ink.width)}`;
		};
		console.warn(`[stopwatch-debug] ink map digits ${absInk(minutesBox, minutesLabel)} | ${absInk(secondsBox, secondsLabel)} | ${absInk(centisecondsBox, centisecondsLabel)} vs sep1 box ${Math.round(separator1.x)} (dot cx ${px(8)}±${px(5)}) sep2 box ${Math.round(separator2.x)}`);
		console.warn(`[stopwatch-debug] caption ink ${inkOf(minutesCaption)} ${inkOf(secondsCaption)} ${inkOf(centisecondsCaption)} | texts: ${[minutesCaption, secondsCaption, centisecondsCaption].map((l) => String(l.text)).join(' / ')}`);
		return GLib.SOURCE_REMOVE;
	});

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
