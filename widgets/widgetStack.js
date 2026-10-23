// Widget-in-widget: vertical pages under a primary widget.
//
// The primary widget stays page 0. Added pages (widget.stack, up to
// MAX_STACK_PAGES) hang BELOW it; opening the next one is a downward flip
// — the system monitor's 2x1 cross rotated to vertical: pages live one
// baseDistance apart (pageH + pageH/16), travel in lockstep by their own
// translation_y, EASE_OUT_CUBIC over 500 ms, nothing fades, nothing
// overlaps, and crossBusy serializes the flights.
//
// The drag lives on the bottom rail AND the top rail (thin strips pinned
// to the pane's edges): dragging UP on the bottom rail opens the page
// below, dragging DOWN walks back toward page 0; the top rail mirrors it
// — dragging DOWN there reveals the previous page from above, dragging UP
// pushes toward the next one. Small ▲/▼ buttons on the right edge are the
// button-based second way (both options per the feature spec). Stacked
// pages are fully interactive: their content is rendered by
// the very same fill path as primary widgets and stays mounted across
// flights; only the active page is visibly in the slot.

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { boxLayoutProps } from '../utils/gnomeCompat.js';
import { MAX_STACK_PAGES } from '../lib/widgetTypes.js';
import { LiquidGlass } from '../lib/glass.js';

// The same constants the music widget's cross uses (2x1 system monitor's).
const SWIPE_THRESHOLD = 12;  // Reduced from 36 for easier swipe triggering
const ANIMATION_DURATION = 250;
const CROSS_DURATION = Math.round(ANIMATION_DURATION * 2); // 500ms

