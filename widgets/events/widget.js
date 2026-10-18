import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {surfaceStyle} from '../../utils/widget.js';
import {VERTICAL, HORIZONTAL} from '../../compatibility.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const type = 'events';
export const label = 'Events';
export const stylesheet = 'widgets/events/stylesheet.css';
export const appIds = ['org.gnome.Calendar.desktop'];
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium', 'large'];

const DAYS_AHEAD = 7;
const REFRESH_SECONDS = 5 * 60;
const SOURCE_REFRESH_DELAY_MS = 750;
const DEFAULT_COLOR = '#3584e4';

let edsModulesPromise = null;

function loadEdsModules() {
	if (!edsModulesPromise) {
		edsModulesPromise = Promise.all([
			import('gi://ECal?version=2.0'),
			import('gi://EDataServer?version=1.2'),
		]).then(([eCal, eDataServer]) => ({
			ECal: eCal.default,
			EDataServer: eDataServer.default,
		})).catch(() => null);
	};

	return edsModulesPromise;
};

function unwrapResult(value) {
	if (!Array.isArray(value)) return value;

	if (value.length === 2 && typeof value[0] === 'boolean') return value[1];

	return value.length === 1 ? value[0] : value;
};

function asArray(value) {
	const unwrapped = unwrapResult(value);

	if (!unwrapped) return [];
	if (Array.isArray(unwrapped)) return unwrapped;

	try {
		return Array.from(unwrapped);
	} catch (_error) {
		return [];
	};
};

function cancelled(error) {
	return Boolean(error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
};

function createSourceRegistry(EDataServer, cancellable) {
	return new Promise((resolve, reject) => {
		EDataServer.SourceRegistry.new(cancellable, (_source, result) => {
			try {
				resolve(EDataServer.SourceRegistry.new_finish(result));
			} catch (error) {
				reject(error);
			};
		});
	});
};

function sourceColor(source, EDataServer) {
	try {
		const extension = source.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR);
		const color = extension?.get_color?.() ?? extension?.color;

		return typeof color === 'string' && color.trim() ? color.trim() : DEFAULT_COLOR;
	} catch (_error) {
		return DEFAULT_COLOR;
	};
};

function sourceName(source) {
	try {
		return source.get_display_name?.() ?? source.display_name ?? '';
	} catch (_error) {
		return '';
	};
};

function dateFromInstanceTime(time) {
	if (!time) return null;

	try {
		if (time.is_date()) {
			return new Date(
				Number(time.get_year()),
				Number(time.get_month()) - 1,
				Number(time.get_day()));
		};

		const zone = time.get_timezone?.() ?? null;
		const seconds = zone
			? Number(time.as_timet_with_zone(zone))
			: Number(time.as_timet());

		return Number.isFinite(seconds) && seconds >= 0
			? new Date(seconds * 1000)
			: null;
	} catch (_error) {
		return null;
	};
};

function eventFromInstance(icalComponent, instanceStart, instanceEnd,
	calendar, rangeStart, rangeEnd) {
	const start = dateFromInstanceTime(instanceStart);
	const end = dateFromInstanceTime(instanceEnd);

	if (!start || start >= rangeEnd || (end ?? start) < rangeStart) return null;

	let uid = '';
	let title = '';

	try {
		uid = String(icalComponent.get_uid?.() ?? '');
	} catch (_error) {
		uid = '';
	};

	try {
		title = String(icalComponent.get_summary?.() ?? '').trim();
	} catch (_error) {
		title = '';
	};

	return {
		id: `${uid}\u0000${start.getTime()}`,
		title: title || _('Untitled event'),
		start,
		end,
		allDay: Boolean(instanceStart?.is_date?.()),
		calendarName: calendar.name,
		color: calendar.color,
	};
};

function connectCalendar(ECal, source, cancellable) {
	return new Promise((resolve, reject) => {
		try {
			ECal.Client.connect(
				source,
				ECal.ClientSourceType.EVENTS,
				10,
				cancellable,
				(_owner, result) => {
					try {
						resolve(unwrapResult(ECal.Client.connect_finish(result)));
					} catch (error) {
						reject(error);
					};
				});
		} catch (error) {
			reject(error);
		};
	});
};


function listCalendars(registry, EDataServer) {
	const extensionName = EDataServer.SOURCE_EXTENSION_CALENDAR;
	let sources = [];

	try {
		sources = asArray(registry.list_enabled(extensionName));
	} catch (_error) {
		try {
			sources = asArray(registry.list_sources(extensionName))
				.filter(source => source.get_enabled?.() !== false);
		} catch (_fallbackError) {
			sources = [];
		};
	};

	return sources.map(source => ({
		source,
		name: sourceName(source),
		color: sourceColor(source, EDataServer),
	}));
};

