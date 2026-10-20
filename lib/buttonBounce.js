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

// Pivots the button at its center so the scale animation grows from the
// middle, and plays the bounce on every click. Returns the handler id.
export function attachBounce(button) {
	button.set_pivot_point(0.5, 0.5);
	return button.connect('clicked', () => bounceButton(button));
};
