/*
 * Shared page indicator dots for swipable widgets (the calendar's
 * pagination component, now used verbatim by weather too).
 *
 * Construction: a full-width dots row (spacing 6px, bottom margin 2px) is
 * pinned to the very bottom-center of the host's page stack through a
 * y-expanding filler above the row (BinLayout ignores child y_align, so
 * the filler does the pinning; the row's x_align centers the dots
 * horizontally relative to the card). Dots render round (5x5) or as
 * dashes (10x3) per the global page-indicator-style setting, colored by
 * the caller's theme-aware color; the active dot eases to full opacity,
 * inactive dots rest at 90.
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { boxLayoutProps } from '../utils/gnomeCompat.js';

// Height in px of the band the dots occupy at the bottom edge of the
// card: the row's bottom margin + the dot/dash height. Host pages center
// their content within (page height - this) so the air above the content
// equals the air between it and the dots.
export function indicatorBandHeight(settings) {
	const dashStyle = (settings?.get_int('page-indicator-style') ?? 0) === 1;
	return (dashStyle ? 3 : 5) + 2;
}

export function createPageIndicator({settings, count, color}) {	// dash/dot per the global page-indicator-style setting (prefs → General).
	const dashStyle = (settings?.get_int('page-indicator-style') ?? 0) === 1;

	const row = new St.BoxLayout(boxLayoutProps({
		x_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		style: `spacing: 6px; margin-bottom: 2px;`,
	}));

	// Flush with the very bottom of the widget body. Do NOT shift the row
	// below the body allocation (translation/negative margin): body is
	// clipped to allocation, the extra pixel got sheared off the circles.
	const dots = Array.from({length: count}, () => new St.Widget({
		width: dashStyle ? 10 : 5,
		height: dashStyle ? 3 : 5,
		opacity: 90,
		style: `border-radius: 999px; background-color: ${color};`,
	}));
	dots.forEach(dot => row.add_child(dot));

	const wrap = new St.BoxLayout(boxLayoutProps({
		vertical: true,
		x_expand: true,
		y_expand: true,
	}));
	wrap.add_child(new St.Widget({y_expand: true}));
	wrap.add_child(row);

	const refresh = (activeIndex) => {
		// Guards against disposed actors on both usage patterns: the
		// calendar mounts the overlay wrap, other widgets may nest the raw
		// row directly — the row is the always-present element either way.
		if (!row.get_parent()) {
			return;
		};

		dots.forEach((dot, index) => {
			dot.ease({
				opacity: index === activeIndex ? 255 : 90,
				duration: 120,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			});
		});
	};

	return {wrap, row, dots, refresh};
};
