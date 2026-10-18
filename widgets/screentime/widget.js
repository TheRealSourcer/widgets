import St from 'gi://St';
import {surfaceStyle, watchSettings} from '../../utils/widget.js';
import {VERTICAL, HORIZONTAL} from '../../compatibility.js';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import {setButtonStyle} from '../../utils/buttonStyle.js';

import { screenTimeEngine } from '../../utils/screenTimeEngine.js';
import {parseCssColor, cssColorToRgba} from '../../utils/colors.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

export const type = 'screentime';
export const label = 'Screen Time';
export const stylesheet = 'widgets/screentime/stylesheet.css';
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium', 'large'];

const REF_WIDTH = 360;
const REF_HEIGHT = 170;

const MAIN_PANEL_WIDTH_RATIO = 0.65;
const SIDE_PANEL_LIGHTEN = 0.08;

const Y_AXIS_WIDTH_PX = 35;
const X_AXIS_HEIGHT_PX = 15;
const BAR_WIDTH_PX = 4;
const HOURS_PER_DAY = 24;

const MIN_SCALE_SECONDS = 300;
const HEADER_RESERVED_HEIGHT_PX = 46;
const HEADER_MARGIN_BOTTOM_PX = 12;

const HEADER_FONT_SIZE_PX = 32;

const APP_TIME_FONT_SIZE_PX = 16;
const NAV_BUTTON_SIZE_PX = 26;
const NAV_ICON_SIZE_PX = 16;
const APP_ICON_SIZE_PX = 24;
const SECONDARY_TEXT_OPACITY = 0.63;
const DISABLED_CONTROL_OPACITY = Math.round(255 * SECONDARY_TEXT_OPACITY);
const GRID_LINE_ALPHA = 0.3;


const monthNames = () =>
	[_('Jan'), _('Feb'), _('Mar'), _('Apr'), _('May'), _('Jun'),
		_('Jul'), _('Aug'), _('Sep'), _('Oct'), _('Nov'), _('Dec')];

export function style(theme) {
	return surfaceStyle(theme);
};

function toDateString(dt) {
	return `${dt.get_year()}-${String(dt.get_month()).padStart(2, '0')}-${String(dt.get_day_of_month()).padStart(2, '0')}`;
};

function addDays(dateString, delta) {
	const [y, m, d] = dateString.split('-').map(Number);
	const next = GLib.DateTime.new_local(y, m, d, 12, 0, 0).add_days(delta);
	return toDateString(next);
};

function formatShortDate(dateString) {
	const [, m, d] = dateString.split('-').map(Number);
	return `${d} ${monthNames()[m - 1]}`;
};

function formatCompactDuration(totalSeconds) {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	if (hours > 0) {
		return _('%sh %sm').format(hours, minutes.toString().padStart(2, '0'));
	};
	return _('%sm').format(minutes);
};

function computeScaleMaxSeconds(hours) {
	let maxSeconds = 0;
	for (const seconds of hours)
		maxSeconds = Math.max(maxSeconds, seconds);
	const base = Math.max(MIN_SCALE_SECONDS, maxSeconds);
	return Math.ceil(base / MIN_SCALE_SECONDS) * MIN_SCALE_SECONDS;
};

function shadePanelColor(cssColor, amount) {
	const {r, g, b, a} = parseCssColor(cssColor);
	const isDark = (r * 0.299 + g * 0.587 + b * 0.114) < 0.5;
	const mix = channel => isDark
		? Math.round(((channel * (1 - amount)) + amount) * 255)
		: Math.round(channel * 255 * (1 - amount));
	return `rgba(${mix(r)}, ${mix(g)}, ${mix(b)}, ${a})`;
};

