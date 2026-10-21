import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';

import { screenTimeEngine } from '../../utils/screenTimeEngine.js';
import { isActorDestroyed } from '../../utils/actorLifecycle.js';
import { bounceButton } from '../../lib/buttonBounce.js';
import { parseCssColor, cssColorToRgba } from '../../utils/ported.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

export const type = 'screentime';
export const label = 'Screen Time';
export const stylesheet = 'widgets/screentime/stylesheet.css';
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium', 'large'];

const BORDER_ALPHA = 0.14;
const REF_WIDTH = 360;
const REF_HEIGHT = 170;
// 1x1 compact card reference square (content box of a 190px cell minus
// the .widget padding/border), so the layout paints ~1:1 at s=1.
const COMPACT_SQUARE_REF = 156;

const MAIN_PANEL_WIDTH_RATIO = 0.65;
const SIDE_PANEL_LIGHTEN = 0.08;

const Y_AXIS_WIDTH_PX = 35;
const X_AXIS_HEIGHT_PX = 15;
const BAR_WIDTH_PX = 4;
const HOURS_PER_DAY = 24;

// Dynamic axis: tallest hour bucket, rounded up to a 5-minute multiple.
const MIN_SCALE_SECONDS = 300;
const HEADER_RESERVED_HEIGHT_PX = 46;
const HEADER_MARGIN_BOTTOM_PX = 12;

const HEADER_FONT_SIZE_PX = 32;
const DATE_LABEL_FONT_SIZE_PX = 14;
const AXIS_LABEL_FONT_SIZE_PX = 10;
const APP_TIME_FONT_SIZE_PX = 16;
const NAV_BUTTON_SIZE_PX = 26;
const NAV_ICON_SIZE_PX = 16;
const APP_ICON_SIZE_PX = 24;
const SECONDARY_TEXT_OPACITY = 0.63;
const DISABLED_CONTROL_OPACITY = Math.round(255 * SECONDARY_TEXT_OPACITY);
const GRID_LINE_ALPHA = 0.3;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const monthNames = () =>
    [_('Jan'), _('Feb'), _('Mar'), _('Apr'), _('May'), _('Jun'),
     _('Jul'), _('Aug'), _('Sep'), _('Oct'), _('Nov'), _('Dec')];

export function style(theme) {
	return `background-color: ${theme.background}; border: 1px solid ${theme.border}; color: ${theme.text}; border-radius: ${theme.radius ?? 16}px;`;
}

function hexToRgba(hex, alpha) {
	return cssColorToRgba(hex, alpha);
}

function toDateString(dt) {
	return `${dt.get_year()}-${String(dt.get_month()).padStart(2, '0')}-${String(dt.get_day_of_month()).padStart(2, '0')}`;
}

function addDays(dateString, delta) {
	const [y, m, d] = dateString.split('-').map(Number);
	const next = GLib.DateTime.new_local(y, m, d + delta, 12, 0, 0);
	return toDateString(next);
}

function formatShortDate(dateString) {
	const [y, m, d] = dateString.split('-').map(Number);
	return `${d} ${monthNames()[m - 1]}`;
}

function formatCompactDuration(totalSeconds) {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	if (hours > 0)
		return _('%sh %sm').format(hours, minutes.toString().padStart(2, '0'));
	return _('%sm').format(minutes);
}

function computeScaleMaxSeconds(hours) {
	let maxSeconds = 0;
	for (const seconds of hours)
		maxSeconds = Math.max(maxSeconds, seconds);
	const base = Math.max(MIN_SCALE_SECONDS, maxSeconds);
	return Math.ceil(base / MIN_SCALE_SECONDS) * MIN_SCALE_SECONDS;
}

