export function surfaceStyle(theme, {
	background = theme.background, color = theme.text, padding = null, border = true,
} = {}) {
	return [
		background !== null ? `background-color: ${background}` : null,
		border ? `border-color: ${theme.border}` : null,
		`color: ${color}`,
		`border-radius: ${theme.radius}px`,
		padding !== null ? `padding: ${padding}` : null,
	].filter(Boolean).join('; ') + ';';
};

export function watchSettings(body, settings, keys, refresh) {
	if (!settings || !refresh) return;
	for (const key of keys) {
		settings.connectObject(`changed::${key}`, refresh, body);
	};
};
