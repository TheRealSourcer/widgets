// Port of the ray-casting tick ring from liquidglass-widgets (lib/squircle.js,
// originally KDE's HourDial.qml / TickRing.qml): each of the 60 minute
// directions is cast from the centre onto two rounded-corner rectangles (the
// widget shape shrunk by an inset), giving the outer and inner ends of that
// tick. Ticks therefore follow the widget's silhouette instead of a circle.

// Signed distance-like level of (x, y) against a centred squircle with
// half-size hw x hh, corner radius r and exponent n; < 0 is inside.
function level(x, y, hw, hh, r, n) {
	const qx = Math.abs(x) - hw + r;
	const qy = Math.abs(y) - hh + r;
	if (qx <= 0 && qy <= 0)
		return Math.max(qx, qy) - r;
	const arc = (Math.max(qx, 0) ** n + Math.max(qy, 0) ** n) ** (1 / n);
	return Math.min(Math.max(qx, qy), 0) + arc - r;
}

// Distance along the unit ray (dx, dy) from the centre to the boundary.
function rayHit(dx, dy, hw, hh, r, n) {
	let lo = 0;
	let hi = Math.min(
		Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Infinity,
		Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Infinity);
	for (let i = 0; i < 24; i++) {
		const mid = (lo + hi) / 2;
		if (level(mid * dx, mid * dy, hw, hh, r, n) < 0)
			lo = mid;
		else
			hi = mid;
	}
	return (lo + hi) / 2;
}

// 60 ticks (index 0 at 12 o'clock, clockwise) for a width x height widget
// whose glass has the given corner radius and roundness. Insets and the
// tick length are fractions of the widget's shorter side; corner ticks are
// pulled out by cornerOuterExtension so their gap to the edge looks even.
// Returns [{dx, dy, outer: {x, y}, inner: {x, y}}], in widget pixels.
export function perimeterTicks(width, height, cornerRadius, roundness, {
	outerInset = 0.05,
	tickLength = 0.026,
	cornerOuterExtension = 0.012,
} = {}) {
	const minSide = Math.min(width, height);
	const cx = width / 2;
	const cy = height / 2;
	const n = Math.max(roundness, 2);
	// The shader clamps the radius to half the shorter side; match it.
	const radius = Math.min(cornerRadius, cx, cy);

	const outerInsetPx = outerInset * minSide;
	const innerPad = (outerInset + tickLength) * minSide;
	const extensionPx = cornerOuterExtension * minSide;

	const innerHw = Math.max(1, cx - innerPad);
	const innerHh = Math.max(1, cy - innerPad);
	const innerR = Math.min(Math.max(0, radius - innerPad), innerHw, innerHh);

	const ticks = [];
	for (let i = 0; i < 60; i++) {
		const angle = i * 6 * Math.PI / 180;
		const dx = Math.sin(angle);
		const dy = -Math.cos(angle);

		// 0 on the flat edges, 1 on the 45-degree corner diagonals.
		const cornerBlend = 1 - Math.abs(Math.abs(dx) - Math.abs(dy));
		const inset = Math.max(0, outerInsetPx - extensionPx * cornerBlend);
		const outerHw = Math.max(1, cx - inset);
		const outerHh = Math.max(1, cy - inset);
		const outerR = Math.min(Math.max(0, radius - inset), outerHw, outerHh);

		const tOuter = rayHit(dx, dy, outerHw, outerHh, outerR, n);
		const tInner = rayHit(dx, dy, innerHw, innerHh, innerR, n);
		ticks.push({
			dx,
			dy,
			outer: {x: cx + dx * tOuter, y: cy + dy * tOuter},
			inner: {x: cx + dx * tInner, y: cy + dy * tInner},
		});
	}
	return ticks;
}