function dayKey(date) {
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

function sameDay(first, second) {
	return dayKey(first) === dayKey(second);
};

function formatDay(date) {
	const today = new Date();
	const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

	if (sameDay(date, today)) return _('Today');
	if (sameDay(date, tomorrow)) return _('Tomorrow');
	return date.toLocaleDateString(undefined, {weekday: 'long', month: 'short', day: 'numeric'});
};

function formatEventTime(event) {
	if (event.allDay) return _('All day');

	const time = event.start.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
	if (!event.end || !sameDay(event.start, event.end)) return time;

	return _('%s – %s').format(time,
		event.end.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'}));
};

function layoutFor(size) {
	return {
		small: {maxEvents: 3, eventSize: 13, rowPadding: 6},
		medium: {maxEvents: 5, eventSize: 14, rowPadding: 7},
		tall: {maxEvents: 9, eventSize: 15, rowPadding: 8},
		large: {maxEvents: 12, eventSize: 16, rowPadding: 9},
		wide: {maxEvents: 6, eventSize: 14, rowPadding: 7},
		huge: {maxEvents: 14, eventSize: 16, rowPadding: 9},
	}[size] ?? {maxEvents: 5, eventSize: 14, rowPadding: 7};
};

export function style(theme) {
	return surfaceStyle(theme);
};

export function render({body, widget, theme, sizeForWidget, compact = false}) {
	const size = supportedSizes.includes(widget?.size) ? widget.size : defaultSize;
	const layout = layoutFor(size);
	const [, widgetHeight] = sizeForWidget ? sizeForWidget(widget) : [454, 220];
	const estimatedRowHeight = layout.eventSize + layout.rowPadding * 2 + 15;
	layout.maxEvents = compact ? 3 : Math.min(layout.maxEvents,
		Math.max(2, Math.floor((widgetHeight - 70) / estimatedRowHeight)));
	const textColor = theme?.text ?? '#ffffff';
	const mutedColor = theme?.muted ?? 'rgba(255,255,255,0.62)';
	const state = {
		destroyed: false,
		refreshing: false,
		refreshAgain: false,
		generation: 0,
		timerId: 0,
		sourceTimerId: 0,
		cancellable: null,
		registry: null,

		clients: new Set(),
		events: new Map(),
		publishId: 0,
		emptyTimerId: 0,
	};

	body.set_clip_to_allocation(true);

	const content = new St.BoxLayout({
		...VERTICAL,
		style_class: `widget-events-content widget-events-size-${size}${compact ? ' widget-events-compact' : ''}`,
		x_expand: true,
		y_expand: true,
	});
	const list = new St.BoxLayout({
		...VERTICAL,
		style_class: 'widget-events-list',
		x_expand: true,
		y_expand: true,
	});

	if (compact) {
		content.add_child(new St.Label({
			text: _('Events'),
			style_class: 'widget-events-compact-title',
			style: `color: ${mutedColor};`,
		}));
	} else {
		const header = new St.BoxLayout({
			...HORIZONTAL,
			style_class: 'widget-events-header',
			x_expand: true,
		});
		header.add_child(new St.Label({
			text: _('Events'),
			style_class: 'widget-events-title',
			style: `color: ${textColor};`,
			x_expand: true,
			y_align: Clutter.ActorAlign.CENTER,
		}));
		header.add_child(new St.Label({
			text: _('Next 7 days'),
			style_class: 'widget-events-horizon',
			style: `color: ${mutedColor};`,
			y_align: Clutter.ActorAlign.CENTER,
		}));
		content.add_child(header);
	};
	content.add_child(list);
	body.add_child(content);

	function showMessage(primary, secondary = '') {
		if (state.destroyed) return;

		list.destroy_all_children();
		if (compact) {
			const label = new St.Label({
				text: primary,
				style_class: 'widget-events-compact-label',
				style: `color: ${mutedColor};`,
				x_expand: true,
			});
			label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
			list.add_child(label);
			return;
		};
		const message = new St.BoxLayout({
			...VERTICAL,
			style_class: 'widget-events-message',
			x_expand: true,
			y_expand: true,
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
		});
		const icon = new St.Icon({
			icon_name: 'x-office-calendar-symbolic',
			icon_size: size === 'small' ? 30 : 36,
			style: `color: ${theme?.accent ?? DEFAULT_COLOR};`,
		});
		const primaryLabel = new St.Label({
			text: primary,
			style_class: 'widget-events-message-primary',
			style: `color: ${textColor};`,
			x_align: Clutter.ActorAlign.CENTER,
		});
		primaryLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
		primaryLabel.clutter_text.line_wrap = true;
		primaryLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
		message.add_child(icon);
		message.add_child(primaryLabel);

		if (secondary) {
			const secondaryLabel = new St.Label({
				text: secondary,
				style_class: 'widget-events-message-secondary',
				style: `color: ${mutedColor};`,
				x_align: Clutter.ActorAlign.CENTER,
			});
			secondaryLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
			secondaryLabel.clutter_text.line_wrap = true;
			secondaryLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
			message.add_child(secondaryLabel);
		};

		list.add_child(message);
	};

	function eventRow(event) {
		const row = new St.BoxLayout({
			...HORIZONTAL,
			style_class: 'widget-events-row',
			x_expand: true,
		});
		const color = new St.Widget({
			style_class: 'widget-events-color',
			style: `background-color: ${event.color};`,
			y_align: Clutter.ActorAlign.FILL,
		});
		if (compact) {
			const day = sameDay(event.start, new Date())
				? _('Today')
				: event.start.toLocaleDateString(undefined, {weekday: 'short'});
			const when = event.allDay ? day :
				`${day} ${event.start.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'})}`;
			const label = new St.Label({
				text: `${when} · ${event.title}`,
				style_class: 'widget-events-compact-label',
				style: `color: ${textColor};`,
				x_expand: true,
			});
			label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
			row.add_child(color);
			row.add_child(label);
			return row;
		};
		const details = new St.BoxLayout({
			...VERTICAL,
			style_class: 'widget-events-details',
			x_expand: true,
		});
		const titleLabel = new St.Label({
			text: event.title,
			style_class: 'widget-events-event-title',
			style: `color: ${textColor};`,
			x_expand: true,
		});
		const metaLabel = new St.Label({
			text: `${formatEventTime(event)}  ·  ${event.calendarName || _('Calendar')}`,
			style_class: 'widget-events-event-meta',
			style: `color: ${mutedColor};`,
			x_expand: true,
		});

		titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
		metaLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
		details.add_child(titleLabel);
		details.add_child(metaLabel);
		row.add_child(color);
		row.add_child(details);
		return row;
	};

	function showEvents(events) {
		if (state.destroyed) return;

		list.destroy_all_children();
		let previousDay = '';

		for (const event of events.slice(0, layout.maxEvents)) {
			const key = dayKey(event.start);
			if (!compact && key !== previousDay) {
				list.add_child(new St.Label({
					text: formatDay(event.start),
					style_class: 'widget-events-day',
					style: `color: ${mutedColor};`,
				}));
				previousDay = key;
			};
			list.add_child(eventRow(event));
		};
	};

	function cancelEventStreams(clearEvents = true) {
		state.cancellable?.cancel();
		state.cancellable = null;
		state.clients.clear();

		if (state.publishId) {
			GLib.source_remove(state.publishId);
			state.publishId = 0;
		};
		if (state.emptyTimerId) {
			GLib.source_remove(state.emptyTimerId);
			state.emptyTimerId = 0;
		};
		if (clearEvents) {
			state.events.clear();
		};
	};

	function publishGeneratedEvents(generation) {
		if (state.destroyed || generation !== state.generation || state.publishId) return;

		state.publishId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
			state.publishId = 0;
			if (state.destroyed || generation !== state.generation) return GLib.SOURCE_REMOVE;

			const events = [...state.events.values()]
				.sort((first, second) => first.start - second.start);
			if (events.length > 0) {
				showEvents(events);
			};

			return GLib.SOURCE_REMOVE;
		});
	};

	function addGeneratedEvent(event, generation) {
		if (state.destroyed || generation !== state.generation) return;

		const key = `${event.id}\u0000${event.calendarName}`;
		state.events.set(key, event);
		if (state.emptyTimerId) {
			GLib.source_remove(state.emptyTimerId);
			state.emptyTimerId = 0;
		};
		publishGeneratedEvents(generation);
	};

	function scheduleEmptyState(generation) {
		if (state.emptyTimerId) {
			GLib.source_remove(state.emptyTimerId);
		};

		state.emptyTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
			state.emptyTimerId = 0;
			if (!state.destroyed && generation === state.generation && state.events.size === 0) {
				showMessage(_('No upcoming events'), _('Nothing scheduled in the next 7 days.'));
			};
			return GLib.SOURCE_REMOVE;
		});
	};

	function startInstanceStream(client, calendar, rangeStart, rangeEnd,
		cancellable, generation) {
		client.generate_instances(
			Math.floor(rangeStart.getTime() / 1000),
			Math.floor(rangeEnd.getTime() / 1000),
			cancellable,
			(icalComponent, instanceStart, instanceEnd) => {
				if (state.destroyed || generation !== state.generation || cancellable.is_cancelled()) return false;

				const event = eventFromInstance(
					icalComponent,
					instanceStart,
					instanceEnd,
					calendar,
					rangeStart,
					rangeEnd);
				if (event) {
					addGeneratedEvent(event, generation);
				};
				return true;
			});
	};

	function disconnectRegistry() {
		if (state.registry) {
			state.registry.disconnectObject(content);
		};

		state.registry = null;
	};

	function scheduleSourceRefresh() {
		if (state.destroyed || state.sourceTimerId) return;

		state.sourceTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SOURCE_REFRESH_DELAY_MS, () => {
			state.sourceTimerId = 0;
			refresh();
			return GLib.SOURCE_REMOVE;
		});
	};

	function watchRegistry(registry) {
		if (state.registry === registry) return;

		disconnectRegistry();
		state.registry = registry;
		for (const signal of ['source-added', 'source-removed', 'source-changed']) {
			registry.connectObject(signal, scheduleSourceRefresh, content);
		};
	};

	async function startEventStreams(ECal, EDataServer, cancellable, generation) {
		const registry = await createSourceRegistry(EDataServer, cancellable);
		if (state.destroyed || generation !== state.generation || cancellable.is_cancelled()) return {hasCalendars: false, successfulCalendars: 0};
		watchRegistry(registry);
		const calendars = listCalendars(registry, EDataServer);
		if (calendars.length === 0) return {hasCalendars: false, successfulCalendars: 0};

		const rangeStart = new Date();
		const rangeEnd = new Date(rangeStart.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);
		const settled = await Promise.allSettled(calendars.map(async calendar => {
			const client = await connectCalendar(ECal, calendar.source, cancellable);

			if (state.destroyed || generation !== state.generation || cancellable.is_cancelled()) return false;

			startInstanceStream(client, calendar, rangeStart, rangeEnd, cancellable, generation);
			state.clients.add(client);
			return true;
		}));
		const successfulCalendars = settled.filter(
			result => result.status === 'fulfilled' && result.value).length;

		return {hasCalendars: true, successfulCalendars};
	};

	async function refresh() {
		if (state.destroyed) return;
		if (state.refreshing) {
			state.refreshAgain = true;
			return;
		};

		state.refreshing = true;
		state.refreshAgain = false;
		const generation = ++state.generation;
		cancelEventStreams();
		const cancellable = new Gio.Cancellable();
		state.cancellable = cancellable;

		try {
			const modules = await loadEdsModules();
			if (state.destroyed || generation !== state.generation) return;
			if (!modules) {
				showMessage(
					_('Calendar service unavailable'),
					_('Set up GNOME Calendar and make sure Evolution Data Server is installed.'));
				return;
			};

			const result = await startEventStreams(
				modules.ECal,
				modules.EDataServer,
				cancellable,
				generation);
			if (state.destroyed || generation !== state.generation) return;
			if (!result.hasCalendars) {
				showMessage(_('No calendars found'), _('Open GNOME Calendar to add a calendar or account.'));
			} else if (result.successfulCalendars === 0) {
				showMessage(_('Couldn’t load events'), _('Open GNOME Calendar and check your calendar accounts.'));
			} else if (state.events.size === 0) {
				showMessage(_('Loading events…'));
				scheduleEmptyState(generation);
			} else {
				publishGeneratedEvents(generation);
			};
		} catch (error) {
			if (!state.destroyed && generation === state.generation && !cancelled(error)) {
				showMessage(
					_('Couldn’t load events'),
					_('Open GNOME Calendar and check that its calendar service is available.'));
			};
		} finally {
			if (generation === state.generation) {
				state.refreshing = false;
				if (state.refreshAgain && !state.destroyed) {
					refresh();
				};
			};
		};
	};

	showMessage(_('Loading events…'));
	refresh();
	state.timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
		if (state.destroyed || content.get_parent() !== body) {
			state.timerId = 0;
			return GLib.SOURCE_REMOVE;
		};
		refresh();
		return GLib.SOURCE_CONTINUE;
	});

	content.connectObject('destroy', () => {
		if (state.destroyed) return;

		state.destroyed = true;
		state.generation++;
		cancelEventStreams();
		if (state.timerId) {
			GLib.Source.remove(state.timerId);
			state.timerId = 0;
		};
		if (state.sourceTimerId) {
			GLib.Source.remove(state.sourceTimerId);
			state.sourceTimerId = 0;
		};
		disconnectRegistry();
	}, content);
};
