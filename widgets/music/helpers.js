export const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
export const PLAYER_PATH = '/org/mpris/MediaPlayer2';
export const DBUS_IFACE = 'org.freedesktop.DBus.Properties';
export const BROWSER_MARKERS = ['chromium', 'chrome', 'brave', 'vivaldi', 'opera', 'edge', 'yandex', 'thorium', 'helium', 'firefox'];

export function isBrowserName(name) {
	const lower = String(name ?? '').toLowerCase();

	return BROWSER_MARKERS.some(marker => lower.includes(marker));
};

export function variantValue(value) {
	return value && typeof value.deep_unpack === 'function' ? value.deep_unpack() : value;
};

export function parseMetadata(metadata) {
	const md = variantValue(metadata) ?? {};
	let artist = variantValue(md['xesam:artist']);

	if (Array.isArray(artist)) {
		artist = artist.join(' / ');
	} else if (artist && typeof artist === 'object') {
		artist = String(artist);
	};

	return {
		title: variantValue(md['xesam:title']) ?? null,
		artist: typeof artist === 'string' && artist.length > 0 ? artist : null,
		artUrl: variantValue(md['mpris:artUrl']) ?? null,
		length: Math.max(0, Number(variantValue(md['mpris:length']) ?? 0)),
		trackId: variantValue(md['mpris:trackid']) ?? null,
	};
};

export function formatUs(us) {
	const ms = Math.max(0, Math.round((Number(us) || 0) / 1000));
	const minutes = Math.floor(ms / 60000);
	const seconds = Math.floor((ms % 60000) / 1000);

	return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

export function boundedPosition(position, length) {
	const value = Number(position);
	const safe = Number.isFinite(value) ? Math.max(0, value) : 0;

	return length > 0 ? Math.min(safe, length) : safe;
};

export function validPlayerPosition(value, current, length, status) {
	return Number.isFinite(value) && value >= 0 &&
		!(value < 500000 && current > 2000000 && status !== 'Stopped' &&
			(!length || current < length - 2000000));
};

export function settingBoolean(settings, key, fallback = false) {
	return settings?.get_boolean(key) ?? fallback;
};
