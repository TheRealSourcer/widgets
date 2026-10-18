export function accentButtonStyle(accentColor) {
	return `background-color: ${accentColor};`;
};

function hoverColor(style, fallback) {
	const backgrounds = [...style.matchAll(/background-color\s*:\s*([^;]+)/g)];
	const color = backgrounds.at(-1)?.[1].trim() ?? fallback;
	const hex = /^#([0-9a-f]{6})$/i.exec(color ?? '');

	if (hex) {
		const channels = [0, 2, 4].map(offset => parseInt(hex[1].slice(offset, offset + 2), 16));
		return `rgb(${channels.map(value => Math.round(value + (255 - value) * 0.06)).join(', ')})`;
	};

	const rgb = /^rgba?\(([^)]+)\)$/.exec(color ?? '');

	if (rgb) {
		const channels = rgb[1].split(',').map(Number);
		const alpha = channels[3] ?? 1;
		const shade = alpha < 1 ? channels.slice(0, 3) : channels.slice(0, 3).map(value => Math.round(value + (255 - value) * 0.06));
		return `rgba(${shade.join(', ')}, ${Math.min(1, alpha + 0.025)})`;
	};

	return 'rgba(255, 255, 255, 0.035)';
};

function cssColor(color) {
	return `rgba(${color.red}, ${color.green}, ${color.blue}, ${color.alpha / 255})`;
};

function normalGeometry(button) {
	const node = button.get_theme_node();
	const values = method => [0, 1, 2, 3].map(side => `${node[method](side)}px`).join(' ');
	const properties = [
		`padding: ${values('get_padding')}`,
		`border-width: ${values('get_border_width')}`,
		`border-radius: ${values('get_border_radius')}`,
	];
	for (const name of ['min-width', 'min-height']) {
		const [found, length] = node.lookup_length(name, false);
		if (found) {
			properties.push(`${name}: ${length}px`);
		};
	};
	for (const [side, name] of ['top', 'right', 'bottom', 'left'].entries()) {
		properties.push(`border-${name}-color: ${cssColor(node.get_border_color(side))}`);
	};
	button._widgetsBackgroundColor = cssColor(node.get_background_color());
	return properties.join('; ');
};

export function setButtonStyle(button, style, hoverBackground = null) {
	button._widgetsButtonStyle = style ?? '';
	button._widgetsHoverBackground = hoverBackground;
	if (!button._widgetsHoverRefresh) {
		button.style = button._widgetsButtonStyle;
		button._widgetsButtonGeometry = '';
		button.track_hover = true;
		button._widgetsHoverRefresh = () => {
			const base = button._widgetsButtonStyle;
			const stable = [button._widgetsButtonGeometry, base].filter(Boolean).join('; ');
			if (button.hover && button.reactive !== false) {
				const color = button._widgetsHoverBackground ?? hoverColor(base, button._widgetsBackgroundColor);
				button.style = /background-color\s*:/.test(stable)
					? stable.replace(/background-color\s*:\s*[^;]+/g, `background-color: ${color}`)
					: `${stable.replace(/;\s*$/, '')}; background-color: ${color};`;
			} else {
				button.style = stable;
			};
		};
		button.connectObject(
			'notify::hover', button._widgetsHoverRefresh,
			'notify::reactive', button._widgetsHoverRefresh,
			button);
		const captureGeometry = () => {
			if (button.get_stage() && !button._widgetsButtonGeometry) {
				button._widgetsButtonGeometry = normalGeometry(button);
				button._widgetsHoverRefresh();
			};
		};
		button.connectObject(
			'notify::mapped', captureGeometry,
			'destroy', () => {
				button._widgetsHoverRefresh = null;
			},
			button);
		captureGeometry();
	};
	button.style = [button._widgetsButtonGeometry, button._widgetsButtonStyle].filter(Boolean).join('; ');
	if (button.get_stage()) {
		button._widgetsBackgroundColor = cssColor(button.get_theme_node().get_background_color());
	};
	button._widgetsHoverRefresh();
};