const RAIL_HEIGHT = 48;  // Increased from 24 for easier swipe zone targeting

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
	styleForEntry = null,
	wantsGlassEntry = null,
	glassParams = null,
	startPage = 0,
	renderPage,
	pageSizeFor = null,
	isEditMode = () => false,
	onStateSaved = () => {},
	onPageChange = () => {},
}) {
	console.log(`[ATTACH-STACK] Called for widget=${widget.type} id=${widget.id} hasStack=${!!widget.stack} stackLength=${widget.stack?.length ?? 0}`);
	const entries = Array.isArray(widget.stack)
		? widget.stack.filter(entry => entry && entry.type).slice(0, MAX_STACK_PAGES)
		: [];
	console.log(`[ATTACH-STACK] Filtered entries: ${entries.length}`);

	// Sort entries by side: 'above' pages first, then 'below' pages, so the
	// pages array order matches the visual top-to-bottom stack layout (page
	// indices increase downward). This makes crossTo's direction logic work:
	// flipping from page 0 to page 1 should show the FIRST above page coming
	// down from above, not a below page rising from below.
	entries.sort((a, b) => {
		const aSide = a.side === 'above' ? 0 : 1;
		const bSide = b.side === 'above' ? 0 : 1;
		return aSide - bSide;
	});

	// No stack — the widget stays a plain widget: no rail, nothing mounted.
	if (entries.length === 0) {
		console.log(`[ATTACH-STACK] No entries, returning empty prism`);
		return {dispose() {}, refresh() {}, restyle() {}, updateGlassGeometry() {}};
	};
	console.log(`[ATTACH-STACK] Building pages for ${entries.length} entries...`);

	const pageW = Math.max(1, Math.floor(baseActor.get_width()) || 200);
	const pageH = Math.max(1, Math.floor(baseActor.get_height()) || 200);
	const baseDistance = () => pageH + Math.round(pageH / 16);

	let disposed = false;
	let crossBusy = false;
	// A re-fill (theme change, glass switch, panel edit) rebuilds the prism;
	// the caller passes the previously visible page back in startPage so a
	// skin change does not visually flip the widget back to page 0.
	let active = Math.max(0, startPage);

	// ── Pages ────────────────────────────────────────────────────────────
	// Page 0 is the widget's own styled box (never cloned, never moved).
	// Added pages mount as paneRoot children at (0,0) — CLIP paneRoot so
	// cross animations stay INSIDE the widget's visual bounds, never
	// travel outside.
	paneRoot.clip_to_allocation = true;
	paneRoot.set_clip(0, 0, pageW, pageH);
	
	const pages = [{actor: baseActor, entry: null}];

	// Glass-follow helpers ────────────────────────────────────────────────
	// A page's card style and glass pane are derived from the SAME style
	// engine as primary widgets (styleForEntry / wantsGlassEntry callbacks),
	// so a stacked page reacts to the Glass switch and to dark/light theme
	// changes exactly like a standalone widget does.

	// Stage rect of one page's card: the LiquidGlass pane needs the card's
	// stage coordinates (and size) to align its wallpaper backdrop.
	const updatePageGlassGeometry = (page) => {
		const glass = page.glass;

		if (!glass || glass.is_finalized?.()) {
			return;
		};

		const card = page.cardActor;

		if (!card || card.is_finalized?.()) {
			return;
		};

		const [x, y] = card.get_transformed_position();
		const [w, h] = card.get_size();

		if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0) {
			return;
		};

		glass.setGeometry(x, y, w, h);
	};

	const attachPageGlass = (page) => {
		// Photos carries its own paint (and skips glass on primaries too);
		// wantsGlassEntry covers that plus the current style mode.
		const want = wantsGlassEntry ? wantsGlassEntry(page.entry) : false;

		if (want && !page.glass) {
			const glass = new LiquidGlass();
			const card = page.cardActor;
			const [w, h] = card.get_size();

			glass.set_size(w, h);
			page.actor.insert_child_at_index(glass, 0);
			page.glass = glass;

			if (glassParams) {
				glass.setParams(glassParams());
			};

			updatePageGlassGeometry(page);
		} else if (!want && page.glass) {
			const glass = page.glass;

			page.glass = null;

			if (!glass.is_finalized?.()) {
				glass.destroy();
			};
		};

		// A fresh pane may have been created before the first allocation.
		if (page.glass) {
			updatePageGlassGeometry(page);
		};
	};

	const updateGlassGeometry = () => {
		for (let i = 1; i < pages.length; i += 1) {
			updatePageGlassGeometry(pages[i]);
		};
	};

	// Live re-style without re-rendering: card style follows the theme /
	// glass mode pipeline, and glass params follow slider changes. Used on
	// appearance changes so pages keep pace with their host widget.
	const restyle = () => {
		for (let i = 1; i < pages.length; i += 1) {
			const page = pages[i];

			if (page.actor.is_finalized?.()) {
				continue;
			};

			if (styleForEntry) {
				const style = styleForEntry(page.entry);

				if (style) {
					page.cardActor.set_style(style);
				};
			};

			attachPageGlass(page);

			if (page.glass && glassParams) {
				page.glass.setParams(glassParams());
			};
		};

		updateGlassGeometry();
	};

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
			style: `border-radius: ${theme?.radius ?? 16}px; overflow: hidden;`,
		});

		// A stacked page carries the SAME skin as its host widget: the card
		// style is produced by the caller's styleForEntry pipeline, so the
		// Glass switch and theme (dark/light) changes apply to added pages
		// too. The legacy inline style below is only the fallback for callers
		// that did not opt into the pipeline.
		const cardSize = entry.size || widget.size || 'default';
		const cardActor = new St.BoxLayout(boxLayoutProps({
			vertical: true,
			style_class: `widget widget-${entry.type} widget-${entry.type}-${cardSize}`,
			style: styleForEntry
				? (styleForEntry(entry) ?? '')
				: `background-color: ${theme.background};`
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

		// Glass pane under the card (style mode = Glass): one LiquidGlass per
		// page, matching the host widget's silhouette and parameters. The
		// pane tracks the card's stage geometry (see updatePageGlassGeometry).
		const page = {actor: pageActor, cardActor, record, entry, glass: null};
		attachPageGlass(page);

		// Realign the wallpaper pane when the page gets allocated (first map
		// after attach) — before that, transformed coordinates may be stale.
		pageActor.connectObject('notify::allocation', () => updatePageGlassGeometry(page), pageActor);

		const body = new St.BoxLayout(boxLayoutProps({
			vertical: true,
			style_class: 'widget-body',
			x_expand: true,
			y_expand: true,
			clip_to_allocation: true,
		}));
		cardActor.add_child(body);

		console.log(`[STACK-RENDER] Rendering page: type=${entry.type} recordId=${record.id} body=${!!body} cardActor=${!!cardActor}`);
		try {
			renderPage(record, body, cardActor);
			console.log(`[STACK-RENDER] Success: type=${entry.type} bodyChildren=${body.get_n_children()}`);
		} catch (error) {
			console.error('[STACK-RENDER] Failed:', error);
		};

		paneRoot.add_child(pageActor);
		pageActor.set_position(0, 0);
		return page;
	};

	for (const entry of entries) {
		console.log(`[ATTACH-STACK] Building page for entry type=${entry.type} side=${entry.side}`);
		pages.push(buildPage(entry));
	};
	console.log(`[ATTACH-STACK] Total pages built: ${pages.length} (including primary)`);

	const placeIdle = () => {
		// startPage may outnumber the built pages (a sibling was deleted
		// before a refill); clamp before the first placement.
		active = Math.min(active, pages.length - 1);

		for (let i = 1; i < pages.length; i += 1) {
			const {actor} = pages[i];
			// Translation is valid before visible (sysmon precondition) and
			// keeps the page exactly one baseDistance from the active slot.
			actor.translation_y = (i - active) * baseDistance();
			actor.visible = i === active;
		};

		// The slot moved pages around; the glass wallpaper panes must re-align.
		updateGlassGeometry();
	};
	placeIdle();

	// ── The cross (vertical rotation of the system monitor's 2x1) ────────
	// Direction-aware: pages with side='above' enter from ABOVE (negative
	// translation), pages with side='below' enter from BELOW (positive).
	const crossTo = (target) => {
		if (disposed || crossBusy || target === active
			|| target < 0 || target >= pages.length) {
			return;
		};

		const leaving = pages[active];
		const entering = pages[target];
		const oldActive = active;
		active = target;

		// Entry direction follows the travel direction, not the page's side:
		// moving to a higher index (forward) makes the entering page come
		// from below (travels up); moving to a lower index (back) makes it
		// come from above (travels down). This matches the desired feel:
		// 1->2 enters from below (goes up), 3->2 enters from above (comes
		// from top).
		const entryDir = target > oldActive ? 1 : -1;

		// Both pages travel in lockstep by their own translation_y; nothing
		// fades, the seam between them is the only thing crossing the slot.
		entering.actor.translation_y = entryDir * baseDistance();
		entering.actor.visible = true;
		leaving.actor.translation_y = 0;

		crossBusy = true;

		// Glass panes sample the wallpaper from stored stage rects; snap them
		// to the pre-flight positions so the blur is at least correct for the
		// whole flight.
		updatePageGlassGeometry(entering);
		updatePageGlassGeometry(leaving);

		leaving.actor.ease({
			translation_y: -entryDir * baseDistance(),
			duration: CROSS_DURATION,
			mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
			onComplete: () => {
				if (disposed || leaving.actor.is_finalized?.()) {
					return;
				};
				// The page left over goes to its idle slot (hidden), ready
				// for the next flight in either direction. The idle position
				// depends on the page's side: above pages sit above (negative
				// translation), below pages sit below (positive translation),
				// relative to the currently active page at translation_y=0.
				const index = pages.indexOf(leaving);
				// PRIMARY page (index 0, entry=null) stays at translation_y=0
				// as the base reference point. Only ADDED pages move to idle.
				if (index === 0) {
					leaving.actor.translation_y = 0;
					leaving.actor.visible = false;
					updatePageGlassGeometry(leaving);
					return;
				};
				const leavingSide = leaving.entry?.side ?? 'below';
				// Pages with side='above' have lower indices (sorted first);
				// their idle position is ABOVE active (negative). Pages with
				// side='below' have higher indices; idle position is BELOW.
				const idleDir = leavingSide === 'above' ? -1 : 1;
				leaving.actor.translation_y = idleDir * Math.abs(index - active) * baseDistance();
				leaving.actor.visible = false;
				updatePageGlassGeometry(leaving);
			},
		});
		entering.actor.ease({
			translation_y: 0,
			duration: CROSS_DURATION,
			mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
			onComplete: () => {
				crossBusy = false;
				updatePageGlassGeometry(entering);
				onPageChange();
			},
		});
	};

	// ── Rails: swipe zones at BOTH edges ─────────────────────────────────
	// The bottom rail keeps the original gesture: dragging UP opens the
	// page below (content follows the finger), dragging DOWN walks back
	// toward page 0 — on page 0 a downward drag has no page above, so
	// nothing happens. The top rail mirrors it spatially: dragging DOWN
	// reveals the previous page from above, dragging UP pushes toward the
	// next one — so pages added above AND below are reachable by dragging
	// at either edge. Rails are paneRoot-level, so they serve every page
	// id. They must be NON-reactive in edit mode so panel/gallery overlays
	// catch clicks.
	const railReactive = !isEditMode();

	const makeRail = (edge) => {
		const rail = new St.Widget({
			reactive: railReactive,
			x: 0,
			y: edge === 'bottom' ? Math.max(0, pageH - RAIL_HEIGHT) : 0,
			width: pageW,
			height: RAIL_HEIGHT,
			opacity: 0,
		});

		let dragStartY = null;

		rail.connect('button-press-event', (_actor, event) => {
			if (crossBusy) {
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
			const startY = dragStartY;
			dragStartY = null;

			const [stageX, stageY] = event.get_coords();
			if (!Number.isFinite(stageY)) {
				return Clutter.EVENT_STOP;
			};

			const delta = stageY - startY;
			
			if (Math.abs(delta) <= SWIPE_THRESHOLD) {
				return Clutter.EVENT_STOP;
			};

			// Improved navigation: seamless flow through pages of the same side
			// without forcing return to primary between each step.
			let target = -1;
			
			if (edge === 'bottom') {
				// BOTTOM rail: swipe UP opens below pages, swipe DOWN navigates back
				if (delta < 0) {
					// Swipe UP: advance through below pages
					if (active === 0) {
						// From primary: jump to first below page
						const firstBelow = pages.findIndex((p, i) => i > 0 && p.entry?.side !== 'above');
						target = firstBelow !== -1 ? firstBelow : -1;
					} else {
						const currentSide = pages[active]?.entry?.side ?? 'below';
						if (currentSide === 'below') {
							// From below page: try next below page (sequential flow)
							const nextBelow = pages.findIndex((p, i) => i > active && p.entry?.side !== 'above');
							target = nextBelow !== -1 ? nextBelow : -1;
						} else {
							// From above page: return to primary first
							target = 0;
						}
					}
				} else {
					// Swipe DOWN: navigate backward (toward primary)
					if (active > 0 && pages[active]?.entry?.side !== 'above') {
						// From below page: go to previous below or primary
						for (let i = active - 1; i >= 0; i--) {
							if (i === 0 || pages[i]?.entry?.side !== 'above') {
								target = i;
								break;
							}
						}
					}
				}
			} else {
				// TOP rail: swipe DOWN opens above pages, swipe UP navigates back
				if (delta > 0) {
					// Swipe DOWN: advance through above pages
					if (active === 0) {
						// From primary: jump to first above page
						const firstAbove = pages.findIndex((p, i) => i > 0 && p.entry?.side === 'above');
						target = firstAbove !== -1 ? firstAbove : -1;
					} else {
						const currentSide = pages[active]?.entry?.side ?? 'below';
						if (currentSide === 'above') {
							// From above page: try next above page (sequential flow)
							const nextAbove = pages.findIndex((p, i) => i > active && p.entry?.side === 'above');
							target = nextAbove !== -1 ? nextAbove : -1;
						}
					}
				} else {
					// Swipe UP: navigate backward (toward primary)
					if (active > 0 && pages[active]?.entry?.side === 'above') {
						// From above page: go to previous above or primary
						for (let i = active - 1; i >= 0; i--) {
							if (i === 0 || pages[i]?.entry?.side === 'above') {
								target = i;
								break;
							}
						}
					}
				}
			}

			if (target >= 0 && target < pages.length) {
				crossTo(target);
			};
			return Clutter.EVENT_STOP;
		});

		paneRoot.add_child(rail);
		return rail;
	};

	const bottomRail = makeRail('bottom');
	const topRail = makeRail('top');
	const rails = [bottomRail, topRail];

	// ── Whole-widget right-button swipe (system monitor style) ────────────
	// The thin rails above are hard to discover; mirror the music widget's
	// nice gesture on the ENTIRE pane so a right-button vertical drag
	// anywhere flips pages. Left button stays free for content clicks.
	// Only active in normal mode (rails handle edit mode by hiding).
	let swipeStartY = null;
	paneRoot.connect('button-press-event', (_actor, event) => {
		if (isEditMode() || crossBusy) {
			return Clutter.EVENT_PROPAGATE;
		};
		if (event.get_button() !== 3) {
			return Clutter.EVENT_PROPAGATE;
		};
		const coords = event.get_coords();
		if (!Number.isFinite(coords?.[1])) {
			return Clutter.EVENT_PROPAGATE;
		};
		swipeStartY = coords[1];
		return Clutter.EVENT_PROPAGATE;
	});

	paneRoot.connect('button-release-event', (_actor, event) => {
		if (swipeStartY === null) {
			return Clutter.EVENT_PROPAGATE;
		};
		const startY = swipeStartY;
		swipeStartY = null;
		if (isEditMode() || crossBusy) {
			return Clutter.EVENT_PROPAGATE;
		};
		if (event.get_button() !== 3) {
			return Clutter.EVENT_PROPAGATE;
		};
		const coords = event.get_coords();
		if (!Number.isFinite(coords?.[1])) {
			return Clutter.EVENT_STOP;
		};
		const delta = coords[1] - startY;
		if (Math.abs(delta) < SWIPE_THRESHOLD) {
			return Clutter.EVENT_STOP;
		};
		if (crossBusy) {
			return Clutter.EVENT_STOP;
		};

		const curSide = active === 0 ? null : (pages[active]?.entry?.side ?? 'below');
		let target = -1;
		if (delta < 0) {
			// swipe up -> go up (toward above pages / back)
			if (active === 0) {
				target = pages.findIndex((p, i) => i > 0 && p.entry?.side === 'above');
			} else if (curSide === 'above') {
				for (let i = active - 1; i >= 0; i--) {
					if (i === 0 || pages[i]?.entry?.side === 'above') {
						target = i;
						break;
					}
				}
			} else {
				target = 0;
			}
		} else {
			// swipe down -> go down (toward below pages / back)
			if (active === 0) {
				target = pages.findIndex((p, i) => i > 0 && p.entry?.side !== 'above');
			} else if (curSide === 'below') {
				target = pages.findIndex((p, i) => i > active && p.entry?.side !== 'above');
			} else {
				target = 0;
			}
		}

		if (target >= 0 && target < pages.length && target !== active) {
			crossTo(target);
		};
		return Clutter.EVENT_STOP;
	});

	// Update rail reactivity when edit mode toggles: panel buttons need
	// to catch clicks, and the rails must yield to them.
	const updateRailReactive = () => {
		if (rails.some(rail => rail.is_finalized?.())) {
			return;
		};
		const reactive = !isEditMode();
		for (const rail of rails) {
			rail.reactive = reactive;
			// Hide rails entirely in edit mode so they cannot block
			// the widget drag or panel button clicks.
			rail.visible = reactive;
		};
	};

	return {
		// Full teardown on re-fill: the fill path destroys the body children
		// of the base page; added pages, the rails and the flip buttons die
		// with the attach.
		dispose() {
			disposed = true;
			for (const rail of rails) {
				rail.remove_all_transitions();
				rail.destroy();
			};
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
		// the previous prism first. Also refresh rail reactivity when edit
		// mode toggles.
		refresh() {
			updateRailReactive();
		},

		// Keeps added pages in step with the host's skin: the card style and
		// glass panes are re-derived from the caller's callbacks (theme and
		// style mode) without re-rendering the page content.
		restyle,

		// The currently visible page index (0 = primary); the next attach
		// uses it as startPage so refills do not flip back to page 0.
		getActivePage() {
			return active;
		},

		// Re-aligns every page's glass backdrop with its card's stage rect.
		updateGlassGeometry,
	};
};
