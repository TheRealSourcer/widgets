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
		// NOTE: Soup 3 has no io_timeout — unknown constructor properties
		// throw, which (before the fix) silently killed the whole lyrics
		// chain right after the request started.
		sharedSession = new Soup.Session({
			user_agent: 'desktop-widgets@r3nhick',
			timeout: 6,
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

// 10-minute negative cache: known misses skip the network entirely (a
// mix/track without lyrics at the source would otherwise hit the busy API
// again on every overlay open).
const MISS_TTL_MS = 10 * 60 * 1000;
const missCache = new Map();

// ── YouTube captions lane (dormant behind the upstream wall) ───────────────
// Walks search -> watch page -> captionTracks -> timedtext. Every step is
// probe-logged; any wall (downloads currently empty for anonymous clients)
// resolves null and the chain just misses.

const YT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
let ytSession = null;

function getYtSession() {
	if (!ytSession) {
		// A cookie jar keeps the contact realistic; upstream may still gate
		// the timedtext download — the lane stays dormant until allowed.
		ytSession = new Soup.Session({user_agent: YT_UA, timeout: 8});
		ytSession.add_feature(new Soup.CookieJar({
			read_only: false,
			accept_policy: Soup.CookieJarAcceptPolicy.ALWAYS,
		}));
	};

	return ytSession;
};

function ytRequest(method, url, payload = null) {
	return new Promise(resolve => {
		let message = null;
		try {
			message = Soup.Message.new(method, url);
			if (message && payload !== null) {
				message.set_request_body_from_bytes('application/json', new GLib.Bytes(payload));
			};
		} catch (_e) {
			message = null;
		};

		if (!message) {
			resolve(null);
			return;
		};

		getYtSession().send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_source, result) => {
			try {
				resolve(getYtSession().send_and_read_finish(result));
			} catch (_e) {
				resolve(null);
			};
		});
	});
};

function findVideoRenderers(node, out) {
	if (!node || typeof node !== 'object' || out.length >= 8) return;

	if (Array.isArray(node)) {
		for (const child of node) {
			findVideoRenderers(child, out);
		};
		return;
	};

	if (node.videoRenderer && node.videoRenderer.videoId) {
		out.push(node.videoRenderer);
	};

	for (const key of Object.keys(node)) {
		findVideoRenderers(node[key], out);
	};
};

function lengthTextToSeconds(text) {
	if (!text) return 0;
	const parts = String(text).split(':').map(Number);
	if (parts.some(part => Number.isNaN(part))) return 0;
	return parts.reduce((sum, part) => sum * 60 + part, 0);
};

async function searchYouTubeVideoId(title, artist, durationSeconds) {
	const payload = JSON.stringify({
		context: {client: {clientName: 'WEB', clientVersion: '2.20240726.00.00', hl: 'en', gl: 'US'}},
		query: [title, artist].filter(Boolean).join(' '),
	});

	const bytes = await ytRequest('POST', 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false', payload);
	if (!bytes) {
		log('[debug] lyrics yt: search failed');
		return null;
	};

	let parsed;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes.get_data()));
	} catch (_e) {
		log('[debug] lyrics yt: search body unparseable');
		return null;
	};

	const candidates = [];
	findVideoRenderers(parsed.contents ?? parsed, candidates);

	const qWords = String(title).toLowerCase().split(/\s+/).filter(Boolean);

	let best = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const video of candidates) {
		const titleText = video.title?.runs?.[0]?.text ?? video.title?.simpleText ?? '';
		const ownerText = video.ownerText?.runs?.[0]?.text ?? '';
		const hay = `${titleText} ${ownerText}`.toLowerCase();
		const affinity = qWords.filter(word => hay.includes(word)).length;
		const seconds = lengthTextToSeconds(video.lengthText?.simpleText ?? null);
		const drift = durationSeconds > 0 && seconds > 0
			? Math.min(Math.abs(seconds - durationSeconds), 60) : 25;
		const ownerHit = artist && ownerText.toLowerCase().includes(artist.toLowerCase()) ? 0 : 12;
		const score = Math.max(0, 24 - affinity * 8) + drift + ownerHit;

		if (score < bestScore) {
			bestScore = score;
			best = {video, titleText, ownerText};
		};
	};

	if (!best) {
		log('[debug] lyrics yt: search found no video candidates');
		return null;
	};

	log(`[debug] lyrics yt: video ${best.video.videoId} "${best.titleText}" (${best.video.lengthText?.simpleText ?? '?'})`);
	return best.video.videoId;
};