let GioUnix = null;
try {
	GioUnix = (await import('gi://GioUnix')).default;
} catch {
	GioUnix = null;
};
const appInfoCache = new Map();
function resolveDesktopAppInfo(appKey) {
	if (!appInfoCache.has(appKey)) {
		try {
			const AppInfoClass = GioUnix?.DesktopAppInfo?.new ? GioUnix.DesktopAppInfo : Gio.DesktopAppInfo;
			appInfoCache.set(appKey, AppInfoClass.new(appKey));
		} catch {
			appInfoCache.set(appKey, null);
		};
	};
	return appInfoCache.get(appKey);
};

const SIZE_CONFIGS = {
	small:      {showChart: false, maxApps: 3},
	medium:     {showChart: true, maxApps: 4},
	tall:       {showChart: true, maxApps: 7},
	large:      {showChart: true, maxApps: 8},
	wide:       {showChart: true, maxApps: 5},
	huge:       {showChart: true, maxApps: 10},
};

const DEFAULT_CONFIG = SIZE_CONFIGS.medium;

export function render({body, actor, theme, sizeForWidget, widget, settings, refresh}) {
	watchSettings(body, settings, ['screentime-retention-days'], refresh);
	const size = widget?.size && SIZE_CONFIGS[widget.size] ? widget.size : defaultSize;
	const config = SIZE_CONFIGS[size] ?? DEFAULT_CONFIG;

	const [widgetWidth, widgetHeight] = sizeForWidget ? sizeForWidget(widget) : [394, 190];

	if (settings?.get_int) {
		try {
			screenTimeEngine.setRetentionDays(settings.get_int('screentime-retention-days'));
		} catch (error) {
			console.debug(`Using default Screen Time retention: ${error}`);
			screenTimeEngine.setRetentionDays();
		};
	} else {
		screenTimeEngine.setRetentionDays();
	};
	const textColor = theme?.text ?? '#ffffff';
	const bgColor = theme?.background ?? '#242424';
	const panelBgColor = theme?.blur ? 'transparent' : bgColor;
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
		disposed: false,

		layoutIdleId: 0,
	};

	body.clip_to_allocation = true;

	const splitBox = new St.BoxLayout({
		...HORIZONTAL,
		style_class: 'screentime-widget',
		x_expand: true,
		y_expand: false,
		y_align: Clutter.ActorAlign.START,
		clip_to_allocation: true,
	});
	body.add_child(splitBox);

	const leftPanel = new St.BoxLayout({
		...VERTICAL,
		y_expand: true,
		clip_to_allocation: true,
		style: `background-color: ${panelBgColor}; border-radius: ${radius}px 0 0 ${radius}px;`,
	});
	splitBox.add_child(leftPanel);

	const sideBgColor = theme?.blur
		? cssColorToRgba(textColor, 0.06)
		: shadePanelColor(bgColor, SIDE_PANEL_LIGHTEN);
	const rightPanel = new St.BoxLayout({
		...VERTICAL,
		y_expand: true,
		clip_to_allocation: true,
		style: `background-color: ${sideBgColor}; border-radius: 0 ${radius}px ${radius}px 0;`,
	});
	splitBox.add_child(rightPanel);

	const headerBox = new St.BoxLayout({...HORIZONTAL});
	leftPanel.add_child(headerBox);

	const totalTimeLabel = new St.Label({
		style_class: 'widget-screentime-total',
		text: '0m',
		x_expand: true,
		y_align: Clutter.ActorAlign.START,
		style: `color: ${textColor};`,
	});
	headerBox.add_child(totalTimeLabel);

	const controlsColumn = new St.BoxLayout({
		...VERTICAL,
		x_align: Clutter.ActorAlign.END,
		style_class: 'widget-screentime-controls',
	});
	headerBox.add_child(controlsColumn);

	const dateLabel = new St.Label({
		style_class: 'widget-screentime-date',
		text: '',
		style: `color: ${textColor};`,
	});
	controlsColumn.add_child(dateLabel);

	const navButtonsRow = new St.BoxLayout({style_class: 'widget-screentime-controls'});
	controlsColumn.add_child(navButtonsRow);

	const buildNavButton = (iconName, action) => {
		const button = new St.Button({
			style_class: 'widget-action-button screentime-nav-button',
			reactive: true,
			can_focus: true,
			style: `border-color: ${textRgba(0.14)};`,
			child: new St.Icon({
				style_class: 'widget-screentime-nav-icon',
				icon_name: iconName,
				icon_size: NAV_ICON_SIZE_PX,
				style: `color: ${textColor};`,
			}),
		});
		setButtonStyle(button, button.style);
		button.connectObject('button-press-event', (_actor, event) => {
			if (event.get_button() !== 1) {
				return Clutter.EVENT_PROPAGATE;
			};
			action();
			return Clutter.EVENT_STOP;
		}, button);
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

	let chartWrap = null;
	let chartCanvas = null;
	let yAxisBox = null;
	let xAxisBox = null;
	let yAxisLabels = null;
	if (config.showChart) {
		chartWrap = new St.Widget({ x_expand: true, y_expand: true });
		leftPanel.add_child(chartWrap);

		chartCanvas = new St.DrawingArea();
		chartWrap.add_child(chartCanvas);

		const yAxisAlignments = [Clutter.ActorAlign.START, Clutter.ActorAlign.CENTER, Clutter.ActorAlign.END];
		yAxisLabels = ['0', '0', '0'].map((_, index) => new St.Label({
			style_class: 'widget-screentime-axis',
			y_expand: true,
			y_align: yAxisAlignments[index],
			x_align: Clutter.ActorAlign.END,
			style: `color: ${textColor};`,
		}));
		yAxisBox = new St.BoxLayout({
			...VERTICAL,
			x_align: Clutter.ActorAlign.END,
		});
		yAxisLabels.forEach(label => yAxisBox.add_child(label));
		chartWrap.add_child(yAxisBox);

		const xAxisAlignments = [Clutter.ActorAlign.START, Clutter.ActorAlign.CENTER, Clutter.ActorAlign.END];
		const xAxisLabels = ['00:00', '12:00', '24:00'].map((text, index) => new St.Label({
			text,
			style_class: 'widget-screentime-axis',
			x_expand: true,
			x_align: xAxisAlignments[index],
			style: `color: ${textColor};`,
		}));
		xAxisBox = new St.BoxLayout({...HORIZONTAL});
		xAxisLabels.forEach(label => xAxisBox.add_child(label));
		chartWrap.add_child(xAxisBox);

		chartCanvas.connectObject('repaint', (area) => {
			const ctx = area.get_context();
			const [canvasWidth, canvasHeight] = area.get_surface_size();
			const { r, g, b } = parseCssColor(textColor);
			const s = state.geometry.scale || 1;

			if (!canvasWidth || !canvasHeight) {
				ctx.$dispose();
				return;
			};

			ctx.setOperator(0); // CAIRO_OPERATOR_CLEAR
			ctx.paint();
			ctx.setOperator(2); // CAIRO_OPERATOR_OVER

			ctx.setSourceRGBA(r, g, b, GRID_LINE_ALPHA);
			ctx.setLineWidth(1);
			ctx.setDash([3 * s, 3 * s], 0);

			for (let i = 0; i < 3; i++) {
				const y = Math.round((canvasHeight / 2) * i) + 0.5;
				ctx.moveTo(0, y);
				ctx.lineTo(canvasWidth, y);

				const x = Math.round((canvasWidth / 2) * i) + 0.5;
				ctx.moveTo(x, 0);
				ctx.lineTo(x, canvasHeight);
			};
			ctx.stroke();
			ctx.setDash([], 0);

			const hours = state.snapshot ? state.snapshot.hours : [];
			const scaleMax = computeScaleMaxSeconds(hours);
			const accent = parseCssColor(accentHex);
			ctx.setSourceRGBA(accent.r, accent.g, accent.b, 1);
			const barWidth = Math.round(BAR_WIDTH_PX * s);
			const barRadius = Math.round(BAR_WIDTH_PX / 2 * s);

			for (let hour = 0; hour < hours.length; hour++) {
				if (hours[hour] <= 0) {
					continue;
				};
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
			};
			ctx.fill();
			ctx.$dispose();
		}, chartCanvas);
	};

	const appRowsBox = new St.BoxLayout({
		...VERTICAL,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.START,
		y_align: Clutter.ActorAlign.START,
		style_class: 'widget-screentime-app-list',
	});
	rightPanel.add_child(appRowsBox);

	state.releaseEngine = screenTimeEngine.acquire();
	state.selectedDate = screenTimeEngine.getTodayDate();

	const onEngineTick = () => {
		if (state.selectedDate === screenTimeEngine.getTodayDate()) {
			refreshData();
		};
	};

	state.engineListener = onEngineTick;
	screenTimeEngine.addListener(onEngineTick);

	const cleanup = () => {
		if (state.disposed) return;
		state.disposed = true;
		if (state.engineListener) {
			screenTimeEngine.removeListener(state.engineListener);
			state.engineListener = null;
		};
		if (state.releaseEngine) {
			state.releaseEngine();
			state.releaseEngine = null;
		};
		if (state.layoutIdleId) {
			GLib.Source.remove(state.layoutIdleId);
			state.layoutIdleId = 0;
		};
		body.disconnectObject(splitBox);
	};

	splitBox.connectObject('destroy', cleanup, splitBox);

	function refreshData() {
		if (state.disposed || !body.get_parent()) return;
		if (state.selectedDate === screenTimeEngine.getTodayDate()) {
			state.snapshot = screenTimeEngine.getTodaySnapshot();
			renderDynamic();
		} else {
			const requestedDate = state.selectedDate;
			screenTimeEngine.loadDayAsync(requestedDate, (snapshot) => {
				if (state.disposed || !body.get_parent() || state.selectedDate !== requestedDate || snapshot.date !== requestedDate) return;
				state.snapshot = snapshot;
				renderDynamic();
			});
		};
	};

	function appListSignature(snapshot) {
		return JSON.stringify(snapshot.apps.slice(0, config.maxApps).map(app => [app.key, Math.floor(app.seconds / 60)]));
	};

	function renderDynamic() {
		if (state.disposed || !state.snapshot) return;

		totalTimeLabel.text = formatCompactDuration(state.snapshot.totalSeconds);
		dateLabel.text = formatShortDate(state.selectedDate);
		const isViewingToday = state.selectedDate === screenTimeEngine.getTodayDate();
		nextButton.set_opacity(isViewingToday ? DISABLED_CONTROL_OPACITY : 255);

		if (config.showChart) {
			updateYAxisLabels();
		};

		const signature = appListSignature(state.snapshot);
		if (signature !== state.lastAppListSignature) {
			state.lastAppListSignature = signature;
			rebuildAppList();
		};
		if (chartCanvas && state.geometry.plotWidth > 0) {
			chartCanvas.queue_repaint();
		};
	};

	function updateYAxisLabels() {
		const scaleMax = computeScaleMaxSeconds(state.snapshot.hours);
		const labels = [
			formatCompactDuration(scaleMax),
			formatCompactDuration(scaleMax / 2),
			'0',
		];
		yAxisLabels.forEach((label, index) => label.set_text(labels[index]));
	};

	function rebuildAppList() {
		appRowsBox.destroy_all_children();

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
				style_class: 'widget-screentime-empty',
				text: _('No activity recorded'),
				x_expand: true,
				x_align: Clutter.ActorAlign.CENTER,
				style: `color: ${textColor};`,
			}));
			return;
		};

		for (const app of apps) {
			try {
				const row = new St.BoxLayout({
					...HORIZONTAL,
					x_align: Clutter.ActorAlign.FILL,
					style_class: 'widget-screentime-app-row',
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
				if (gicon) {
					appIcon.gicon = gicon;
				};
				iconSlot.add_child(appIcon);
				row.add_child(iconSlot);

				const durationLabel = new St.Label({
					style_class: 'widget-screentime-duration',
					text: formatCompactDuration(app.seconds),
					x_expand: true,
					y_align: Clutter.ActorAlign.CENTER,
					style: `color: ${textColor}; font-size: ${px(APP_TIME_FONT_SIZE_PX)}px;`,
				});
				durationLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
				row.add_child(durationLabel);

				appRowsBox.add_child(row);
			} catch (error) {
				console.warn(`Could not display Screen Time application ${app.key}: ${error.message}`);
			};
		};
	};

	function applyLayout(currentWidth, currentHeight) {
		if (!currentWidth || !currentHeight) return;
		const s = Math.min(currentWidth / REF_WIDTH, currentHeight / REF_HEIGHT);
		if (!isFinite(s) || s <= 0) return;
		state.geometry.scale = s;

		const totalWidth = currentWidth;
		const mainWidth = Math.round(totalWidth * MAIN_PANEL_WIDTH_RATIO);
		leftPanel.set_width(mainWidth);
		rightPanel.set_width(totalWidth - mainWidth);

		splitBox.set_size(currentWidth, currentHeight);

		const padTop = Math.round(16 * s);
		const padBottom = Math.round(16 * s);
		const padLeft = Math.round(20 * s);
		const padRight = Math.round(12 * s);
		const sidePadding = Math.round(12 * s);
		state.geometry.listHeight = Math.max(0, currentHeight - padTop - padBottom);
		leftPanel.style = `background-color: ${panelBgColor}; border-radius: ${radius}px 0 0 ${radius}px;`
			+ `padding: ${padTop}px ${padRight}px ${padBottom}px ${padLeft}px;`;

		rightPanel.style = `background-color: ${sideBgColor}; border-radius: 0 ${radius}px ${radius}px 0;`
			+ `padding: ${padTop}px ${sidePadding}px;`;

		headerBox.style = `margin-bottom: ${Math.round(12 * s)}px; padding-right: ${Math.round(5 * s)}px;`;
		totalTimeLabel.style = `color: ${textColor}; font-size: ${Math.round(HEADER_FONT_SIZE_PX * s)}px;`;

		const navStyle = `width: ${Math.round(NAV_BUTTON_SIZE_PX * s)}px; height: ${Math.round(NAV_BUTTON_SIZE_PX * s)}px;`
			+ `border-color: ${textRgba(0.14)}; border-radius: ${Math.round(6 * s)}px;`;
		setButtonStyle(prevButton, navStyle);
		setButtonStyle(nextButton, navStyle);

		if (config.showChart) {
			const chartWrapWidth = mainWidth - padLeft - padRight;
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
		};

		appRowsBox.style = `spacing: ${Math.round(14 * s)}px;`;

		renderDynamic();
	};

	const borderInset = 1;
	const contentWidth = () => Math.max(1, (actor ? actor.width : widgetWidth) - borderInset * 2);
	const contentHeight = () => Math.max(1, (actor ? actor.height : widgetHeight) - borderInset * 2);

	applyLayout(contentWidth(), contentHeight());

	let lastWidth = -1;
	let lastHeight = -1;
	let relayouting = false;
	const update = () => {
		if (state.disposed || relayouting) return;
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
		};
	};
	const queueLayout = () => {
		if (state.disposed || state.layoutIdleId) return;
		state.layoutIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
			state.layoutIdleId = 0;
			if (!state.disposed) {
				update();
			};
			return GLib.SOURCE_REMOVE;
		});
	};
	body.connectObject('notify::width', queueLayout,
		'notify::height', queueLayout, splitBox);
	queueLayout();

	refreshData();
};

export function cleanup() {
	screenTimeEngine.cleanup();
	appInfoCache.clear();
};
