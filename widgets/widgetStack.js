// Widget-in-widget: vertical pages under a primary widget.
//
// The primary widget stays page 0. Added pages (widget.stack, up to
// MAX_STACK_PAGES) hang BELOW it; opening the next one is a downward flip
// — the system monitor's 2x1 cross rotated to vertical: pages live one
// baseDistance apart (pageH + pageH/16), travel in lockstep by their own
// translation_y, EASE_OUT_CUBIC over 500 ms, nothing fades, nothing
// overlaps, and crossBusy serializes the flights.
//
// The drag lives on a bottom rail (a thin strip pinned to the pane's very
// bottom edge): dragging UP on it opens the page below (the content
// follows the finger), dragging DOWN walks back toward page 0 — on page 0
// a downward drag has no page above, so nothing happens, per the feature
// spec. Stacked pages are fully interactive: their content is rendered by
// the very same fill path as primary widgets and stays mounted across
// flights; only the active page is visibly in the slot.

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { boxLayoutProps } from '../utils/gnomeCompat.js';
import { MAX_STACK_PAGES } from '../lib/widgetTypes.js';

// The same constants the music widget's cross uses (2x1 system monitor's).
const SWIPE_THRESHOLD = 36;
const ANIMATION_DURATION = 250;
const CROSS_DURATION = Math.round(ANIMATION_DURATION * 2); // 500ms

const RAIL_HEIGHT = 20;

function newPageKey() {
	return Math.random().toString(36).slice(2, 9);
};

// A page's own state files (pomodoro, timer…) key on widget.id; a random
// key at add-time keeps a stacked widget's save file stable even when an
// earlier sibling is deleted and the indices shift.
export function makeStackEntry(type, size = null) {
	return {type, key: newPageKey(), data: {}, size: size ?? null};
};

