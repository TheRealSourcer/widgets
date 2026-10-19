/**
 * Small shared math helpers used by widgets and the layout controller.
 * Kept dependency-free so widgets can import it with no side effects.
 */
export function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
};