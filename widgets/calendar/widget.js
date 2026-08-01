import Clutter from 'gi://Clutter';
import St from 'gi://St';

export const type = 'calendar';
export const label = 'Calendar';
export const stylesheet = 'widgets/calendar/stylesheet.css';
export const appIds = ['org.gnome.Calendar.desktop'];
export const defaultSize = 'small';

const CALENDAR_CELL_WIDTH = 24;
const CALENDAR_CELL_HEIGHT = 24;
const COMPACT_CALENDAR_CELL_HEIGHT = 23;

function formatMonth(date) {
	return date.toLocaleDateString(undefined, {
		month: 'long',
		year: 'numeric',
	});
};

function calendarCell(text, labelStyle, cellStyle, createLabel, cellHeight) {
	const binParams = {
		style_class: 'widget-calendar-cell',
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		x_expand: false,
		y_expand: false,
	};

	if (cellStyle) {
		binParams.style = cellStyle;
	};

	const bin = new St.Bin(binParams);
	const labelActor = createLabel(text, 'widget-calendar-day', labelStyle);

	labelActor.x_expand = false;
	labelActor.x_align = Clutter.ActorAlign.CENTER;
	labelActor.y_align = Clutter.ActorAlign.CENTER;
	bin.set_size(CALENDAR_CELL_WIDTH, cellHeight);
	bin.set_child(labelActor);
	return bin;
};

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text}; padding: 12px 15px;`;
};

export function render({body, createLabel, theme}) {
	const now = new Date();
	const year = now.getFullYear();
	const month = now.getMonth();
	const today = now.getDate();
	const first = new Date(year, month, 1);
	const days = new Date(year, month + 1, 0).getDate();
	const start = first.getDay();
	const weekCount = Math.ceil((start + days) / 7);
	const compact = weekCount === 6;
	const cellHeight = compact ? COMPACT_CALENDAR_CELL_HEIGHT : CALENDAR_CELL_HEIGHT;
	const monthLabel = createLabel(
		formatMonth(now),
		'widget-calendar-month',
		`color: ${theme.text};`);
	const grid = new St.BoxLayout({
		vertical: true,
		style_class: compact ? 'widget-calendar-grid widget-calendar-grid-compact' : 'widget-calendar-grid',
		x_align: Clutter.ActorAlign.CENTER,
	});
	const content = new St.BoxLayout({
		vertical: true,
		style_class: 'widget-calendar-content',
		x_align: Clutter.ActorAlign.CENTER,
	});
	const weekdays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
	const weekdayRow = new St.BoxLayout({style_class: 'widget-calendar-row'});
	let day = 1;

	monthLabel.x_expand = false;
	content.add_child(monthLabel);
	for (const weekday of weekdays) {
		weekdayRow.add_child(calendarCell(weekday, `color: ${theme.muted}; font-weight: 700;`, null, createLabel, cellHeight));
	};
	grid.add_child(weekdayRow);

	for (let rowIndex = 0; rowIndex < weekCount; rowIndex++) {
		const row = new St.BoxLayout({style_class: 'widget-calendar-row'});

		for (let column = 0; column < 7; column++) {
			if ((rowIndex === 0 && column < start) || day > days) {
				row.add_child(calendarCell('', '', null, createLabel, cellHeight));
				continue;
			};

			const isToday = day === today;
			const labelStyle = isToday
				? 'color: #ffffff; font-weight: 800;'
				: `color: ${theme.text};`;
			const cellStyle = isToday
				? `background-color: ${theme.accent}; border-radius: 999px;`
				: null;

			row.add_child(calendarCell(String(day), labelStyle, cellStyle, createLabel, cellHeight));
			day++;
		};

		grid.add_child(row);
	};

	content.add_child(grid);
	body.add_child(new St.Widget({y_expand: true}));
	body.add_child(content);
	body.add_child(new St.Widget({y_expand: true}));
};
