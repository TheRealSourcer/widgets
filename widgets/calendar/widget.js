import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {surfaceStyle} from '../../utils/widget.js';
import {VERTICAL, boxOrientation} from '../../compatibility.js';
import * as EventsWidget from '../events/widget.js';

export const type = 'calendar';
export const label = 'Calendar';
export const stylesheet = 'widgets/calendar/stylesheet.css';
export const appIds = ['org.gnome.Calendar.desktop'];
export const defaultSize = 'small';
export const supportedSizes = ['small', 'medium', 'large'];


function clamp(value, minimum, maximum) {
	return Math.max(minimum, Math.min(maximum, value));
};

function formatMonth(date) {
	return date.toLocaleDateString(undefined, {
		month: 'long',
		year: 'numeric',
	});
};

function localeCalendarInfo() {
	const localeName = Intl.DateTimeFormat().resolvedOptions().locale;
	let weekend = new Set([0, 6]);

	try {
		const locale = new Intl.Locale(localeName);
		const info = typeof locale.getWeekInfo === 'function'
			? locale.getWeekInfo()
			: locale.weekInfo;

		if (info) {
			const localeWeekend = (info.weekend ?? []).map(day => Number(day) % 7);
			if (localeWeekend.length > 0) {
				weekend = new Set(localeWeekend);
			};

			if (Number.isFinite(Number(info.firstDay))) return {firstDay: Number(info.firstDay) % 7, weekend};
		};
	} catch (_error) {
	};

	const shellFirstDay = Number(Shell.util_get_week_start());

	return {
		firstDay: Number.isInteger(shellFirstDay) && shellFirstDay >= 0 && shellFirstDay <= 6
			? shellFirstDay
			: 1,
		weekend,
	};
};

function weekdayLabels(firstDay) {
	const referenceDate = new Date(2024, 0, 1);
	const referenceDay = referenceDate.getDay();
	const formatter = new Intl.DateTimeFormat(undefined, {weekday: 'narrow'});

	return Array.from({length: 7}, (_unused, column) => {
		const nativeDay = (firstDay + column) % 7;
		const date = new Date(referenceDate);

		date.setDate(referenceDate.getDate() + (nativeDay - referenceDay + 7) % 7);
		return {nativeDay, text: formatter.format(date)};
	});
};

function calendarCell(text, labelStyle, cellStyle, createLabel, width, height, highlightSize, labelClass = '') {
	const cell = new St.Bin({
		style_class: 'widget-calendar-cell',
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		x_expand: false,
		y_expand: false,
	});
	const labelActor = createLabel(text, `widget-calendar-day ${labelClass}`.trim(), labelStyle);

	labelActor.x_expand = false;
	labelActor.x_align = Clutter.ActorAlign.CENTER;
	labelActor.y_align = Clutter.ActorAlign.CENTER;
	cell.set_size(width, height);

	if (cellStyle) {
		const highlight = new St.Bin({
			style_class: 'widget-calendar-today',
			style: cellStyle,
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
		});

		highlight.set_size(highlightSize, highlightSize);
		highlight.set_child(labelActor);
		cell.set_child(highlight);
	} else {
		cell.set_child(labelActor);
	};

	return cell;
};

function layoutForDimensions(width, height, weekCount, showMonth = true) {
	const contentWidth = Math.max(126, width - 30);
	const contentHeight = Math.max(112, height - 24);
	const aspect = contentWidth / contentHeight;
	const compact = contentWidth < 170 || contentHeight < 140;
	const large = contentWidth >= 330 && contentHeight >= 330;
	const tall = aspect < 0.78;
	const rowCount = weekCount + 1;
	const gap = clamp(Math.round(Math.min(contentWidth / 95, contentHeight / 85)), 1, large ? 5 : 3);
	const monthFont = clamp(Math.round(Math.min(
		contentWidth / (compact ? 9.5 : 8.5),
		contentHeight / (tall ? 15 : aspect > 1.45 ? 9.5 : 11))), 16, large ? 30 : 24);
	const monthHeight = showMonth ? Math.round(monthFont * 1.28) : 0;
	const gridHeight = Math.max(rowCount * 14, contentHeight - monthHeight - gap);
	const cellWidth = clamp(Math.floor((contentWidth - gap * 6) / 7), 17, 58);
	const cellHeight = clamp(Math.floor((gridHeight - gap * (rowCount - 1)) / rowCount), 14, tall ? 56 : 52);
	const glyphSize = Math.min(cellWidth, cellHeight);
	const dayFont = clamp(Math.floor(glyphSize * (compact ? 0.58 : 0.61)), 10, large ? 20 : 17);
	const weekdayFont = clamp(dayFont - 1, 9, large ? 17 : 15);
	const highlightSize = clamp(Math.round(glyphSize * 0.94), 14, large ? 38 : 32);

	return {cellWidth, cellHeight, dayFont, weekdayFont, monthFont, gap, highlightSize};
};

