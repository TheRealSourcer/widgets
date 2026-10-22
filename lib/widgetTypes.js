// Widget type catalogue shared by BOTH processes: the GNOME Shell side
// (extension.js + the widget stack feature) and the prefs window (GTK).
//
// The maps hold UNTRANSLATED gettext keys only — this module must never
// import gettext from a shell resource URI, because the prefs process
// imports it too and a shell-only import there would pull the whole
// widget tree into a process without Main. Each caller wraps the values
// with its own gettext (`_(WIDGET_TYPE_LABELS[type])`).

// Cap for the "widget in widget" page count per primary widget.
export const MAX_STACK_PAGES = 3;

export const WIDGET_TYPE_LABELS = {
	applauncher: 'App Launcher',
	clock: 'Clock',
	digitalclock: 'Digital Clock',
	binaryclock: 'Binary Clock',
	calendar: 'Calendar',
	weather: 'Weather',
	photos: 'Photos',
	battery: 'Battery',
	music: 'Music',
	todo: 'Task',
	github: 'GitHub Activity',
	screentime: 'Screen Time',
	system: 'System Monitor',
	notes: 'Notes',
	pomodoro: 'Pomodoro',
	lava: 'Lava Lamp',
	stopwatch: 'Stopwatch',
	folder: 'Folder Launcher',
	timer: 'Timer',
};

// Short hints under the tiles in the widget-pages gallery window.
export const GALLERY_HINTS = {
	weather: 'Current weather and forecast',
	calendar: 'Month, events and day glance',
	screentime: 'Per-day usage chart',
	system: 'CPU, RAM, network tiles',
	music: 'Player with cover and lyrics',
	todo: 'Task list with editor',
	notes: 'Quick notes',
	binaryclock: 'Binary digits clock',
	digitalclock: 'Digital clock',
	clock: 'Analog clock',
	battery: 'Level and charging state',
	pomodoro: 'Work/break timer',
	stopwatch: 'Stopwatch',
	timer: 'Countdown timer',
	github: 'Contribution graph',
	photos: 'Photo frame',
	applauncher: 'Application launcher grid',
	lava: 'Lava lamp motion',
	folder: 'Folder of launchers',
};
