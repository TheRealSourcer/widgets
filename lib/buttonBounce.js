import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

// Click squash-and-spring on a plain St.Button — the music widget's bounce
// (0.8 squish in, springy overshoot out), shared by the interactive widgets
// (task, stopwatch, timer, pomodoro) so every press feels the same.
export function bounceButton(button) {
	button.set_pivot_point(0.5, 0.5);
	button.remove_transition('scale-x');
	button.remove_transition('scale-y');
	button.ease({
		scale_x: 0.8,
		scale_y: 0.8,
		duration: 90,
		mode: Clutter.AnimationMode.EASE_IN_QUAD,
		onComplete: () => button.ease({
			scale_x: 1,
			scale_y: 1,
			duration: 260,
			mode: Clutter.AnimationMode.EASE_OUT_BACK,
		}),
	});
};

// Hover feedback shared by every widget's buttons (music was first): no
// hover frame or wash — the icon briefly eases down to 85% and back to
// full size on leave. Enter/leave only write scale_x/y, so they never fight
// the click bounce: whichever ease runs last owns the transitions.
//
// Two sources of spurious enter/leave pairs that loop the animation:
//
// 1. Child-actor crossing: the pointer moves onto an St.Icon child → Clutter
//    fires leave on the button then enter again via bubbling. Fix: check
//    event.get_related() — if the other actor is inside the button ignore it.
//
// 2. Scale-shrink feedback: easing scale to 0.85 shrinks the Clutter hit-area,
//    so a pointer sitting near the edge suddenly falls outside → leave-event →
//    scale restores → pointer is back inside → enter-event → loop forever.
//    Fix: the leave handler defers the restore to an idle callback. If an
//    enter-event arrives in the same main-loop iteration (i.e. within the same
//    event flush — the spurious re-entry case), the pending idle is cancelled
//    and hovering stays true, so the shrink is never undone.
const HOVER_SCALE = 0.85;
export function bindHoverShrink(button) {
	button.set_pivot_point(0.5, 0.5);
	let hovering = false;
	let leaveIdleId = null;

	const cancelLeave = () => {
		if (leaveIdleId !== null) {
			GLib.source_remove(leaveIdleId);
			leaveIdleId = null;
		}
	};

	button.connect('destroy', () => cancelLeave());

	button.connect('enter-event', (_, event) => {
		// Fix #1: pointer came from a child actor — pointer never left.
		const related = event.get_related();
		if (related && button.contains(related)) return Clutter.EVENT_PROPAGATE;

		// Fix #2: cancel any pending leave restore — this enter is the
		// spurious re-entry caused by the scale shrink, not a real entry.
		cancelLeave();

		if (hovering) return Clutter.EVENT_PROPAGATE;
		hovering = true;
		button.remove_transition('scale-x');
		button.remove_transition('scale-y');
		button.ease({
			scale_x: HOVER_SCALE,
			scale_y: HOVER_SCALE,
			duration: 120,
			mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
		});
		return Clutter.EVENT_PROPAGATE;
	});

	button.connect('leave-event', (_, event) => {
		// Fix #1: pointer moved onto a child actor — pointer never left.
		const related = event.get_related();
		if (related && button.contains(related)) return Clutter.EVENT_PROPAGATE;
		if (!hovering) return Clutter.EVENT_PROPAGATE;

		// Fix #2: defer the restore so a spurious re-entry can cancel it.
		hovering = false;
		cancelLeave();
		leaveIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
			leaveIdleId = null;
			button.remove_transition('scale-x');
			button.remove_transition('scale-y');
			button.ease({
				scale_x: 1,
				scale_y: 1,
				duration: 150,
				mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
			});
			return GLib.SOURCE_REMOVE;
		});
		return Clutter.EVENT_PROPAGATE;
	});
};

// Pivots the button at its center so the scale animations grow from the
// middle, hooks the hover shrink and plays the bounce on every click.
// Returns the handler id.
export function attachBounce(button) {
	button.set_pivot_point(0.5, 0.5);
	bindHoverShrink(button);
	return button.connect('clicked', () => bounceButton(button));
};