export function style(theme) {
	return surfaceStyle(theme);
};

export function render(context) {
	const {body, refresh} = context;
	watchCalendarDay(body, refresh);
	renderCalendar(context);
};

function watchCalendarDay(body, refresh) {
	let renderedDate = new Date().toDateString();
	let timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
		const today = new Date().toDateString();
		if (today !== renderedDate) {
			renderedDate = today;
			timerId = 0;
			refresh?.();
			return GLib.SOURCE_REMOVE;
		};
		return GLib.SOURCE_CONTINUE;
	});
	body.connectObject('destroy', () => {
		if (timerId) {
			GLib.Source.remove(timerId);
		};
		timerId = 0;
	}, body);
};

function renderCalendar({body, createLabel, theme, sizeForWidget, widget}) {
	const now = new Date();
	const year = now.getFullYear();
	const month = now.getMonth();
	const today = now.getDate();
	const days = new Date(year, month + 1, 0).getDate();
	const {firstDay, weekend} = localeCalendarInfo();
	const start = (new Date(year, month, 1).getDay() - firstDay + 7) % 7;
	const weekCount = Math.ceil((start + days) / 7);
	const [widgetWidth, widgetHeight] = sizeForWidget ? sizeForWidget(widget) : [220, 220];
	const split = widgetWidth >= 400 && widgetHeight >= 200;
	const mediumSplit = split && widget.size === 'medium';
	const columnGap = 12;
	const contentWidth = widgetWidth - (mediumSplit ? 32 : 30);
	const sidebarWidth = split
		? mediumSplit
			? Math.floor((contentWidth - columnGap) / 2)
			: clamp(Math.round(contentWidth * 0.31), 120, 160)
		: 0;
	const gridWidth = split ? contentWidth - sidebarWidth - columnGap : contentWidth;
	const layout = layoutForDimensions(split ? gridWidth + 30 : widgetWidth,
		mediumSplit ? widgetHeight - 2 : widgetHeight, weekCount, !split || mediumSplit);
	const weekendText = theme.dark ? 'rgba(255, 255, 255, 0.55)' : '#787680';
	const monthLabel = createLabel(
		mediumSplit ? now.toLocaleDateString(undefined, {month: 'long'}) : formatMonth(now),
		'widget-calendar-month',
		`color: ${theme.text}; font-size: ${layout.monthFont}px;`);
	const content = new St.BoxLayout({
		...boxOrientation(!split),
		style_class: `widget-calendar-content${mediumSplit ? ' widget-calendar-content-medium-split' : split ? ' widget-calendar-content-split' : ''}`,
		x_align: Clutter.ActorAlign.FILL,
		y_align: mediumSplit ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER,
		x_expand: true,
		y_expand: true,
		...(!split ? {style: `spacing: ${layout.gap}px;`} : {}),
	});
	const grid = new St.BoxLayout({
		...VERTICAL,
		style_class: 'widget-calendar-grid',
		x_align: mediumSplit ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
		...(mediumSplit ? {width: gridWidth} : {}),
		style: `spacing: ${layout.gap}px;`,
	});
	const weekdays = weekdayLabels(firstDay);
	const weekdayRow = new St.BoxLayout({
		style_class: 'widget-calendar-row',
		style: `spacing: ${layout.gap}px;`,
	});
	let day = 1;

	monthLabel.x_expand = false;
	monthLabel.x_align = Clutter.ActorAlign.START;
	if (split) {
		const dateColumn = new St.BoxLayout({
			...VERTICAL,
			width: sidebarWidth,
			y_align: mediumSplit ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER,
			y_expand: mediumSplit,
			style_class: 'widget-calendar-date-column',
		});
		const weekday = createLabel(now.toLocaleDateString(undefined, {weekday: 'long'}),
			'widget-calendar-feature-weekday',
			`color: ${theme.muted}; font-size: ${widgetHeight >= 400 ? 17 : 14}px;`);
		weekday.x_expand = false;
		dateColumn.add_child(weekday);
		const date = createLabel(String(today), 'widget-calendar-feature-date',
			`color: ${theme.text}; font-size: ${clamp(Math.round(widgetHeight * 0.27), 56, 106)}px;`);
		date.x_expand = false;
		dateColumn.add_child(date);
		if (mediumSplit) {
			dateColumn.add_child(new St.Widget({y_expand: true}));
			const eventsBody = new St.BoxLayout({
				...VERTICAL,
				style_class: 'widget-calendar-events',
				width: sidebarWidth,
				height: 80,
				x_expand: true,
				clip_to_allocation: true,
			});
			dateColumn.add_child(eventsBody);
			EventsWidget.render({
				body: eventsBody,
				widget,
				theme,
				sizeForWidget: () => [sidebarWidth, 80],
				compact: true,
			});
		} else {
			dateColumn.add_child(monthLabel);
		};
		content.add_child(dateColumn);
		if (mediumSplit) {
			grid.add_child(monthLabel);
		} else {
			content.add_child(new St.Widget({x_expand: true}));
			grid.x_align = Clutter.ActorAlign.END;
		};
	} else {
		content.add_child(monthLabel);
	};

	for (const weekday of weekdays) {
		const color = weekend.has(weekday.nativeDay) ? weekendText : theme.text;

		weekdayRow.add_child(calendarCell(
			weekday.text,
			`color: ${color}; font-size: ${layout.weekdayFont}px;`,
			null,
			createLabel,
			layout.cellWidth,
			layout.cellHeight,
			layout.highlightSize,
			'widget-calendar-weekday'));
	};
	if (mediumSplit) {
		content.connectObject('notify::mapped', () => {
			if (!content.mapped) return;
			const firstWeekday = weekdayRow.get_first_child().get_child();
			const [, weekdayWidth] = firstWeekday.get_preferred_width(-1);
			const monthIndent = Math.max(0, Math.round((layout.cellWidth - weekdayWidth) / 2));
			monthLabel.style = `color: ${theme.text}; font-size: ${layout.monthFont}px; margin-left: ${monthIndent}px;`;
		}, content);
	};
	grid.add_child(weekdayRow);

	for (let rowIndex = 0; rowIndex < weekCount; rowIndex++) {
		const row = new St.BoxLayout({
			style_class: 'widget-calendar-row',
			style: `spacing: ${layout.gap}px;`,
		});

		for (let column = 0; column < 7; column++) {
			if ((rowIndex === 0 && column < start) || day > days) {
				row.add_child(calendarCell(
					'', '', null, createLabel,
					layout.cellWidth, layout.cellHeight, layout.highlightSize));
				continue;
			};

			const nativeDay = (firstDay + column) % 7;
			const isToday = day === today;
			const labelStyle = isToday
				? `font-size: ${layout.dayFont}px;`
				: `color: ${weekend.has(nativeDay) ? weekendText : theme.text}; font-size: ${layout.dayFont}px;`;
			const cellStyle = isToday
				? `background-color: ${theme.accent};`
				: null;

			row.add_child(calendarCell(
				String(day),
				labelStyle,
				cellStyle,
				createLabel,
				layout.cellWidth,
				layout.cellHeight,
				layout.highlightSize));
			day++;
		};

		grid.add_child(row);
	};

	content.add_child(grid);
	body.add_child(content);
};
