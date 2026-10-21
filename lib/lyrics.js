// Lyrics resolver for the music widget's lyrics overlay.
//
// Chain, in order:
//   1. local .lrc next to the track file (xesam:url is file://),
//   2. cached result from a previous lookup (data dir /lyrics),
//   3. lrclib.net (free, keyless) — synced LRC or plain text,
//   4. nothing on any failure — the overlay stays on the folder art.

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';

// Shared keyless session, the same pattern the github widget uses. Timeouts
// keep a dead-network lookup from pinning the shell; look up happens off the
// paint path and its result arrives when it arrives.
let sharedSession = null;
function getSession() {
	if (!sharedSession) {
		sharedSession = new Soup.Session({
			user_agent: 'desktop-widgets@r3nhick',
			timeout: 6,
			io_timeout: 6,
		});
	};
	return sharedSession;
};

// ── LRC parsing ────────────────────────────────────────────────────────────

// "[mm:ss.xx] line" and multi-stamped "…[mm:ss.xx][mm:ss.yy] …"; metadata
// tags ([ar:], [ti:], [by:]...) hold letters and fall through the digits-only
// pattern. Returned sorted by time.
export function parseLrc(text) {
	const lines = [];
	const pattern = /\[(\d+):(\d+(?:\.\d+)?)\]/g;

	for (const raw of String(text ?? '').split(/\r\n|\r|\n/)) {
		pattern.lastIndex = 0;
		let stamp = null;
		let match;
		while ((match = pattern.exec(raw)) !== null) {
			const seconds = Number(match[1]) * 60 + Number(match[2]);
			(stamp ??= []).push(seconds);
		};

		const content = raw.replace(pattern, '').trim();
		if (!stamp || !content) continue;

		for (const time of stamp)
			lines.push({time, line: content});
	};

	lines.sort((a, b) => a.time - b.time);
	return lines;
};

// Synced take: index = the last stamped line at or before `positionUs`.
export function lineIndexAt(lines, positionUs) {
	if (!lines || lines.length === 0) return -1;
	const seconds = (Number(positionUs) || 0) / 1e6;
	let lo = 0;
	let hi = lines.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if ((lines[mid].time ?? lines[mid][0]) <= seconds) {
			found = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		};
	};
	return found;
};

// ── Streaming-title cleanup (YouTube browser players etc.) ─────────────────

const JUNK_PATTERNS = [
	// "(Official Music Video)", "[Lyrics]", "(HD)", "(MV)", "(2024 Mix)"...
	/\((?:[^()]*(?:official|video|audio|lyrics|music video|hd|hq|visualizer|instrumental|remaster|mv|4k|store full)[^()]*)\)/gi,
	/\[(?:[^\[\]]*(?:official|video|audio|lyrics|hd|hq|visualizer|instrumental|mv|4k|full)[^\[\]]*)\]/gi,
];

// Turns "Artist - Song (Official Video)" into {artist: "Artist",
// title: "Song"}. When the player supplies no artist (browsers), the dash
// split supplies both; with a real artist a dash inside the title is usually
// meaningful, so it stays.
export function cleanTrackQuery(title, artist) {
	let t = String(title ?? '').trim();
	let a = String(artist ?? '').trim();

	for (const pattern of JUNK_PATTERNS)
		t = t.replace(pattern, '');
	t = t.replace(/\s{2,}/g, ' ').trim();

	const genericArtist = !a
		|| /^(?:various(?: artists)?|unknown|mix|performance|playlist|full album|.+ hours?)$/i.test(a);
	if (genericArtist) {
		const dash = t.split(/\s+[-–—]\s+/);
		if (dash.length >= 2) {
			a = dash[0].trim();
			t = dash.slice(1).join(' - ').trim();
		};
	};

	return {artist: a || null, title: t || null};
};

// ── Resolver ───────────────────────────────────────────────────────────────