export function attachWidgetStack({
	paneRoot,
	baseActor,
	widget,
	theme,
	renderPage,
	pageSizeFor = null,
	isEditMode = () => false,
	onStateSaved = () => {},
}) {
	const entries = Array.isArray(widget.stack)
		? widget.stack.filter(entry => entry && entry.type).slice(0, MAX_STACK_PAGES)
		: [];

	// No stack — the widget stays a plain widget: no rail, nothing mounted.
	if (entries.length === 0) {
		return {dispose() {}, refresh() {}};
	};

	const pageW = Math.max(1, Math.floor(baseActor.get_width()) || 200);
	const pageH = Math.max(1, Math.floor(baseActor.get_height()) || 200);
	const baseDistance = () => pageH + Math.round(pageH / 16);

	let disposed = false;
	let crossBusy = false;
	let active = 0;

	// ── Pages ────────────────────────────────────────────────────────────
	// Page 0 is the widget's own styled box (never cloned, never moved).
	// Added pages mount as paneRoot children at (0,0) — the same wrapper
	// coordinate space the base page occupies — and rest one baseDistance
	// apart, hidden while idle (only the active page is visibly in slot).
	const pages = [{actor: baseActor, entry: null}];

	const buildPage = (entry) => {
		// The page card may be smaller than the host's slot (a 1x1 page on
		// a 2x2 host) — it floats centered on a transparent page container.
		const [cardW, cardH] = (pageSizeFor?.(entry.size || widget.size))
			?? [pageW, pageH];

		const pageActor = new St.Widget({
			layout_manager: new Clutter.FixedLayout(),
			reactive: true,
			width: pageW,
			height: pageH,
		});

		// Stacked pages carry no glass backdrop (glass records key on the
		// wrapper's widget id); force the solid skin so their content stays
		// readable over the desktop no matter which style mode is on.
		const cardSize = entry.size || widget.size || 'default';
		const cardActor = new St.BoxLayout(boxLayoutProps({
			vertical: true,
			style_class: `widget widget-${entry.type} widget-${entry.type}-${cardSize}`,
			style: `background-color: ${theme.background};`
				+ ` border-style: solid;`
				+ ` border-width: ${theme.borderWidth}px;`
				+ ` border-color: ${theme.border};`
				+ ` border-radius: ${theme.radius}px;`,
			reactive: true,
			can_focus: true,
			track_hover: true,
		}));
		cardActor.set_size(cardW, cardH);
		cardActor.set_position(Math.round((pageW - cardW) / 2), Math.round((pageH - cardH) / 2));
		pageActor.add_child(cardActor);

		const body = new St.BoxLayout(boxLayoutProps({
			vertical: true,
			style_class: 'widget-body',
			x_expand: true,
			y_expand: true,
			clip_to_allocation: true,
		}));
		cardActor.add_child(body);

		// The page record travels into the fill path whole — its data object
		// is the entry's own slice, so module-side writes persist with the
		// parent record. A stable per-entry id keys its own state files.
		const record = {
			id: `${widget.id}-s-${entry.key}`,
			type: entry.type,
			// The page may render its own smaller size inside the host's slot
			// (a 1x1 page on a 2x2 host); null falls back to the host size.
			size: entry.size || widget.size,
			data: entry.data && typeof entry.data === 'object' ? entry.data : (entry.data = {}),
			pinned: true,
		};

		try {
			renderPage(record, body, cardActor);
		} catch (error) {
			console.error('[debug] stack page fill failed: ' + error.message);
		};

		paneRoot.add_child(pageActor);
		pageActor.set_position(0, 0);
		return {actor: pageActor, cardActor, record, entry};
	};

	for (const entry of entries) {
		pages.push(buildPage(entry));
	};

	const placeIdle = () => {
		for (let i = 1; i < pages.length; i += 1) {
			const {actor} = pages[i];
			// Translation is valid before visible (sysmon precondition) and
			// keeps the page exactly one baseDistance from the active slot.
			actor.translation_y = (i - active) * baseDistance();
			actor.visible = i === active;
		};
	};
	placeIdle();

	// ── The cross (vertical rotation of the system monitor's 2x1) ────────
	const crossTo = (target) => {
		if (disposed || crossBusy || target === active
			|| target < 0 || target >= pages.length) {
			return;
		};

		const dir = target > active ? 1 : -1;
		const leaving = pages[active];
		const entering = pages[target];
		active = target;

		// Both pages travel in lockstep by their own translation_y; nothing
		// fades, the seam between them is the only thing crossing the slot.
		entering.actor.translation_y = dir * baseDistance();
		entering.actor.visible = true;
		leaving.actor.translation_y = 0;

		crossBusy = true;

		leaving.actor.ease({
			translation_y: -dir * baseDistance(),
			duration: CROSS_DURATION,
			mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
			onComplete: () => {
				if (disposed || leaving.actor.is_finalized?.()) {
					return;
				};
				// The page left over goes to its idle slot (hidden), ready
				// for the next flight in either direction.
				const index = pages.indexOf(leaving);
				leaving.actor.translation_y = (index - active) * baseDistance();
				leaving.actor.visible = false;
			},
		});
		entering.actor.ease({
			translation_y: 0,
			duration: CROSS_DURATION,
			mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
			onComplete: () => {
				crossBusy = false;
			},
		});

		console.log(`[debug] stack cross ${widget.type} -> page ${active}/${pages.length - 1}`);
	};

	// ── The bottom rail: a spatial zone for the vertical drags ───────────
	// The rail is paneRoot-level, so it serves every page id. It stays
	// unreactive (and invisible) while edit mode owns the pointer.
	const rail = new St.Widget({
		reactive: true,
		x: 0,
		y: Math.max(0, pageH - RAIL_HEIGHT),
		width: pageW,
		height: RAIL_HEIGHT,
		opacity: 0,
	});
	paneRoot.add_child(rail);

	let dragStartY = null;

	rail.connect('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1 || crossBusy || isEditMode()) {
			return Clutter.EVENT_PROPAGATE;
		};
		const [stageX, stageY] = event.get_coords();
		if (!Number.isFinite(stageY)) {
			return Clutter.EVENT_PROPAGATE;
		};
		dragStartY = stageY;
		return Clutter.EVENT_STOP;
	});

	rail.connect('button-release-event', (_actor, event) => {
		if (dragStartY === null) {
			return Clutter.EVENT_PROPAGATE;
		};
		const [stageX, stageY] = event.get_coords();
		const startY = dragStartY;
		dragStartY = null;

		if (!Number.isFinite(stageY)) {
			return Clutter.EVENT_STOP;
		};

		const delta = stageY - startY;
		if (Math.abs(delta) <= SWIPE_THRESHOLD) {
			return Clutter.EVENT_STOP;
		};

		// Content follows the finger: an upward drag (delta < 0) reveals
		// the page below; downward walks back toward page 0. On page 0 a
		// downward drag targets nothing and does nothing.
		crossTo(active + (delta < 0 ? 1 : -1));
		return Clutter.EVENT_STOP;
	});

	return {
		// Full teardown on re-fill: the fill path destroys the body children
		// of the base page; added pages and the rail die with the attach.
		dispose() {
			disposed = true;
			rail.remove_all_transitions();
			rail.destroy();
			for (let i = 1; i < pages.length; i += 1) {
				const {actor} = pages[i];
				if (!actor.is_finalized?.()) {
					actor.remove_all_transitions();
					actor.destroy();
				};
			};
			pages.length = 1;
		},

		// Called after the parent's stack array changes (panel edit): rebuild
		// every added page from the (new) widget.stack — the caller destroys
		// the previous prism first.
		refresh() {},
	};
};
