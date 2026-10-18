export function parseCssColor(cssColor) {
	const value = String(cssColor ?? '').trim();
	const hexMatch = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value);
	if (hexMatch) {
		let hex = hexMatch[1];
		if (hex.length <= 4) {
			hex = [...hex].map(character => character + character).join('');
		};
		return {
			r: Number.parseInt(hex.slice(0, 2), 16) / 255,
			g: Number.parseInt(hex.slice(2, 4), 16) / 255,
			b: Number.parseInt(hex.slice(4, 6), 16) / 255,
			a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
		};
	};

	const rgbaMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value);
	if (rgbaMatch) {
		const clamp = number => Math.max(0, Math.min(1, number));
		return {
			r: clamp(Number.parseFloat(rgbaMatch[1]) / 255),
			g: clamp(Number.parseFloat(rgbaMatch[2]) / 255),
			b: clamp(Number.parseFloat(rgbaMatch[3]) / 255),
			a: rgbaMatch[4] === undefined ? 1 : clamp(Number.parseFloat(rgbaMatch[4])),
		};
	};

	return {r: 0, g: 0, b: 0, a: 1};
};

export function cssColorToRgba(cssColor, alpha = 1) {
	const {r, g, b} = parseCssColor(cssColor);
	const safeAlpha = Math.max(0, Math.min(1, Number(alpha) || 0));
	return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${safeAlpha})`;
};
