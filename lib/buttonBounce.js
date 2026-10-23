import Clutter from 'gi://Clutter';

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
const HOVER_SCALE = 0.85;
export function bindHoverShrink(button) {
	button.set_pivot_point(0.5, 0.5);
	let hovering = false;
	button.connect('enter-event', () => {
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
	button.connect('leave-event', () => {
		if (!hovering) return Clutter.EVENT_PROPAGATE;
		hovering = false;
		button.remove_transition('scale-x');
		button.remove_transition('scale-y');
		button.ease({
			scale_x: 1,
			scale_y: 1,
			duration: 150,
			mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
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
