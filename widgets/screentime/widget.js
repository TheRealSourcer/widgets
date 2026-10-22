import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';

import { screenTimeEngine } from '../../utils/screenTimeEngine.js';
import { isActorDestroyed } from '../../utils/actorLifecycle.js';
import { bounceButton, bindHoverShrink } from '../../lib/buttonBounce.js';
import { parseCssColor, cssColorToRgba } from '../../utils/ported.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

// Re-render memory: theme/style changes rebuild the card in place — the
// browsed day must survive that instead of snapping back to today
// (in-memory only: a shell restart starts fresh at today).
let lastSelectedDate = null;

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
const SIDE_PANEL_LIGHTEN = 0.16;

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
const APP_ICON_SIZE_PX = 22;
const SECONDARY_TEXT_OPACITY = 0.63;
const DISABLED_CONTROL_OPACITY = Math.round(255 * SECONDARY_TEXT_OPACITY);
const GRID_LINE_ALPHA = 0.3;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── 2x2 stack card constants ───────────────────────────────────────────────
const LEGEND_FONT_SIZE_PX = 11;   // colored top-app chips under the chart
const LEGEND_TOP_APPS = 3;
const APP_BAND_FONT_SIZE_PX = 12; // app rows in the bottom two-column band
const LARGE_APP_ROWS_MAX = 4; // 4 rows × 2 columns = 8 apps in the 2×2 band
// Two-line band row height: name over duration line boxes + 1px gap.
// St's label line box runs ~1.25× the font size (a 13px label measures 14px),
// so 1.5× would overestimate and drop real 4-row capacity to 3.
const BAND_ROW_H_PX = Math.round(APP_BAND_FONT_SIZE_PX * 1.25)
	+ Math.round(APP_BAND_FONT_SIZE_PX * 0.92 * 1.25) + 1;

// Hour bars and legend chips are colored after the bucket's dominant app.
// Bright variants stay readable on a dark base; regular ones on a light base.
const APP_PALETTE_DARK = [
	'#99c1f1', '#dc8add', '#8ff0a4', '#f8e45c',
	'#ffbe6f', '#f66151', '#99f1e2', '#cdab8f',
];
const APP_PALETTE_LIGHT = [
	'#1c71d8', '#9141ac', '#26a269', '#e5a50a',
	'#e66100', '#c01c28', '#108a9c', '#865e3c',
];
// Buckets with no recognizable app stay neutral gray, not a random hue.
const OTHER_CATEGORY_DARK = '#9a9996';
const OTHER_CATEGORY_LIGHT = '#5e5c64';

function appPaletteCss(key, isLight) {
	if (key === 'other')
		return isLight ? OTHER_CATEGORY_LIGHT : OTHER_CATEGORY_DARK;
	const palette = isLight ? APP_PALETTE_LIGHT : APP_PALETTE_DARK;
	let sum = 0;
	for (const ch of key)
		sum += ch.codePointAt(0);
	return palette[sum % palette.length];
}

// Parsed variants for the chart painter (24 setSourceRGBA calls per repaint).
const appChartColors = new Map();
function appChartColor(key, isLight) {
	const cacheKey = (isLight ? 'l:' : 'd:') + key;
	if (appChartColors.size > 256)
		appChartColors.clear();
	if (!appChartColors.has(cacheKey))
		appChartColors.set(cacheKey, parseCssColor(appPaletteCss(key, isLight)));
	return appChartColors.get(cacheKey);
}

// ── App categories (2x2 legend + bucket colors) ────────────────────────────
// Desktop entries carry XDG menu categories; they are mapped onto a friendly
// summary, checked top-down — a "Network + InstantMessaging" messenger is
// Social even though it also matches Network (Web).
const APP_CATEGORY_RULES = [
	['social', ['instantmessaging', 'chat', 'ircclient', 'telephony', 'news', 'contactmanagement']],
	['entertainment', ['game', 'audiovideo', 'music', 'video', 'player', 'audio', 'sports']],
	['development', ['development', 'ide', 'debugger', 'revisioncontrol', 'database', 'building', 'terminalemulator']],
	['creativity', ['graphics', '2dgraphics', '3dgraphics', 'vectorgraphics', 'rastergraphics', 'photography', 'scanning']],
	['work', ['office', 'wordprocessor', 'texttools', 'spreadsheet', 'presentation', 'projectmanagement', 'finance', 'calendar', 'education', 'science']],
	['web', ['network', 'webbrowser', 'filetransfer', 'translation']],
	['utilities', ['utility', 'system', 'settings', 'archiving', 'filetools', 'filemanager', 'core']],
];

const appCategoryCache = new Map();
function resolveAppCategory(appKey) {
	if (appCategoryCache.size > 512)
		appCategoryCache.clear();
	if (!appCategoryCache.has(appKey)) {
		let category = 'other';
		try {
			const info = resolveDesktopAppInfo(appKey);
			const raw = info ? info.get_categories() : null;
			if (raw) {
				const tokens = raw.toLowerCase().split(';').filter(Boolean);
				for (const [bucket, rules] of APP_CATEGORY_RULES) {
					if (rules.some(rule => tokens.includes(rule))) {
						category = bucket;
						break;
					}
				}
			}
		} catch (e) {
			// Unknown app — stays a gray "Other".
		}
		appCategoryCache.set(appKey, category);
	}
	return appCategoryCache.get(appKey);
}