function shadePanelColor(cssColor, amount) {
	const { r, g, b } = parseCssColor(cssColor);
	const isDark = (r * 0.299 + g * 0.587 + b * 0.114) < 0.5;
	const mix = (channel) => isDark
		? Math.round(((channel * (1 - amount)) + amount) * 255)
		: Math.round(channel * 255 * (1 - amount));
	return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

// Resolve app desktop entries once and cache them: rebuilding the list from
// the raw Gio API on every tick spams "DesktopAppInfo has been moved to a
// separate platform-specific library" per call and re-resolves on each rebuild.
let GioUnix = null;
try {
	GioUnix = (await import('gi://GioUnix')).default;
} catch (e) {
	GioUnix = null;
}
const appInfoCache = new Map();
const APP_INFO_CACHE_MAX = 256;
function resolveDesktopAppInfo(appKey) {
	// Keep the cache bounded so a long-running session across many apps cannot
	// hold on to an ever-growing set of desktop entry objects.
	if (appInfoCache.size >= APP_INFO_CACHE_MAX) {
		appInfoCache.clear();
	}
	if (!appInfoCache.has(appKey)) {
		try {
			const AppInfoClass = GioUnix?.DesktopAppInfo?.new ? GioUnix.DesktopAppInfo : Gio.DesktopAppInfo;
			appInfoCache.set(appKey, AppInfoClass.new(appKey));
		} catch (e) {
			appInfoCache.set(appKey, null);
		}
	}
	return appInfoCache.get(appKey);
}

const SIZE_CONFIGS = {
	small:      { showChart: true,  maxApps: 0 }, // 1x1 compact: total + hour chart only
	medium:     { showChart: true,  maxApps: 4 }, // 2×1
	large:      { showChart: true,  maxApps: 8 }, // 2×2
};

const DEFAULT_CONFIG = { showChart: false, maxApps: 3 };

export function render({body, createLabel, theme, sizeForWidget, widget, settings}) {
	const size = widget?.size && SIZE_CONFIGS[widget.size] ? widget.size : defaultSize;
	const config = SIZE_CONFIGS[size] ?? DEFAULT_CONFIG;
	// 1x1 compact card: total on the top-left + hour chart; no avatar, no
	// date nav, no side app list.
	const compactSquare = size === 'small';

	// Get widget dimensions for proper layout sizing
	const [widgetWidth, widgetHeight] = sizeForWidget(widget);

	if (settings?.get_int)
		screenTimeEngine.setRetentionDays(settings.get_int('screentime-retention-days'));
	const textColor = theme?.text ?? '#ffffff';
	const bgColor = theme?.background ?? '#242424';
	const accentHex = theme?.accent ?? '#3584e4';
	const radius = theme?.radius ?? 16;
	const textRgba = (alpha) => cssColorToRgba(textColor, alpha);

	const state = {
		selectedDate: null,
		snapshot: null,
		geometry: {},
		engineListener: null,
		releaseEngine: null,
		lastAppListSignature: '',
		lastAppListScale: null,
		lastListHeight: null,
		// The engine's "today" seen at the last tick — lets the compact card
		// detect a real day rollover instead of yanking back a manually
		// browsed past day on every tick.
		lastKnownToday: null,
	};

	// Nothing may paint outside the widget's own box.
	state.chartCompact = compactSquare;
	body.clip_to_allocation = true;

	// ── Split layout: main panel (chart) + side panel (apps) ───────────────
	const splitBox = new St.BoxLayout({
		orientation: Clutter.Orientation.HORIZONTAL,
		style_class: 'screentime-widget',
		x_expand: true,
		y_expand: false,
		y_align: Clutter.ActorAlign.START,
		clip_to_allocation: true,
	});
	// 1x1 compact card: vertical stack instead of the split layout — the
	// total on the top-left and the chart below (no avatar in this design).
	const compactBox = compactSquare
		? new St.BoxLayout({
			orientation: Clutter.Orientation.VERTICAL,
			x_expand: true,
			y_expand: true,
			clip_to_allocation: true,
		})
		: null;
	body.add_child(compactSquare ? compactBox : splitBox);

	// Glass paints a blurred wallpaper backdrop BEHIND the widget and
	// theme.background is a regular colour. These two panels sit on top of the
	// backdrop, so at full opacity they would hide the blur completely - which
	// is why glass only ever looked like "a blurred rectangle" here. Under
	// glass they keep just enough tint to stay readable over the wallpaper.
	const isGlass = theme?.isGlass ?? false;
	const leftBg = isGlass ? cssColorToRgba(bgColor, 0.25) : bgColor;
	const sideBase = shadePanelColor(bgColor, SIDE_PANEL_LIGHTEN);
	const sideBg = isGlass ? cssColorToRgba(sideBase, 0.25) : sideBase;

	const leftPanel = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		y_expand: true,
		clip_to_allocation: true,
		style: `background-color: ${leftBg}; border-radius: ${radius}px 0 0 ${radius}px;`,
	});
	splitBox.add_child(leftPanel);

	const rightPanel = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		y_expand: true,
		clip_to_allocation: true,
		style: `background-color: ${sideBg}; border-radius: 0 ${radius}px ${radius}px 0;`,
	});
	splitBox.add_child(rightPanel);

	// ── Header: total time (left) + date/nav (right column) ────────────────
	const headerBox = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL });
	(compactSquare ? compactBox : leftPanel).add_child(headerBox);

	const totalTimeLabel = new St.Label({
		text: '0m',
		x_expand: true,
		y_align: Clutter.ActorAlign.START,
		style: `color: ${textColor}; font-size: ${HEADER_FONT_SIZE_PX}px; font-weight: 600;`,
	});
	headerBox.add_child(totalTimeLabel);

	const controlsColumn = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.END,
		style: 'spacing: 6px;',
	});
	// The compact 1x1 card has no date/nav controls at all.
	if (!compactSquare)
		headerBox.add_child(controlsColumn);

	const dateLabel = new St.Label({
		text: '',
		style: `color: ${textColor}; font-size: ${DATE_LABEL_FONT_SIZE_PX}px; `
			+ `font-weight: 600; opacity: ${SECONDARY_TEXT_OPACITY};`,
	});
	controlsColumn.add_child(dateLabel);

	const navButtonsRow = new St.BoxLayout({ style: 'spacing: 6px;' });
	controlsColumn.add_child(navButtonsRow);

	const buildNavButton = (iconName, action) => {
		const button = new St.Button({
			reactive: true,
			can_focus: true,
			style: `width: ${NAV_BUTTON_SIZE_PX}px; height: ${NAV_BUTTON_SIZE_PX}px;`
				+ `border: 1px solid ${textRgba(0.14)}; border-radius: 6px; background-color: transparent;`,
			child: new St.Icon({
				icon_name: iconName,
				icon_size: NAV_ICON_SIZE_PX,
				style: `color: ${textColor}; opacity: ${SECONDARY_TEXT_OPACITY};`,
			}),
		});
		button.connect('button-press-event', (_actor, event) => {
			if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
			// The squash starts on the press itself — the release-driven
			// 'clicked' never fired here because the press handler stops
			// the event chain before St.Button's click synthesis.
			bounceButton(button);
			action();
			return Clutter.EVENT_STOP;
		});
		button.set_pivot_point(0.5, 0.5);
		navButtonsRow.add_child(button);
		return button;
	};

	const goToPreviousDay = () => {
		state.selectedDate = addDays(state.selectedDate, -1);
		refreshData();
	};
	const goToNextDay = () => {
		if (state.selectedDate === screenTimeEngine.getTodayDate()) return;
		state.selectedDate = addDays(state.selectedDate, 1);
		refreshData();
	};

	const prevButton = buildNavButton('go-previous-symbolic', goToPreviousDay);
	const nextButton = buildNavButton('go-next-symbolic', goToNextDay);

	// ── 1x1: flip days with the mouse, calendar-style ──────────────────────
	// Press-drag-release across the card shifts one day per gesture; no
	// bottom indicator dashes like the calendar's view dots.
	if (compactSquare) {
		const COMPACT_SWIPE_THRESHOLD = 30;
		let swipeStartX = null;

		compactBox.reactive = true;
		// Flip with the RIGHT button only — the left button stays free for
		// normal content clicks.
		compactBox.connect('button-press-event', (_actor, event) => {
			if (event.get_button() !== 3) return Clutter.EVENT_PROPAGATE;
			swipeStartX = event.get_coords()[0];
			return Clutter.EVENT_PROPAGATE;
		});
		compactBox.connect('button-release-event', (_actor, event) => {
			if (swipeStartX === null) return Clutter.EVENT_PROPAGATE;
			const startX = swipeStartX;
			swipeStartX = null;
			const delta = event.get_coords()[0] - startX;
			if (Math.abs(delta) < COMPACT_SWIPE_THRESHOLD) return Clutter.EVENT_PROPAGATE;
			// Drag left = next day, drag right = back one day.
			if (delta < 0) goToNextDay(); else goToPreviousDay();
			return Clutter.EVENT_STOP;
		});
	}

	// ── Chart (main panel) ─────────────────────────────────────────────────
	let chartWrap = null;
	let chartCanvas = null;
	let yAxisBox = null;
	let xAxisBox = null;
	let yAxisLabels = null;
	if (config.showChart) {
		chartWrap = new St.Widget({ x_expand: true, y_expand: true });
		(compactSquare ? compactBox : leftPanel).add_child(chartWrap);

		chartCanvas = new St.DrawingArea();
		chartWrap.add_child(chartCanvas);

		const yAxisAlignments = [Clutter.ActorAlign.START, Clutter.ActorAlign.CENTER, Clutter.ActorAlign.END];
		yAxisLabels = ['0', '0', '0'].map((_, index) => new St.Label({
			y_expand: true,
			y_align: yAxisAlignments[index],
			x_align: Clutter.ActorAlign.END,
			style: `color: ${textColor}; font-size: ${AXIS_LABEL_FONT_SIZE_PX}px; `
				+ `font-weight: 600; opacity: ${SECONDARY_TEXT_OPACITY};`,
		}));
		yAxisBox = new St.BoxLayout({
			orientation: Clutter.Orientation.VERTICAL,
			x_align: Clutter.ActorAlign.END,
		});
		yAxisLabels.forEach(label => yAxisBox.add_child(label));
		chartWrap.add_child(yAxisBox);

		const xAxisSpec = compactSquare
			// Compact: same 00/12/24 marks as the wide cards, shortened.
			? [['00', Clutter.ActorAlign.START], ['12', Clutter.ActorAlign.CENTER], ['24', Clutter.ActorAlign.END]]
			: [['00:00', Clutter.ActorAlign.START], ['12:00', Clutter.ActorAlign.CENTER], ['24:00', Clutter.ActorAlign.END]];
		const xAxisLabels = xAxisSpec.map(([text, xAlign]) => new St.Label({
			text,
			x_expand: true,
			x_align: xAlign,
			style: `color: ${textColor}; font-size: ${AXIS_LABEL_FONT_SIZE_PX}px; `
				+ `font-weight: 600; opacity: ${SECONDARY_TEXT_OPACITY};`,
		}));
		xAxisBox = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL });
		xAxisLabels.forEach(label => xAxisBox.add_child(label));
		chartWrap.add_child(xAxisBox);

		chartCanvas.connect('repaint', (area) => {
			const ctx = area.get_context();
			const [canvasWidth, canvasHeight] = area.get_surface_size();
			const { r, g, b } = parseCssColor(textColor);
			const s = state.geometry.scale || 1;

			// A zero-sized surface makes the compositor assert on the viewport
			// (cogl_framebuffer_set_viewport) and can take the whole shell down.
			if (!canvasWidth || !canvasHeight) {
				ctx.$dispose();
				return;
			}

			ctx.setOperator(0); // CAIRO_OPERATOR_CLEAR
			ctx.paint();
			ctx.setOperator(2); // CAIRO_OPERATOR_OVER

			ctx.setSourceRGBA(r, g, b, GRID_LINE_ALPHA);
			ctx.setLineWidth(1);
			ctx.setDash([3 * s, 3 * s], 0);

			if (state.chartCompact) {
				// Dashed guides at the top / mid / bottom scale stops, plus
				// one vertical under the 12:00 column.
				for (const yFrac of [0, 0.5, 1]) {
					const y = Math.round(canvasHeight * yFrac) + 0.5;
					ctx.moveTo(0, y);
					ctx.lineTo(canvasWidth, y);
				}
				const x = Math.round(canvasWidth * 0.5) + 0.5;
				ctx.moveTo(x, 0);
				ctx.lineTo(x, canvasHeight);
			} else {
				for (let i = 0; i < 3; i++) {
					const y = Math.round((canvasHeight / 2) * i) + 0.5;
					ctx.moveTo(0, y);
					ctx.lineTo(canvasWidth, y);

					const x = Math.round((canvasWidth / 2) * i) + 0.5;
					ctx.moveTo(x, 0);
					ctx.lineTo(x, canvasHeight);
				}
			}
			ctx.stroke();
			ctx.setDash([], 0);

			const hours = state.snapshot ? state.snapshot.hours : [];
			const scaleMax = computeScaleMaxSeconds(hours);
			const accent = parseCssColor(accentHex);
			ctx.setSourceRGBA(accent.r, accent.g, accent.b, 1);
			// The compact card fits 24 bars edge-to-edge: the bar width is
			// derived from the plot with a guaranteed gap, min 3px, so the
			// bars stay readable at 1x1 instead of hairline-thin.
			const barWidth = state.chartCompact
				? Math.max(3, Math.round((canvasWidth / HOURS_PER_DAY) * 0.62))
				: Math.round(BAR_WIDTH_PX * s);
			const barRadius = Math.round(barWidth / 2);

			for (let hour = 0; hour < hours.length; hour++) {
				if (hours[hour] <= 0) continue;
				const barHeight = Math.max(barWidth, (hours[hour] / scaleMax) * canvasHeight);
				const centerX = ((hour + 0.5) / HOURS_PER_DAY) * canvasWidth;
				const x = centerX - (barWidth / 2);
				const y = canvasHeight - barHeight;

				ctx.newSubPath();
				ctx.arc(x + barRadius, y + barRadius, barRadius, Math.PI, 1.5 * Math.PI);
				ctx.arc(x + barWidth - barRadius, y + barRadius, barRadius, 1.5 * Math.PI, 2 * Math.PI);
				ctx.lineTo(x + barWidth, canvasHeight);
				ctx.lineTo(x, canvasHeight);
				ctx.closePath();
			}
			ctx.fill();
			ctx.$dispose();
		});
	}

	// ── App list (side panel) ──────────────────────────────────────────────
	const appRowsBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.START,
		style: 'spacing: 14px;',
	});
	// The compact 1x1 card carries no app rows; the box stays detached.
	if (!compactSquare)
		rightPanel.add_child(appRowsBox);

	// Acquire tracking: engine starts collecting data when first widget acquires
	state.releaseEngine = screenTimeEngine.acquire();
	state.selectedDate = screenTimeEngine.getTodayDate();

	const onEngineTick = () => {
		const today = screenTimeEngine.getTodayDate();
		// The compact card is swipe-navigated: only re-pin to "today" on a
		// real day rollover and only while the card was still showing the
		// previous "today" — a browsed past day must stay where it is.
		if (compactSquare && today && state.lastKnownToday
			&& today !== state.lastKnownToday
			&& state.selectedDate === state.lastKnownToday) {
			state.selectedDate = today;
		}
		if (today)
			state.lastKnownToday = today;
		if (state.selectedDate === today)
			refreshData();
	};

	state.engineListener = onEngineTick;
	screenTimeEngine.addListener(onEngineTick);

	const cleanup = () => {
		if (state.releaseEngine) {
			state.releaseEngine();
			state.releaseEngine = null;
		}
		screenTimeEngine.removeListener(state.engineListener);
	};

	body.connect('destroy', cleanup);

	function refreshData() {
		if (isActorDestroyed(body) || !body.get_parent()) return;
		if (state.selectedDate === screenTimeEngine.getTodayDate()) {
			state.snapshot = screenTimeEngine.getTodaySnapshot();
			renderDynamic();
		} else {
			screenTimeEngine.loadDayAsync(state.selectedDate, (snapshot) => {
				if (!body.get_parent() || state.selectedDate !== snapshot.date) return;
				state.snapshot = snapshot;
				renderDynamic();
			});
		}
	}

	// Cheap fingerprint of the visible app list. Durations are rounded to the
	// minute: seconds change on every engine tick and would otherwise force a
	// full destroy/rebuild of the rows once per second for the whole day.
	function appListSignature(snapshot) {
		return JSON.stringify(snapshot.apps.slice(0, config.maxApps).map(app => [app.key, Math.floor(app.seconds / 60)]));
	}

	function renderDynamic() {
		if (!state.snapshot) return;

		totalTimeLabel.text = formatCompactDuration(state.snapshot.totalSeconds);

		if (!compactSquare) {
			dateLabel.text = formatShortDate(state.selectedDate);
			const isViewingToday = state.selectedDate === screenTimeEngine.getTodayDate();
			nextButton.set_opacity(isViewingToday ? DISABLED_CONTROL_OPACITY : 255);
		}

		if (config.showChart)
			updateYAxisLabels();

		if (!compactSquare) {
			const signature = appListSignature(state.snapshot);
			const geometryChanged = state.geometry.scale !== state.lastAppListScale
				|| state.geometry.listHeight !== state.lastListHeight;
			if (signature !== state.lastAppListSignature || geometryChanged) {
				state.lastAppListSignature = signature;
				state.lastAppListScale = state.geometry.scale;
				state.lastListHeight = state.geometry.listHeight;
				rebuildAppList();
			}
		}

		if (chartCanvas && state.geometry.plotWidth > 0)
			chartCanvas.queue_repaint();
	}

	function updateYAxisLabels() {
		const scaleMax = computeScaleMaxSeconds(state.snapshot.hours);
		const labels = [
			formatCompactDuration(scaleMax),
			formatCompactDuration(scaleMax / 2),
			'0',
		];
		yAxisLabels.forEach((label, index) => label.set_text(labels[index]));
	}

	function rebuildAppList() {
		appRowsBox.destroy_all_children();

		// Cap the list to the rows that actually fit the side panel's height —
		// fixed maxApps can exceed the available vertical space on short
		// widgets and push the table past the widget's bottom edge. Measure the
		// live panel allocation (ground truth: border/padding/text-scaling can
		// differ from the theoretical insets) and use a conservative row height
		// so the last row never pokes below the bottom edge.
		const s = state.geometry.scale || 1;
		const px = (v) => Math.max(1, Math.round(v * s));
		const rowH = Math.max(px(APP_ICON_SIZE_PX), Math.round(px(APP_TIME_FONT_SIZE_PX) * 1.5));
		const rowSpacing = px(14);
		const measured = rightPanel.get_height();
		const fitted = Math.max(0, (measured > 0 ? measured : state.geometry.listHeight || 0) - px(32) - 2);
		const maxByHeight = fitted > 0
			? Math.max(1, Math.floor((fitted + rowSpacing) / (rowH + rowSpacing)))
			: config.maxApps;
		const apps = state.snapshot.apps.slice(0, Math.min(config.maxApps, maxByHeight));

		if (apps.length === 0) {
			appRowsBox.add_child(new St.Label({
				text: _('No activity recorded'),
				x_expand: true,
				x_align: Clutter.ActorAlign.CENTER,
				style: `color: ${textColor}; font-size: ${APP_TIME_FONT_SIZE_PX}px; `
					+ `font-weight: 600; opacity: ${SECONDARY_TEXT_OPACITY};`,
			}));
			return;
		}

		for (const app of apps) {
			try {
				// Icon pinned left, duration immediately after it — every value
				// starts at the same x so short ("6m") and long ("1h 53m") stay aligned.
				const row = new St.BoxLayout({
					orientation: Clutter.Orientation.HORIZONTAL,
					x_align: Clutter.ActorAlign.FILL,
					style: 'spacing: 10px;',
				});

				const iconSlot = new St.Widget({
					layout_manager: new Clutter.BinLayout(),
					width: px(APP_ICON_SIZE_PX),
					height: px(APP_ICON_SIZE_PX),
				});
				const appIcon = new St.Icon({
					icon_name: 'application-x-generic',
					icon_size: px(APP_ICON_SIZE_PX),
				});
				const appInfo = resolveDesktopAppInfo(app.key);
				const gicon = appInfo ? appInfo.get_icon() : null;
				if (gicon)
					appIcon.gicon = gicon;
				iconSlot.add_child(appIcon);
				row.add_child(iconSlot);

				const durationLabel = new St.Label({
					text: formatCompactDuration(app.seconds),
					x_expand: true,
					y_align: Clutter.ActorAlign.CENTER,
					style: `color: ${textColor}; font-size: ${px(APP_TIME_FONT_SIZE_PX)}px; `
						+ `font-weight: 600; opacity: ${SECONDARY_TEXT_OPACITY};`,
				});
				durationLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
				row.add_child(durationLabel);

				appRowsBox.add_child(row);
			} catch (e) {
				// Keep the rest of the list intact if one row fails to build.
			}
		}
	}

	function applyLayout(currentWidth, currentHeight) {
		// Skip until the container has real dimensions; otherwise scale and
		// plot extents collapse to NaN and Clutter allocates INT32_MIN.
		if (!currentWidth || !currentHeight) return;
		const s = Math.min(
			currentWidth / (compactSquare ? COMPACT_SQUARE_REF : REF_WIDTH),
			currentHeight / (compactSquare ? COMPACT_SQUARE_REF : REF_HEIGHT),
		);
		if (!isFinite(s) || s <= 0) return;
		state.geometry.scale = s;

		if (compactSquare) {
			// ── 1x1 compact layout: total on top, chart fills the rest ──
			const padTop = Math.round(12 * s);
			const padSide = Math.round(13 * s);
			// A generous bottom margin keeps the 00/12/24 axis from crowding
			// the card edge.
			const padBottom = Math.round(14 * s);
			compactBox.style = `padding: ${padTop}px ${padSide}px ${padBottom}px ${padSide}px;`;

			const headerReserve = Math.round(40 * s);
			const yWidth = Math.round(30 * s);
			const plotWidth = Math.max(1, currentWidth - padSide * 2 - yWidth);
			const plotHeight = Math.max(1, currentHeight - padTop - padBottom
				- headerReserve - Math.round(X_AXIS_HEIGHT_PX * s) - Math.round(4 * s));
			Object.assign(state.geometry, { plotWidth, plotHeight });

			chartCanvas.set_position(0, headerReserve);
			chartCanvas.set_size(plotWidth, plotHeight);
			yAxisBox.set_position(plotWidth, headerReserve);
			yAxisBox.set_size(yWidth, plotHeight);
			xAxisBox.set_position(0, headerReserve + plotHeight + Math.round(4 * s));
			xAxisBox.set_size(plotWidth, Math.round(X_AXIS_HEIGHT_PX * s));

			totalTimeLabel.style = `color: ${textColor}; font-size: ${Math.round(HEADER_FONT_SIZE_PX * s * 0.9)}px; font-weight: 600;`;

			renderDynamic();
			return;
		}

		const totalWidth = currentWidth;
		const mainWidth = Math.round(totalWidth * MAIN_PANEL_WIDTH_RATIO);
		leftPanel.set_width(mainWidth);
		rightPanel.set_width(totalWidth - mainWidth);

		// Pin the two-column background to exactly the content box. If it were
		// left to expand, the panels fill the whole inner allocation (which can
		// be up to a few px taller than the content box depending on how the
		// shell resolves CSS padding/border) and their background spills 1-2px
		// below the widget's bottom edge.
		splitBox.set_size(currentWidth, currentHeight);

		const padTop = Math.round(16 * s);
		const padBottom = Math.round(16 * s);
		const padLeft = Math.round(20 * s);
		const padRight = Math.round(12 * s);
		state.geometry.listHeight = Math.max(0, currentHeight - padTop - padBottom);
		// Re-assigned on every relayout, so the glass-aware backgrounds have to be
		// applied here too - setting them once at construction is not enough.
		leftPanel.style = `background-color: ${leftBg}; border-radius: ${radius}px 0 0 ${radius}px;`
			+ `padding: ${padTop}px ${padRight}px ${padBottom}px ${padLeft}px;`;

		rightPanel.style = `background-color: ${sideBg}; border-radius: 0 ${radius}px ${radius}px 0;`
			+ `padding: ${padTop}px ${padLeft}px;`;

		headerBox.style = `margin-bottom: ${Math.round(12 * s)}px; padding-right: ${Math.round(5 * s)}px;`;
		totalTimeLabel.style = `color: ${textColor}; font-size: ${Math.round(HEADER_FONT_SIZE_PX * s)}px; font-weight: 600;`;

		prevButton.style = `width: ${Math.round(NAV_BUTTON_SIZE_PX * s)}px; height: ${Math.round(NAV_BUTTON_SIZE_PX * s)}px;`
			+ `border: 1px solid ${textRgba(0.14)}; border-radius: ${Math.round(6 * s)}px; background-color: transparent;`;
		nextButton.style = prevButton.style;

		if (config.showChart) {
			const chartWrapWidth = mainWidth - padLeft - padRight;
			// Reserve only what the tallest header column actually occupies
			// (date label 14 + spacing 6 + nav buttons 26), so the plot top — and
			// therefore the max scale mark — rises to the prev/next button level.
			const chartWrapHeight = currentHeight - padTop - padBottom
				- Math.round((HEADER_RESERVED_HEIGHT_PX + HEADER_MARGIN_BOTTOM_PX) * s);
			const plotWidth = Math.max(1, chartWrapWidth - Math.round(Y_AXIS_WIDTH_PX * s));
			const plotHeight = Math.max(1, chartWrapHeight - Math.round(X_AXIS_HEIGHT_PX * s));
			Object.assign(state.geometry, { plotWidth, plotHeight });

			chartCanvas.set_position(0, 0);
			chartCanvas.set_size(plotWidth, plotHeight);

			yAxisBox.set_position(plotWidth, 0);
			yAxisBox.set_size(Math.round(Y_AXIS_WIDTH_PX * s), plotHeight);

			xAxisBox.set_position(0, plotHeight + Math.round(4 * s));
			xAxisBox.set_size(plotWidth, Math.round(X_AXIS_HEIGHT_PX * s));
			xAxisBox.style = `margin-bottom: ${Math.round(6 * s)}px;`;
		}

		appRowsBox.style = `spacing: ${Math.round(14 * s)}px;`;

		renderDynamic();
	}

	// Content area = the fixed outer actor minus `.widget`'s 16px padding and 1px
	// border on each side (stylesheet.css). Compute it from the actor, not from
	// the live `body`: at rebuild time (edit mode) body may not be allocated
	// yet (width 0), and using body.width as both input and output lets layout
	// feedback run away. The actor's size is set by extension.js and never
	// reacts to our writes, so these values are stable and idempotent.
	const CLIP_INSET = 16 + (theme.borderWidth ?? 1); // padding 16 + border width, each side
	const actor = body.get_parent();
	const contentWidth = () => Math.max(1, (actor ? actor.width : widgetWidth) - CLIP_INSET * 2);
	const contentHeight = () => Math.max(1, (actor ? actor.height : widgetHeight) - CLIP_INSET * 2);

	applyLayout(contentWidth(), contentHeight());

	// Keep the layout in sync with real size changes, but never let it feed
	// back: inputs come from the fixed actor (resizes only on a real drag /
	// size switch), and the size guard stops any remaining churn.
	let disposed = false;
	let lastWidth = -1;
	let lastHeight = -1;
	let relayouting = false;
	let updateId = 0;
	const update = () => {
		if (disposed || relayouting) return;
		const currentWidth = contentWidth();
		const currentHeight = contentHeight();
		if (currentWidth === lastWidth && currentHeight === lastHeight) return;
		lastWidth = currentWidth;
		lastHeight = currentHeight;
		relayouting = true;
		try {
			applyLayout(currentWidth, currentHeight);
		} finally {
			relayouting = false;
		}
	};

	// A size animation (or a size switch) fires notify::width/height every
	// frame; coalesce them so the (expensive) relayout runs once the size has
	// settled instead of on each frame.
	const scheduleUpdate = () => {
		if (disposed) return;
		if (updateId) GLib.source_remove(updateId);
		updateId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
			updateId = 0;
			update();
			return GLib.SOURCE_REMOVE;
		});
	};

	body.connect('notify::width', scheduleUpdate);
	body.connect('notify::height', scheduleUpdate);
	// The actor is the source of truth for the widget size (set by
	// extension.js); listen on it directly as well so an interrupted resize
	// animation (e.g. quickly leaving edit mode mid-ease) still converges.
	if (actor) {
		actor.connect('notify::width', scheduleUpdate);
		actor.connect('notify::height', scheduleUpdate);
	}
	body.connect('destroy', () => {
		disposed = true;
		if (updateId) {
			GLib.source_remove(updateId);
			updateId = 0;
		};
	});
	GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
		if (!disposed) {
			update();
		}
		return GLib.SOURCE_REMOVE;
	});

	refreshData();
}