function lyricsCachePath(dir, artist, title) {
	const key = `${artist ?? ''}::${title ?? ''}`;
	let hash = 0;
	for (const ch of key)
		hash = ((hash * 31) + ch.codePointAt(0)) >>> 0;
	return GLib.build_filenamev([dir, `${hash.toString(36)}.json`]);
};

function loadCached(dir, artist, title) {
	try {
		const path = lyricsCachePath(dir, artist, title);
		const [ok, contents] = GLib.file_get_contents(path);
		if (!ok) return null;
		const data = JSON.parse(new TextDecoder().decode(contents));
		if (!data || typeof data.linesAsText !== 'string') return null;
		return data;
	} catch (_e) {
		return null;
	};
};

function saveCached(dir, artist, title, payload) {
	try {
		GLib.mkdir_with_parents(dir, 0o755);
		const path = lyricsCachePath(dir, artist, title);
		const json = JSON.stringify({artist, title, ...payload});
		GLib.file_set_contents(path, json);
	} catch (_e) {
		// Cache is best-effort only.
	};
};

function localLrcPath(trackUrl) {
	if (!trackUrl || !trackUrl.startsWith('file://')) return null;
	try {
		const [, path] = GLib.filename_from_uri(trackUrl);
		if (!path) return null;
		const base = GLib.path_get_basename(path);
		const dot = base.lastIndexOf('.');
		const stem = dot > 0 ? base.slice(0, dot) : base;
		return GLib.build_filenamev([GLib.path_get_dirname(path), `${stem}.lrc`]);
	} catch (_e) {
		return null;
	};
};

// Brackets in stream titles are almost always decorative junk absent from
// the indexed song name ("… (outsider house)", "[NCS Release]").
function stripAllBrackets(title) {
	return String(title ?? '')
		.replace(/\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\}/g, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim();
};

// Ordered query attempts for a streaming/browser track. LRCLIB's free-text
// search matches short indexed names well but chokes on complete video
// titles, so the list walks from targeted to bare: title+artist, bracketless
// title, then each dash segment.
function queryAttempts(query) {
	const attempts = [];
	const push = (candidate) => {
		const q = String(candidate ?? '').trim();
		if (!q) return;
		if (attempts.some(existing => existing.toLowerCase() === q.toLowerCase())) return;
		if (attempts.length >= 4) return;
		attempts.push(q);
	};

	const plainTitle = stripAllBrackets(query.title);
	if (query.artist) push(`${plainTitle} ${query.artist}`);
	push(plainTitle);

	const dash = query.title.split(/\s+[-–—]\s+/).map(part => part.trim()).filter(Boolean);
	if (dash.length >= 2) {
		push(dash[0]);
		push(dash.slice(1).join(' - '));
	};

	return attempts;
};

async function fetchLyricsHttp(attempts, durationSeconds) {
	try {
		for (const q of attempts) {
			const url = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
			log(`[debug] lyrics GET q="${q}"`);

			const message = Soup.Message.new('GET', url);
			if (!message) continue;

			const bytes = await new Promise(resolve => {
				getSession().send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_source, result) => {
					try {
						resolve(getSession().send_and_read_finish(result));
					} catch (_e) {
						resolve(null);
					};
				});
			});

			if (!bytes || message.get_status() !== Soup.Status.OK) {
				log(`[debug] lyrics GET miss (HTTP ${message.get_status()})`);
				continue;
			};

			const parsed = JSON.parse(new TextDecoder().decode(bytes.get_data()));
			if (!Array.isArray(parsed)) continue;

			// Synced LRC beats plain text; then text affinity to this
			// attempt's words (a bare "face" search must not pick a random
			// near-duration song); duration drift as the tie-breaker.
			const qWords = q.toLowerCase().split(/\s+/).filter(Boolean);
			const usable = parsed.filter(entry => entry
				&& ((entry.syncedLyrics && entry.syncedLyrics.trim())
					|| (entry.plainLyrics && entry.plainLyrics.trim())));

			const score = (entry) => {
				const synced = Boolean(entry.syncedLyrics && entry.syncedLyrics.trim());
				const duration = Number(entry.duration) || 0;
				const drift = durationSeconds > 0 && duration > 0
					? Math.min(Math.abs(duration - durationSeconds), 40) : 20;
				const hay = `${entry.trackName ?? ''} ${entry.artistName ?? ''}`.toLowerCase();
				const affinity = qWords.filter(word => hay.includes(word)).length;
				return (synced ? 0 : 1000) + Math.max(0, 30 - affinity * 10) + drift;
			};

			usable.sort((a, b) => score(a) - score(b));
			log(`[debug] lyrics GET "${q}" -> ${parsed.length} raw, ${usable.length} usable`);

			if (usable.length > 0) {
				const best = usable[0];
				log(`[debug] lyrics pick "${best.trackName}" / "${best.artistName}" dur=${best.duration}s synced=${Boolean(best.syncedLyrics && best.syncedLyrics.trim())}`);
				return best;
			};
		};
		return null;
	} catch (_e) {
		return null;
	};
};