function decodeEntities(text) {
	let out = String(text);

	out = out.replace(/&#(\d+);/g, (_, n) => {
		try {
			return String.fromCodePoint(Number(n));
		} catch (_e) {
			return '';
		};
	});
	out = out.replace(/&#x([0-9a-f]+);/gi, (_, n) => {
		try {
			return String.fromCodePoint(parseInt(n, 16));
		} catch (_e) {
			return '';
		};
	});

	return out
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, '\'')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
};

function json3ToLines(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (_e) {
		return null;
	};

	const lines = [];
	for (const event of parsed?.events ?? []) {
		if (!Array.isArray(event.segs) || typeof event.tStartMs !== 'number') continue;
		const text = event.segs.map(seg => seg.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
		if (text) {
			lines.push({time: event.tStartMs / 1000, line: text});
		};
	};

	return lines.length > 0 ? lines : null;
};

function xml3ToLines(raw) {
	const lines = [];
	const pattern = /<text\s+([^>]*)>([\s\S]*?)<\/text>/g;
	let match;

	while ((match = pattern.exec(raw)) !== null) {
		const start = (match[1].match(/start="([\d.]+)"/) ?? [])[1];
		if (start === undefined) continue;
		const text = decodeEntities(match[2]).replace(/\s+/g, ' ').trim();
		if (text) {
			lines.push({time: Number(start), line: text});
		};
	};

	return lines.length > 0 ? lines : null;
};

// Synthetic LRC so a cached payload re-uses the regular parser everywhere.
function linesToLrcText(lines) {
	return lines.map((entry) => {
		const total = Math.max(0, Number(entry.time) || 0);
		const minutes = Math.floor(total / 60);
		const seconds = (total - minutes * 60).toFixed(2).padStart(5, '0');
		return `[${minutes}:${seconds}]${entry.line}`;
	}).join('\n');
};

async function fetchYouTubeCaptionLines(videoId) {
	const bytes = await ytRequest('GET', `https://www.youtube.com/watch?v=${videoId}&hl=en`);
	if (!bytes) {
		log('[debug] lyrics yt: watch page failed');
		return null;
	};

	const html = new TextDecoder().decode(bytes.get_data());
	const marker = '"captionTracks":[';
	const head = html.indexOf(marker);
	if (head < 0) {
		log('[debug] lyrics yt: no captionTracks in watch page');
		return null;
	};

	const open = head + marker.length - 1; // include the array's own "["
	let depth = 0;
	let end = open;
	for (let i = open; i < html.length; i += 1) {
		const ch = html[i];
		if (ch === '[') {
			depth += 1;
		} else if (ch === ']') {
			depth -= 1;
			if (depth === 0) {
				end = i + 1;
				break;
			};
		};
	};

	let tracks;
	try {
		tracks = JSON.parse(html.slice(open, end));
	} catch (_e) {
		log('[debug] lyrics yt: captionTracks unparseable');
		return null;
	};

	if (!Array.isArray(tracks) || tracks.length === 0) {
		log('[debug] lyrics yt: captionTracks empty');
		return null;
	};

	// Uploaded (manual) subs first, auto-generated after.
	const track = tracks.find(entry => !entry.kind) ?? tracks[0];
	log(`[debug] lyrics yt: track lang=${track.languageCode} kind=${track.kind ?? 'manual'}`);

	const captionBytes = await ytRequest('GET', track.baseUrl);
	const captionRaw = captionBytes ? new TextDecoder().decode(captionBytes.get_data()) : '';
	let lines = captionRaw.trim() ? (json3ToLines(captionRaw) ?? xml3ToLines(captionRaw)) : null;

	if (!lines && track.baseUrl && !track.baseUrl.includes('fmt=')) {
		const altBytes = await ytRequest('GET', `${track.baseUrl}&fmt=json3`);
		const altRaw = altBytes ? new TextDecoder().decode(altBytes.get_data()) : '';
		lines = altRaw.trim() ? json3ToLines(altRaw) : null;
	};

	if (!lines) {
		log('[debug] lyrics yt: timedtext empty (upstream wall)');
		return null;
	};

	log(`[debug] lyrics yt: ${lines.length} caption lines`);
	return lines;
};

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
	for (const q of attempts) {
		const url = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
		log(`[debug] lyrics GET q="${q}"`);

		// Per-attempt scope: a dead attempt continues the chain, the loop
		// itself may not fail wholesale.
		for (let tryIndex = 0; tryIndex < 2; tryIndex += 1) {
			const message = Soup.Message.new('GET', url);
			if (!message) {
				log('[debug] lyrics message rejected');
				break;
			};

			// eslint-disable-next-line no-await-in-loop
			const bytes = await new Promise(resolve => {
				try {
					getSession().send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_source, result) => {
						try {
							resolve(getSession().send_and_read_finish(result));
						} catch (_e) {
							resolve(null);
						};
					});
				} catch (_e) {
					resolve(null);
				};
			});

			if (!bytes) {
				log(`[debug] lyrics GET fail (network) try=${tryIndex}`);
				continue;
			};

			if (message.get_status() !== Soup.Status.OK) {
				log(`[debug] lyrics GET miss (HTTP ${message.get_status()}) try=${tryIndex}`);
				// The API self-reports overload (503 busy) — one cautious
				// retry of the same query before moving on.
				if (message.get_status() === 503 && tryIndex === 0) {
					log('[debug] lyrics retrying after 503 busy');
					// eslint-disable-next-line no-await-in-loop
					await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
						resolve(null);
						return GLib.SOURCE_REMOVE;
					}));
					continue;
				};
				break;
			};

			const raw = new TextDecoder().decode(bytes.get_data());
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch (_e) {
				log(`[debug] lyrics parse fail body="${raw.slice(0, 120)}"`);
				break;
			};

			if (!Array.isArray(parsed)) {
				log(`[debug] lyrics non-list body="${raw.slice(0, 120)}"`);
				break;
			};

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

			break;
		};
	};

	return null;
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

	const missKey = `${query.artist ?? ''}|${query.title}`;
	const missAt = missCache.get(missKey);
	if (missAt && Date.now() - missAt < MISS_TTL_MS) {
		log('[debug] lyrics miss-cached (network skipped)');
		return null;
	};

	const hit = await fetchLyricsHttp(queryAttempts(query), durationSeconds);

	if (!hit) {
		// Last lane: the video's own captions. Local files skip it —
		// searching a streaming platform for an owned file would be wrong.
		if (!(trackUrl ?? '').startsWith('file://')) {
			const videoId = await searchYouTubeVideoId(query.title, query.artist, durationSeconds);

			if (videoId) {
				const captionLines = await fetchYouTubeCaptionLines(videoId);

				if (captionLines) {
					const linesAsText = linesToLrcText(captionLines);
					const lines = parseLrc(linesAsText);

					if (lines.length > 0) {
						missCache.delete(missKey);
						saveCached(dir, query.artist, query.title, {synced: true, linesAsText, source: 'youtube'});
						return {synced: true, query, lines};
					};
				};
			};
		};

		missCache.set(missKey, Date.now());
		log('[debug] lyrics miss: no candidates');
		return null;
	};

	missCache.delete(missKey);

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