// Translations resolve at runtime, when the extension's gettext domain is up.
function appCategoryLabel(key) {
	switch (key) {
		case 'social': return _('Social');
		case 'entertainment': return _('Entertainment');
		case 'development': return _('Development');
		case 'creativity': return _('Creativity');
		case 'work': return _('Work');
		case 'web': return _('Web');
		case 'utilities': return _('Utilities');
		default: return _('Other');
	}
}

// The day's activity rolled up into category buckets, longest first.
function buildCategorySummary(apps) {
	const totals = new Map();
	for (const app of apps) {
		const category = resolveAppCategory(app.key);
		totals.set(category, (totals.get(category) || 0) + app.seconds);
	}
	return [...totals.entries()]
		.map(([key, seconds]) => ({ key, seconds }))
		.sort((a, b) => b.seconds - a.seconds);
}

const monthNames = () =>
    [_('Jan'), _('Feb'), _('Mar'), _('Apr'), _('May'), _('Jun'),
     _('Jul'), _('Aug'), _('Sep'), _('Oct'), _('Nov'), _('Dec')];

export function style(theme) {
	return `background-color: ${theme.background}; border: 1px solid ${theme.border}; color: ${theme.text}; border-radius: ${theme.radius ?? 16}px; padding: 0;`;
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

// The chart's y-axis marks need a shorter form than the card total ("1h",
// not "1h 00m" — the 35px axis box otherwise ellipsizes the top mark).
function formatAxisDuration(totalSeconds) {
	const hours = Math.floor(totalSeconds / 3600);
	if (hours > 0)
		return _('%sh').format(hours);
	return _('%sm').format(Math.round((totalSeconds % 3600) / 60));
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
	medium:     { showChart: true,  maxApps: 4 }, // 2×1 split: chart left, app list right
	large:      { showChart: true,  maxApps: 8 }, // 2×2 stack: legend chips + 2-column band (4 rows × 2)
};

const DEFAULT_CONFIG = { showChart: false, maxApps: 3 };

export function render({body, createLabel, theme, sizeForWidget, widget, settings}) {
	const size = widget?.size && SIZE_CONFIGS[widget.size] ? widget.size : defaultSize;
	const config = SIZE_CONFIGS[size] ?? DEFAULT_CONFIG;
	// 1x1 compact card: total on the top-left + hour chart; no avatar, no
	// date nav, no side app list.
	const compactSquare = size === 'small';
	// 2x2: full-stack card — avatar header, full-width hour chart, colored
	// top-app legend and a two-column app band pinned to the bottom edge.
	const isLarge = size === 'large';

	// Get widget dimensions for proper layout sizing
	const [widgetWidth, widgetHeight] = sizeForWidget(widget);

	if (settings?.get_int)
		screenTimeEngine.setRetentionDays(settings.get_int('screentime-retention-days'));
	const textColor = theme?.text ?? '#ffffff';
	const bgColor = theme?.background ?? '#242424';
	const accentHex = theme?.accent ?? '#3584e4';
	const radius = theme?.radius ?? 16;
	const textRgba = (alpha) => cssColorToRgba(textColor, alpha);
	// Palette variant selection: light bases need the darker chart colors.
	let isLightBg = false;
	try {
		const bgParsed = parseCssColor(bgColor);
		isLightBg = (bgParsed.r * 0.299 + bgParsed.g * 0.587 + bgParsed.b * 0.114) >= 0.5;
	} catch (e) {
		isLightBg = false;
	}

	const state = {
		selectedDate: null,
		snapshot: null,
		geometry: {},
		categorySummary: [],
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

	// The root's own death. Declared here — refreshData/renderDynamic/run
	// earlier in the file, and a TDZ ReferenceError here killed ALL data
	// loading (the empty-card / invisible-cross bug).
	let rootAlive = true;

	// ── Split layout (2x1): main panel (chart) + side panel (apps) ─────────
	const splitBox = isLarge ? null : new St.BoxLayout({
		orientation: Clutter.Orientation.HORIZONTAL,
		style_class: 'screentime-widget',
		x_expand: true,
		y_expand: true,
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
	// 2x2: vertical stack card — header, full-width chart, top-app legend
	// and the two-column app band stretched over the remaining bottom.
	const largeRoot = isLarge
		? new St.BoxLayout({
			orientation: Clutter.Orientation.VERTICAL,
			clip_to_allocation: true,
		})
		: null;
	const root = compactSquare ? compactBox : (isLarge ? largeRoot : splitBox);
	body.add_child(root);

	// Glass paints a blurred wallpaper backdrop BEHIND the widget and
	// theme.background is a regular colour. These two panels sit on top of the
	// backdrop, so at full opacity they would hide the blur completely - which
	// is why glass only ever looked like "a blurred rectangle" here. Under
	// glass they keep just enough tint to stay readable over the wallpaper.
	const isGlass = theme?.isGlass ?? false;
	const leftBg = isGlass ? cssColorToRgba(bgColor, 0.25) : bgColor;
	const sideBase = shadePanelColor(bgColor, SIDE_PANEL_LIGHTEN);
	// Solid (opaque) in both themes: the app-list section reads as a full
	// panel pinned to the widget edge, not a translucent inset block.
	// Solid in the normal theme; translucent in glass mode so the blur
	// shows through the side band.
	const sideBg = isGlass ? cssColorToRgba(sideBase, 0.25) : sideBase;

	// The 2x2 stack has no side panels: the widget's own background shows
	// through above the app band.
	const leftPanel = !splitBox ? null : new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		y_expand: true,
		clip_to_allocation: true,
		style: `background-color: ${leftBg}; border-radius: ${radius}px 0 0 ${radius}px;`,
	});
	if (splitBox)
		splitBox.add_child(leftPanel);

	const rightPanel = !splitBox ? null : new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		y_expand: true,
		clip_to_allocation: true,
		style: `background-color: ${sideBg}; border-radius: 0 ${radius}px ${radius}px 0;`,
	});
	if (splitBox)
		splitBox.add_child(rightPanel);

	// ── Header: avatar (2x2 only) + total time + date/nav (right column) ───
	const headerBox = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL });
	if (compactSquare)
		compactBox.add_child(headerBox);
	else if (isLarge)
		largeRoot.add_child(headerBox);
	else
		leftPanel.add_child(headerBox);

	const totalTimeLabel = new St.Label({
		text: '0m',
		x_expand: true,
		y_align: Clutter.ActorAlign.START,
		style: `color: ${textColor}; font-size: ${HEADER_FONT_SIZE_PX}px; font-weight: 600;`,
	});
	headerBox.add_child(totalTimeLabel);

	// Date + arrows form one row on the 2x2 card (a flatter header leaves the
	// app band three rows); the 2x1 keeps the compact vertical stack. The
	// arrows row can be toggled off from the extension settings.
	const showNavButtons = settings?.get_boolean('screentime-show-nav-buttons') ?? true;
	const controlsColumn = new St.BoxLayout({
		orientation: isLarge ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL,
		x_align: Clutter.ActorAlign.END,
		y_align: Clutter.ActorAlign.START,
		style: 'spacing: 6px;',
	});

	const dateLabel = new St.Label({
		text: '',
		y_align: Clutter.ActorAlign.CENTER,
		style: `color: ${textColor}; font-size: ${DATE_LABEL_FONT_SIZE_PX}px; `
			+ `font-weight: 600; opacity: ${SECONDARY_TEXT_OPACITY};`,
	});
	// The compact 1x1 card shows the arrows only (no date label) — single row
	// keeps them level with the top of the total.
	if (!compactSquare)
		controlsColumn.add_child(dateLabel);

	const navButtonsRow = new St.BoxLayout({ style: 'spacing: 6px;' });
	controlsColumn.add_child(navButtonsRow);

	// Always attached; visibility handles the toggle (the arrows row plus, on
	// the compact card, the whole column when nothing else remains).
	navButtonsRow.visible = showNavButtons;
	controlsColumn.visible = showNavButtons || !compactSquare;
	headerBox.add_child(controlsColumn);

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
		bindHoverShrink(button);
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

	// ── Mouse day-flip on both card shapes ────────────────────────────────
	// Right-button press-drag-release shifts one day per gesture. The flip
	// plays the system monitor's page cross motion: the current day slides
	// out and — fully off-stage — swaps its data, then the new day rides in
	// from the opposite side. Both legs use the system cross' curve and
	// total duration (EASE_OUT_CUBIC, 500ms), nothing fades. The 1x1 card
	// has no nav buttons at all; 2x1/2x2 carry the arrows too, the mouse
	// gesture duplicates them.
	// ── Mouse day-flip ────────────────────────────────────────────────────
	// Right-button press-drag-release shifts one day per gesture.
	// • 1x1 compact carries the original slide-and-fade flip: the day slides
	//   out and fades, the data swap happens fully off-stage, and the day
	//   slides back in from the opposite side.
	// • 2x1 / 2x2 have NO flip animation at all — a swipe simply jumps the
	//   day (the arrows never animated either).
	const bindDaySwipe = (card, threshold, { animate = true } = {}) => {
		const SWIPE_DURATION = 250; // the compact card's classic beat
		let swipeStartX = null;
		let swipeBusy = false;

		card.reactive = true;
		// Flip with the RIGHT button only — the left button stays free for
		// normal content clicks.
		card.connect('button-press-event', (_actor, event) => {
			if (event.get_button() !== 3) return Clutter.EVENT_PROPAGATE;
			swipeStartX = event.get_coords()[0];
			return Clutter.EVENT_PROPAGATE;
		});
		card.connect('button-release-event', (_actor, event) => {
			if (swipeStartX === null) return Clutter.EVENT_PROPAGATE;
			const startX = swipeStartX;
			swipeStartX = null;

			const delta = event.get_coords()[0] - startX;
			if (Math.abs(delta) < threshold) return Clutter.EVENT_PROPAGATE;
			if (swipeBusy) return Clutter.EVENT_STOP;

			// Drag left = next day, drag right = back one day. There are no
			// future days to show — stop at today.
			const dayDelta = delta < 0 ? 1 : -1;
			if (dayDelta > 0 && state.selectedDate === screenTimeEngine.getTodayDate())
				return Clutter.EVENT_STOP;

			// Wide cards: the data swap is the whole story — no motion.
			if (!animate) {
				state.selectedDate = addDays(state.selectedDate, dayDelta);
				refreshData();
				return Clutter.EVENT_STOP;
			}

			const pageWidth = Math.max(120, card.get_width() || 180);
			const exitX = delta < 0 ? -pageWidth : pageWidth;
			swipeBusy = true;

			// The old day slides out; the data swap and the entry slide both
			// happen in the complete handler, so the swap is never visible —
			// the card always arrives from the opposite side.
			card.ease({
				opacity: 0,
				translation_x: exitX,
				duration: SWIPE_DURATION,
				mode: Clutter.AnimationMode.EASE_IN_QUAD,
				onComplete: () => {
					state.selectedDate = addDays(state.selectedDate, dayDelta);
					refreshData();
					card.translation_x = -exitX;
					card.ease({
						opacity: 255,
						translation_x: 0,
						duration: SWIPE_DURATION,
						mode: Clutter.AnimationMode.EASE_OUT_QUAD,
						onComplete: () => { swipeBusy = false; },
					});
				},
			});
			return Clutter.EVENT_STOP;
		});
	};

	bindDaySwipe(root, 30, { animate: compactSquare });

	// ── Chart (main panel) ─────────────────────────────────────────────────
	let chartWrap = null;
	let chartCanvas = null;
	let yAxisBox = null;
	let xAxisBox = null;
	let yAxisLabels = null;
	if (config.showChart) {
		// The 2x2 stack gives the chart a fixed height in applyLayout (the
		// app band absorbs the rest), so no y-expansion there.
		chartWrap = new St.Widget({ x_expand: true, y_expand: !isLarge });
		if (compactSquare)
			compactBox.add_child(chartWrap);
		else if (isLarge)
			largeRoot.add_child(chartWrap);
		else
			leftPanel.add_child(chartWrap);

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
			: (isLarge
				// 2x2: quarter-day marks like the reference design.
				? [['00', Clutter.ActorAlign.START], ['06', Clutter.ActorAlign.CENTER],
					['12', Clutter.ActorAlign.CENTER], ['18', Clutter.ActorAlign.END]]
				: [['00:00', Clutter.ActorAlign.START], ['12:00', Clutter.ActorAlign.CENTER], ['24:00', Clutter.ActorAlign.END]]);
		const xAxisLabels = xAxisSpec.map(([text, xAlign]) => new St.Label({
			text,
			x_expand: true,
			x_align: xAlign,
			style: `color: ${textColor}; font-size: ${AXIS_LABEL_FONT_SIZE_PX}px; `
				+ `font-weight: 600; opacity: ${SECONDARY_TEXT_OPACITY};`,
		}));
		xAxisBox = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL });
		xAxisLabels.forEach(label => xAxisBox.add_child(label));
		// Compact: the axis lives directly in compactBox as the LAST stacked
		// child — a vertical BoxLayout bottom-aligns it above the padding, so
		// it hugs the widget's bottom edge no matter how much slack the
		// y-expanding chartWrap absorbs. The wide cards keep it inside
		// chartWrap with manual positioning.
		if (compactSquare)
			compactBox.add_child(xAxisBox);
		else
			chartWrap.add_child(xAxisBox);

		// ── Chart paint — ONE renderer for the live canvas and the frozen
		// leaving-page copy (the 1x1 day-flip cross plays two pages at once).
		// Identifier ground: hours + scale + bar colours fully parameterized.
		const drawDayChart = (area, day) => {
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
				for (const yFrac of [0, 0.5, 1]) {
					const y = Math.round(canvasHeight * yFrac) + 0.5;
					ctx.moveTo(0, y);
					ctx.lineTo(canvasWidth, y);
				}
				// The 2x2 card marks quarter days (00/06/12/18); the split
				// layout keeps the old half-day thirds.
				const xStops = state.geometry.largeChart ? [0.25, 0.5, 0.75] : [0, 0.5, 1];
				for (const xFrac of xStops) {
					const x = Math.round(canvasWidth * xFrac) + 0.5;
					ctx.moveTo(x, 0);
					ctx.lineTo(x, canvasHeight);
				}
			}
			ctx.stroke();
			ctx.setDash([], 0);

			const hours = day.hours;
			const scaleMax = day.scaleMax;
			const accent = parseCssColor(accentHex);
			// A bucket is painted in its dominant app's CATEGORY color — the
			// category legend uses the very same palette; the day's leading
			// category keeps the theme accent.
			const hourKeys = day.hourKeys;
			const topCategory = day.topKey;
			// The compact card fits 24 bars edge-to-edge: the bar width is
			// derived from the plot with a guaranteed gap, min 3px, so the
			// bars stay readable at 1x1 instead of hairline-thin.
			const barWidth = state.chartCompact
				? Math.max(3, Math.round((canvasWidth / HOURS_PER_DAY) * 0.62))
				: Math.round((state.geometry.largeBarWidth || BAR_WIDTH_PX) * s);
			const barRadius = Math.round(barWidth / 2);

			for (let hour = 0; hour < hours.length; hour++) {
				if (hours[hour] <= 0) continue;
				const barHeight = Math.max(barWidth, (hours[hour] / scaleMax) * canvasHeight);
				const centerX = ((hour + 0.5) / HOURS_PER_DAY) * canvasWidth;
				const x = centerX - (barWidth / 2);
				const y = canvasHeight - barHeight;

				const bucketKey = hourKeys ? hourKeys[hour] : null;
				const bucketCategory = bucketKey ? resolveAppCategory(bucketKey) : null;
				const barColor = (bucketCategory && bucketCategory !== topCategory)
					? appChartColor(bucketCategory, isLightBg) : accent;
				ctx.setSourceRGBA(barColor.r, barColor.g, barColor.b, 1);

				ctx.newSubPath();
				ctx.arc(x + barRadius, y + barRadius, barRadius, Math.PI, 1.5 * Math.PI);
				ctx.arc(x + barWidth - barRadius, y + barRadius, barRadius, 1.5 * Math.PI, 2 * Math.PI);
				ctx.lineTo(x + barWidth, canvasHeight);
				ctx.lineTo(x, canvasHeight);
				ctx.closePath();
				ctx.fill();
			}

			// An empty day shows the muted no-activity mark inside the plot —
			// there is no zero-day content, but BOTH pages of the day cross
			// then carry something visible to fly (the system monitor's page
			// cross reads only because its pages are never empty).
			if (hours.every(v => !v || v <= 0)) {
				const text = _('No activity');
				ctx.selectFontFace('Sans', 0, 0);
				const fontSize = Math.max(10, Math.round(12 * s));
				ctx.setFontSize(fontSize);
				const ext = ctx.textExtents(text);
				ctx.setSourceRGBA(r, g, b, 0.35);
				ctx.moveTo(
					Math.max(0, (canvasWidth - ext.width) / 2),
					Math.max(fontSize, (canvasHeight - ext.height) / 2 + fontSize * 0.35),
				);
				ctx.showText(text);
			}
			ctx.$dispose();
		};

		// The live day view — the page that renderDynamic keeps updating.
		const liveDayView = () => ({
			hours: state.snapshot ? state.snapshot.hours : [],
			scaleMax: computeScaleMaxSeconds(state.snapshot ? state.snapshot.hours : []),
			hourKeys: state.snapshot ? state.snapshot.hourKeys ?? null : null,
			topKey: state.categorySummary && state.categorySummary[0]
				? state.categorySummary[0].key : null,
		});

		chartCanvas.connect('repaint', (area) => {
			drawDayChart(area, liveDayView());
		});
	}

	// ── 2x2 stack: top-app legend + two-column bottom band ─────────────────
	let legendBox = null;
	let appsBand = null;
	let bandColumns = null;
	let bandGrid = null;
	if (isLarge) {
		legendBox = new St.BoxLayout({
			orientation: Clutter.Orientation.HORIZONTAL,
		});
		largeRoot.add_child(legendBox);

		// The band stretches over whatever the chart leaves free so its tint
		// always reaches the widget's bottom edge. A BinLayout centers the
		// row grid vertically inside it — the space above the first row and
		// below the last one is equal BY CONSTRUCTION, no padding math, no
		// measurement feedback, nothing to drift.
		appsBand = new St.Widget({
			layout_manager: new Clutter.BinLayout(),
			y_expand: true,
			clip_to_allocation: true,
		});
		bandGrid = new St.BoxLayout({
			x_expand: true,
			// BinLayout honors the child actor's alignment — centering the grid
			// gives equal space above the first row and below the last one.
			y_align: Clutter.ActorAlign.CENTER,
		});
		appsBand.add_child(bandGrid);
		bandColumns = [0, 1].map(() => new St.BoxLayout({
			orientation: Clutter.Orientation.VERTICAL,
			x_expand: true,
		}));
		bandColumns.forEach(column => bandGrid.add_child(column));
		largeRoot.add_child(appsBand);
	}

	// ── App list (2x1 side panel) ──────────────────────────────────────────
	const appRowsBox = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: 'spacing: 14px;',
	});
	// The compact 1x1 card carries no app rows; the box stays detached.
	// The 2x2 card has the band instead.
	if (!compactSquare && !isLarge)
		rightPanel.add_child(appRowsBox);

	// Acquire tracking: engine starts collecting data when first widget acquires
	state.releaseEngine = screenTimeEngine.acquire();
	state.selectedDate = lastSelectedDate ?? screenTimeEngine.getTodayDate();

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

	// Live toggle for the date-nav arrows: flip their visibility in place —
	// no widget rebuild needed.
	const settingsSignals = [];
	if (settings?.connect) {
		settingsSignals.push(settings.connect(
			'changed::screentime-show-nav-buttons',
			() => {
				if (isActorDestroyed(body) || !body.get_parent()) return;
				const show = settings.get_boolean('screentime-show-nav-buttons') ?? true;
				navButtonsRow.visible = show;
				controlsColumn.visible = show || !compactSquare;
			},
		));
	}

	let engineCleaned = false;
	const cleanup = () => {
		if (engineCleaned) return;
		engineCleaned = true;
		if (state.releaseEngine) {
			state.releaseEngine();
			state.releaseEngine = null;
		}
		if (state.engineListener) {
			screenTimeEngine.removeListener(state.engineListener);
			state.engineListener = null;
		}
		settingsSignals.forEach(id => settings.disconnect(id));
		settingsSignals.length = 0;
	};
	// The root dies on every refill (theme/style change re-fills the body in
	// place, destroying only children) — anchor the engine release there or
	// every re-render leaks one more engine acquire.
	root.connect('destroy', cleanup);
	body.connect('destroy', cleanup);

	function refreshData() {
		if (!rootAlive || isActorDestroyed(body) || !body.get_parent()) return;
		// Write-through: every day switch funnels through here, so the
		// browsed day survives re-renders (theme/style changes).
		lastSelectedDate = state.selectedDate;
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
	// The 2x2 category summary aggregates more than the visible slice, so the
	// fingerprint covers more apps than the band shows.
	function appListSignature(snapshot) {
		return JSON.stringify(snapshot.apps.slice(0, 12).map(app => [app.key, Math.floor(app.seconds / 60)]));
	}

	function renderDynamic() {
		if (!rootAlive) return;
		if (!state.snapshot) return;

		totalTimeLabel.text = formatCompactDuration(state.snapshot.totalSeconds);
		state.categorySummary = buildCategorySummary(state.snapshot.apps);

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
			formatAxisDuration(scaleMax),
			formatAxisDuration(scaleMax / 2),
			'0',
		];
		yAxisLabels.forEach((label, index) => label.set_text(labels[index]));
	}

	function resolveAppName(appKey) {
		try {
			const info = resolveDesktopAppInfo(appKey);
			return info ? (info.get_name() || appKey) : appKey;
		} catch (e) {
			return appKey;
		}
	}

	// Shared row builder: the 2x1 side panel shows icon + duration only; the
	// 2x2 band adds the app name between icon and duration.
	function buildAppRow(app, px, withName) {
		// Icon pinned left, the label right after it — every value starts at
		// the same x so short ("6m") and long ("1h 53m") stay aligned.
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

		if (withName) {
			// Two-line row (reference design): app name on top, its duration
			// right under it — the trailing "13m | next icon" stack reads
			// cluttered, the stacked layout keeps every column self-contained.
			const textCol = new St.BoxLayout({
				orientation: Clutter.Orientation.VERTICAL,
				x_expand: true,
				y_align: Clutter.ActorAlign.CENTER,
				style: 'spacing: 1px;',
			});

			const nameLabel = new St.Label({
				text: resolveAppName(app.key),
				style: `color: ${textColor}; font-size: ${px(APP_BAND_FONT_SIZE_PX)}px; `
					+ `font-weight: 600; opacity: 0.92;`,
			});
			nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
			textCol.add_child(nameLabel);

			const durationLabel = new St.Label({
				text: formatCompactDuration(app.seconds),
				style: `color: ${textColor}; font-size: ${px(Math.round(APP_BAND_FONT_SIZE_PX * 0.92))}px; `
					+ `font-weight: 600; opacity: ${SECONDARY_TEXT_OPACITY};`,
			});
			textCol.add_child(durationLabel);
			row.add_child(textCol);
		} else {
			const durationLabel = new St.Label({
				text: formatCompactDuration(app.seconds),
				x_expand: true,
				y_align: Clutter.ActorAlign.CENTER,
				style: `color: ${textColor}; font-size: ${px(APP_TIME_FONT_SIZE_PX)}px; `
					+ `font-weight: 600; opacity: ${SECONDARY_TEXT_OPACITY};`,
			});
			durationLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
			row.add_child(durationLabel);
		}

		return row;
	}

	// 2x2 legend: the top CATEGORIES with their total time, spread across the
	// row — the same colors the hour bars paint for each app's dominant bucket.
	// The leading category keeps the theme accent.
	function rebuildLegend() {
		legendBox.destroy_all_children();
		const s = state.geometry.scale || 1;
		const chips = (state.categorySummary || []).slice(0, LEGEND_TOP_APPS);
		if (chips.length === 0) {
			legendBox.add_child(new St.Label({
				text: _('No activity recorded'),
				x_expand: true,
				x_align: Clutter.ActorAlign.START,
				style: `color: ${textColor}; font-size: ${Math.max(1, Math.round(LEGEND_FONT_SIZE_PX * s))}px; `
					+ `font-weight: 700; opacity: ${SECONDARY_TEXT_OPACITY};`,
			}));
			return;
		}
		const chipAligns = [
			Clutter.ActorAlign.START, Clutter.ActorAlign.CENTER, Clutter.ActorAlign.END,
		];
		for (let i = 0; i < chips.length; i++) {
			// Two-line chip (reference design): the colored category on top,
			// its time right under it in plain theme text color.
			const chip = new St.BoxLayout({
				orientation: Clutter.Orientation.VERTICAL,
				x_expand: true,
				x_align: chipAligns[i],
				style: 'spacing: 1px;',
			});

			const chipName = new St.Label({
				text: appCategoryLabel(chips[i].key),
				style: `color: ${i === 0 ? accentHex : appPaletteCss(chips[i].key, isLightBg)}; `
					+ `font-size: ${Math.max(1, Math.round(LEGEND_FONT_SIZE_PX * s))}px; font-weight: 700;`,
			});
			chipName.clutter_text.ellipsize = Pango.EllipsizeMode.END;
			chip.add_child(chipName);

			const chipTime = new St.Label({
				text: formatCompactDuration(chips[i].seconds),
				style: `color: ${textColor}; `
					+ `font-size: ${Math.max(1, Math.round(LEGEND_FONT_SIZE_PX * 0.92 * s))}px; font-weight: 600;`,
			});
			chip.add_child(chipTime);

			legendBox.add_child(chip);
		}
	}

	// 2x2 band: two columns, filled left column first (apps 0..n-1 left,
	// n..2n-1 right), rows of icon + name + duration.
	function rebuildAppBand() {
		bandColumns.forEach(column => column.destroy_all_children());
		const s = state.geometry.scale || 1;
		const px = (v) => Math.max(1, Math.round(v * s));
		const rows = state.geometry.bandRows || 1;
		const apps = state.snapshot.apps.slice(0, Math.min(rows * 2, config.maxApps));

		if (apps.length === 0) {
			bandColumns[0].add_child(new St.Label({
				text: _('No activity recorded'),
				style: `color: ${textColor}; font-size: ${px(APP_BAND_FONT_SIZE_PX)}px; `
					+ `font-weight: 600; opacity: ${SECONDARY_TEXT_OPACITY};`,
			}));
			return;
		}

		for (let i = 0; i < apps.length; i++) {
			try {
				const column = bandColumns[i < rows ? 0 : 1];
				column.add_child(buildAppRow(apps[i], px, true));
			} catch (e) {
				// Keep the rest of the band intact if one row fails to build.
			}
		}

		// applyLayout derives the row count from the app count; if the count
		// changed since the last layout (fresh data arrived), re-layout so the
		// band re-sizes and the chart re-absorbs the difference. The FULL
		// apps list is used here — the sliced one is capped by the old row
		// count and would pin the row count in place forever.
		const needed = Math.max(1, Math.min(LARGE_APP_ROWS_MAX,
			Math.ceil(Math.min(state.snapshot.apps.length, config.maxApps) / 2)));
		if (rows !== needed) {
			state.geometry.bandRows = needed;
			// applyLayout is skipped when the size did not change — flag a
			// dirty re-layout so the row count actually takes effect.
			state.geometry.layoutDirty = true;
			scheduleUpdate();
			return;
		}

		// Fixed row gap. Nothing else: the BinLayout container centers the
		// grid inside the band, so every pixel of extra space splits evenly
		// above the first row and below the last one automatically.
		const gap = Math.round(4 * s);
		bandColumns.forEach(column => {
			column.style = `spacing: ${gap}px;`;
		});
	}

	function rebuildAppList() {
		if (isLarge) {
			rebuildLegend();
			rebuildAppBand();
			return;
		}
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
				appRowsBox.add_child(buildAppRow(app, px, false));
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
			// A slim bottom margin — the 00/12/24 axis labels sit close to
			// the card's bottom edge.
			const padBottom = Math.round(6 * s);
			compactBox.style = `padding: ${padTop}px ${padSide}px ${padBottom}px ${padSide}px;`;

			// The header's NATURAL height (~28px: the 21px total label, the
			// arrows are no taller). An inflated estimate here leaves dead
			// space under the axis — the labels stop hugging the bottom edge.
			const headerReserve = Math.round(30 * s);
			const yWidth = Math.round(30 * s);
			const axisH = Math.round(X_AXIS_HEIGHT_PX * s);
			const plotWidth = Math.max(1, currentWidth - padSide * 2 - yWidth);
			const plotHeight = Math.max(1, currentHeight - padTop - padBottom
				- headerReserve - axisH - Math.round(12 * s));
			Object.assign(state.geometry, { plotWidth, plotHeight });

			// The plot sits a touch lower than the header (the reference design
			// leaves breathing room between the total and the top gridline).
			const plotOffset = Math.round(12 * s);
			chartCanvas.set_position(0, plotOffset);
			chartCanvas.set_size(plotWidth, plotHeight);
			yAxisBox.set_position(plotWidth, plotOffset);
			yAxisBox.set_size(yWidth, plotHeight);
			// The axis is compactBox's last stacked child: the vertical stack
			// pins it right above the bottom padding regardless of how much
			// slack the y-expanding chartWrap absorbs. It only needs the
			// plot's exact width/margins for mark alignment with the plot.
			xAxisBox.set_size(plotWidth, axisH);
			xAxisBox.x_expand = true;
			xAxisBox.style = `margin: 0 ${Math.round(padSide + yWidth)}px 0 ${Math.round(padSide)}px;`;

			// A smaller fixed total size: the longest realistic value —
			// "1h 53m" — keeps fitting next to the arrows, and every value
			// ("1h" vs "1h 53m") renders at the SAME size, no jumping.
			totalTimeLabel.style = `color: ${textColor}; font-size: ${Math.round(21 * s)}px; font-weight: 600;`;

			renderDynamic();
			return;
		}

		if (isLarge) {
			// ── 2x2 stack layout ──────────────────────────────────────────
			largeRoot.set_size(currentWidth, currentHeight);
			const padSide = Math.round(16 * s);
			const padTop = Math.round(12 * s);
			const yWidth = Math.round(Y_AXIS_WIDTH_PX * s);
			const axisH = Math.round(X_AXIS_HEIGHT_PX * s);
			// Header natural height estimate (avatar/total/nav row) — kept
			// conservative so the band never claims rows that would overflow.
			const headerEstimate = Math.round(38 * s);
			const headerMargin = Math.round(6 * s);
			const legendMargin = Math.round(6 * s);
			const legendH = Math.round(LEGEND_FONT_SIZE_PX * 1.25 * s)
				+ Math.round(LEGEND_FONT_SIZE_PX * 0.92 * 1.25 * s) + Math.round(1 * s);

			headerBox.style = `margin: ${padTop}px ${padSide}px ${headerMargin}px ${padSide}px;`;
			// The one-row header centers the big total against the nav arrows.
			totalTimeLabel.y_align = Clutter.ActorAlign.CENTER;
			totalTimeLabel.style = `color: ${textColor}; font-size: ${Math.round(HEADER_FONT_SIZE_PX * s * 0.9)}px; font-weight: 600;`;
			prevButton.style = `width: ${Math.round(NAV_BUTTON_SIZE_PX * s)}px; height: ${Math.round(NAV_BUTTON_SIZE_PX * s)}px;`
				+ `border: 1px solid ${textRgba(0.14)}; border-radius: ${Math.round(6 * s)}px; background-color: transparent;`;
			nextButton.style = prevButton.style;

			// Content-sized band: the row count derives from the app count, and
			// the chart absorbs whatever the band does not need.
			const xAxisZone = Math.round(4 * s) + axisH;
			const bandPadEdge = Math.round(4 * s);
			const bandGap = Math.round(4 * s);
			// Measure the row's true natural height; re-measure whenever the
			// scale changed (a mid-animation layout at boot may have cached a
			// wrong-scale value, which would visibly inflate the band until
			// the next layout pass).
			if (!state.geometry.measuredRowH || state.geometry.measuredRowH.s !== s) {
				try {
					const px0 = (v) => Math.max(1, Math.round(v * s));
					const probe = buildAppRow({ key: '', seconds: 60000 }, px0, true);
					bandColumns[0].add_child(probe);
					const natural = Math.ceil(probe.get_preferred_height(-1)[1]);
					bandColumns[0].remove_child(probe);
					probe.destroy();
					if (natural > 0)
						state.geometry.measuredRowH = {
							h: Math.max(Math.round(APP_ICON_SIZE_PX * s), natural),
							s,
						};
				} catch (e) {
					// Fall back to the estimate below if probing fails.
				}
			}
			const cachedRow = state.geometry.measuredRowH;
			const bandRowH = Math.max(
				Math.round(APP_ICON_SIZE_PX * s),
				cachedRow && cachedRow.s === s ? cachedRow.h : Math.round(BAND_ROW_H_PX * s),
			);
			const appsCount = Math.min(state.snapshot?.apps?.length ?? 0, config.maxApps);
			const bandRowsNeeded = Math.max(1, Math.min(LARGE_APP_ROWS_MAX, Math.ceil(appsCount / 2)));
			const bandH = bandRowsNeeded * bandRowH + (bandRowsNeeded - 1) * bandGap
				+ bandPadEdge * 2;
			const freeForChart = currentHeight - padTop - headerEstimate - headerMargin
				- xAxisZone - (legendMargin * 2 + legendH) - bandH;
			// The chart takes everything above the band's content height (no
			// upper cap), so the chart top part grows from the leftover space.
			const chartZoneH = Math.max(90, freeForChart);
			chartWrap.set_height(chartZoneH + xAxisZone);
			chartWrap.style = `margin: 0 ${padSide}px;`;
			legendBox.style = `margin: ${legendMargin}px ${padSide}px;`;

			const plotWidth = Math.max(1, currentWidth - padSide * 2 - yWidth);
			Object.assign(state.geometry, {
				plotWidth,
				plotHeight: chartZoneH,
				largeChart: true,
				largeBarWidth: Math.min(12, Math.max(5, Math.round(plotWidth / HOURS_PER_DAY * 0.5))),
			});
			chartCanvas.set_position(0, 0);
			chartCanvas.set_size(plotWidth, chartZoneH);
			yAxisBox.set_position(plotWidth, 0);
			yAxisBox.set_size(yWidth, chartZoneH);
			xAxisBox.set_position(0, chartZoneH + Math.round(4 * s));
			xAxisBox.set_size(plotWidth, axisH);

			state.geometry.bandRows = bandRowsNeeded;
			// The rebuild trigger compares listHeight: the band height stands in
			// for the side panel's height so the rows rebuild only when the
			// geometry really moved.
			state.geometry.listHeight = bandH;
			// Only horizontal padding on the band itself — the vertical space
			// is handled by the BinLayout's centering, so it can never go
			// asymmetric.
			appsBand.style = `background-color: ${sideBg}; border-radius: 0 0 ${radius}px ${radius}px;`
				+ `padding: 0 ${padSide}px;`;

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
	// Widget frame padding is 0 for this widget (style() override) — only the
	// border still insets the content box on each side.
	const CLIP_INSET = (theme.borderWidth ?? 1);
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
		if (disposed || !rootAlive || relayouting) return;
		// A data change can require a re-layout (e.g. the app band's row count
		// changed) even when the size did not — the dirty flag lets the
		// rebuild request one through the size guard.
		const layoutDirty = state.geometry.layoutDirty === true;
		const currentWidth = contentWidth();
		const currentHeight = contentHeight();
		if (currentWidth === lastWidth && currentHeight === lastHeight && !layoutDirty) return;
		state.geometry.layoutDirty = false;
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
	// settled instead of on each frame. (Declared as a function so rebuilds
	// that may run inside applyLayout can always reach it.)
	function scheduleUpdate() {
		if (disposed) return;
		if (updateId) GLib.source_remove(updateId);
		updateId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
			updateId = 0;
			update();
			return GLib.SOURCE_REMOVE;
		});
	}

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
	// REILLS keep the body alive — destroy_all_children() only kills our
	// root — while the engine listener and every rebuild keep firing on
	// root's now-orphanned actors. The root's own death is the only
	// reliable full-stop (the flag itself is declared at the top of render;
	// a TDZ ReferenceError here once killed every data refresh).
	root.connect('destroy', () => { rootAlive = false; });
	root.connect('destroy', cleanup);
	GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
		if (!disposed) {
			update();
		}
		return GLib.SOURCE_REMOVE;
	});

	// Pre-measuring moved into applyLayout (probes the row at the same scale
	// the layout actually uses; a render-time probe captured mid-animation
	// sizes at boot and inflated the band until the next pass).

	refreshData();
}