// Resolves lyrics for the current track. Returns null when nothing exists.
// @param {object} opts
// @param {string|null} opts.artist
// @param {string|null} opts.title
// @param {number} [opts.durationUs] MPRIS length in microseconds
// @param {string|null} [opts.trackUrl] xesam:url (file:// enables the
//     local-lrc lane, http addresses from streaming players are ignored there)
// @param {string} opts.dir  cache directory (e.g. getDataDir('lyrics'))
export async function resolveLyrics({artist, title, durationUs = 0, trackUrl = null, dir = null}) {
	if (!title || !dir) return null;

	const query = cleanTrackQuery(title, artist);
	if (!query.title) return null;
	const durationSeconds = Math.max(0, (Number(durationUs) || 0) / 1e6);

	log(`[debug] lyrics resolve title="${title}" artist="${artist ?? ''}" dur=${durationSeconds}s url=${trackUrl ?? 'none'}`);

	const localPath = localLrcPath(trackUrl);
	if (localPath) {
		try {
			const [ok, contents] = GLib.file_get_contents(localPath);
			if (ok) {
				const lines = parseLrc(new TextDecoder().decode(contents));
				if (lines.length > 0) {
					log(`[debug] lyrics local .lrc hit (${lines.length} lines)`);
					return {synced: true, query, lines};
				};
			};
		} catch (_e) {
			// No local .lrc — continue down the chain.
		};
	};

	const cached = loadCached(dir, query.artist, query.title);
	if (cached && typeof cached.linesAsText === 'string' && cached.linesAsText.trim()) {
		log(`[debug] lyrics cache hit (synced=${Boolean(cached.synced)})`);
		if (cached.synced) {
			const lines = parseLrc(cached.linesAsText);
			if (lines.length > 0) {
				return {synced: true, query, lines};
			};
			// Unparseable cached LRC — fall through and refresh from network.
		} else {
			const plain = cached.linesAsText.split(/\r\n|\r|\n/).filter(Boolean);
			if (plain.length > 0) {
				return {synced: false, query, lines: plain.map((line, i) => ({time: -1 - i, line}))};
			};
		};
	};

	const hit = await fetchLyricsHttp(queryAttempts(query), durationSeconds);
	if (!hit) {
		log('[debug] lyrics miss: no candidates');
		return null;
	};

	const syncedText = hit.syncedLyrics && hit.syncedLyrics.trim() ? hit.syncedLyrics : null;
	const plainText = !syncedText && hit.plainLyrics && hit.plainLyrics.trim() ? hit.plainLyrics : null;
	if (!syncedText && !plainText) return null;

	if (syncedText) {
		const lines = parseLrc(syncedText);
		if (lines.length === 0) return null;
		saveCached(dir, query.artist, query.title, {synced: true, linesAsText: syncedText});
		return {synced: true, query, lines};
	};

	const lines = plainText.split(/\r\n|\r|\n/).filter(Boolean).map((line, i) => ({time: -1 - i, line}));
	saveCached(dir, query.artist, query.title, {synced: false, linesAsText: plainText});
	return {synced: false, query, lines};
};
