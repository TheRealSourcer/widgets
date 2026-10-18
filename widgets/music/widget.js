import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {surfaceStyle, watchSettings} from '../../utils/widget.js';
import {CHILD_ADDED, VERTICAL, boxOrientation, createBlurEffect, getMediaContainer, getMediaMessages} from '../../compatibility.js';

import { warn } from '../../logger.js';
import {clipRounded} from '../../utils/roundedClip.js';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const type = 'music';
export const label = 'Media Player';
export const stylesheet = 'widgets/music/stylesheet.css';
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium', 'large'];

const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PLAYER_PATH = '/org/mpris/MediaPlayer2';
const DBUS_IFACE = 'org.freedesktop.DBus.Properties';
const TICK_MS = 500;
const LOOP_CYCLE = ['None', 'Track', 'Playlist'];
const CHROMIUM_MARKERS = ['chromium', 'chrome', 'brave', 'vivaldi', 'opera', 'edge', 'yandex', 'thorium', 'helium', 'firefox'];

function mediaColors(theme) {
	return {
		foreground: theme.text ?? (theme.dark ? '#ffffff' : '#241f31'),
		secondary: theme.muted ?? (theme.dark ? '#c0bfbc' : '#5e5c64'),
		backdrop: theme.dark ? 'rgb(30, 33, 42)' : 'rgb(247, 247, 250)',
		tintStart: theme.dark ? 'rgba(26, 32, 44, 0.66)' : 'rgba(255, 255, 255, 0.78)',
		tintEnd: theme.dark ? 'rgba(10, 14, 23, 0.78)' : 'rgba(247, 247, 250, 0.88)',
	};
};

function isChromiumName(name) {
	const lower = String(name ?? '').toLowerCase();

	return CHROMIUM_MARKERS.some(marker => lower.includes(marker));
};

function variantValue(value) {
	return value && typeof value.deep_unpack === 'function' ? value.deep_unpack() : value;
};

function parseMetadata(metadata) {
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

function formatUs(us) {
	const ms = Math.max(0, Math.round((Number(us) || 0) / 1000));
	const minutes = Math.floor(ms / 60000);
	const seconds = Math.floor((ms % 60000) / 1000);

	return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

function boundedPosition(position, length) {
	const value = Number(position);
	const safe = Number.isFinite(value) ? Math.max(0, value) : 0;

	return length > 0 ? Math.min(safe, length) : safe;
};

function validPlayerPosition(value, current, length, status) {
	return Number.isFinite(value) && value >= 0 &&
		!(value < 500000 && current > 2000000 && status !== 'Stopped' &&
			(!length || current < length - 2000000));
};

function settingBoolean(settings, key, fallback = false) {
	return settings?.get_boolean(key) ?? fallback;
};

function safeArtworkUri(value) {
	 
	if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
		return null;
	};

	try {
		const uri = GLib.Uri.parse(value, GLib.UriFlags.NONE);
		const scheme = uri.get_scheme()?.toLowerCase();

		return ['file', 'http', 'https'].includes(scheme) ? uri.to_string() : null;
	} catch {
		return null;
	};
};

function artworkActor(uri, width, height, styleClass) {
	try {
		const actor = new St.Widget({
			style_class: styleClass,
			style: `background-image: url(${JSON.stringify(uri)});`,
			x_expand: true,
			y_expand: true,
			x_align: Clutter.ActorAlign.FILL,
			y_align: Clutter.ActorAlign.FILL,
		});

		actor.set_size(Math.round(width), Math.round(height));
		if (styleClass === 'widget-music-backdrop-art') {
			actor.x_expand = false;
			actor.y_expand = false;
			actor.opacity = 125;
			actor.add_effect(createBlurEffect({
				brightness: 1,
				radius: Math.max(24, Math.min(44, Math.round(Math.min(width, height) * 0.14))),
				mode: Shell.BlurMode.ACTOR,
			}));
		};
		return actor;
	} catch (error) {
		warn('music-artwork', `Could not load artwork ${uri}: ${error.message}`);
		return null;
	};
};

function replaceActor(parent, current, replacement) {
	if (current) {
		current.destroy();
	};

	if (replacement) {
		parent.insert_child_at_index(replacement, 0);
	};

	return replacement;
};

export function style(theme) {
	const background = theme.dark
		? theme.blur ? 'rgba(18, 20, 27, 0.68)' : 'rgb(18, 20, 27)'
		: theme.background;
	return surfaceStyle(theme, {background, color: mediaColors(theme).foreground});
};

function createControlButton(iconName, iconSize = 18, buttonSize = 32, color = '#ffffff') {
	const icon = new St.Icon({icon_name: iconName, style: `icon-size: ${iconSize}px; color: ${color};`});
	const button = new St.Button({
		style_class: 'widget-music-button',
		can_focus: true,
		reactive: true,
		track_hover: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
	});
	icon.x_align = Clutter.ActorAlign.CENTER;
	icon.y_align = Clutter.ActorAlign.CENTER;

	button._iconSize = iconSize;
	button._desktopWidgetsSelfClick = true;
	button.set_child(icon);
	button.set_size(buttonSize, buttonSize);

	return {button, icon};
};

function recolorIcon(target, color, alpha = 1) {
	target.icon.style = `icon-size: ${target.button._iconSize ?? 18}px; color: ${color};${alpha < 1 ? ` opacity: ${alpha};` : ''}`;
};

function createCard(theme, createLabel, widgetWidth, widgetHeight, blurredBackground = true) {
	const colors = mediaColors(theme);
	const width = Math.max(120, widgetWidth);
	const height = Math.max(96, widgetHeight);
	const compact = height <= 145;
	const vertical = !compact && (height > width * 1.18 || Math.abs(width - height) < Math.min(width, height) * 0.22);
	const roomy = Math.min(width, height) >= 300;
	const pad = compact ? 12 : roomy ? 20 : 14;
	const gap = compact ? 10 : roomy ? 18 : 12;
	const availableWidth = Math.max(72, width - pad * 2);
	const availableHeight = Math.max(72, height - pad * 2);
	const cover = compact
		? Math.max(52, Math.min(82, availableHeight))
		: vertical
			? Math.max(72, Math.min(roomy ? 184 : 108, availableWidth, availableHeight * (roomy ? 0.52 : 0.43)))
			: Math.max(82, Math.min(150, availableHeight));
	const coverWidth = vertical ? availableWidth : cover;
	const contentWidth = vertical ? availableWidth : Math.max(80, availableWidth - cover - gap);
	const contentHeight = vertical ? Math.max(50, availableHeight - cover - gap) : availableHeight;
	const titleFont = compact ? 16 : roomy ? 22 : 18;
	const artistFont = compact ? 12 : roomy ? 15 : 13;
	const timeFont = roomy ? 12 : 11;
	const barHeight = roomy ? 6 : 5;
	const thumbSize = roomy ? 13 : 11;
	const controlSize = compact ? 29 : roomy ? 36 : 32;
	const playSize = compact ? 34 : roomy ? 44 : 38;
	const showTimeline = !compact && contentHeight >= 100 && contentWidth >= 150;
	const card = {};
	const radius = theme?.radius ?? 26;
	const backdropInset = 48;

	card.container = new St.Widget({
		style_class: theme.dark ? 'widget-music-theme-dark' : 'widget-music-theme-light',
		layout_manager: new Clutter.BinLayout(),
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		y_align: Clutter.ActorAlign.FILL,
		clip_to_allocation: true,
		style: `border-radius: ${radius}px;`,
	});
	card.container.set_size(width - 2, height - 2);
	clipRounded(card.container, radius);

	card.backdrop = new St.Widget({
		style_class: 'widget-music-backdrop',
		layout_manager: new Clutter.FixedLayout(),
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		y_align: Clutter.ActorAlign.FILL,
		clip_to_allocation: true,
		style: `background-color: ${colors.backdrop};`,
	});
	card.backdrop.set_size(width - 2, height - 2);
	clipRounded(card.backdrop, radius, 1);
	card.backdropArt = null;
	card._backgroundEnabled = blurredBackground;

	card.tint = new St.Widget({
		style_class: 'widget-music-tint',
		style: `background-gradient-start: ${colors.tintStart}; background-gradient-end: ${colors.tintEnd};`,
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		y_align: Clutter.ActorAlign.FILL,
	});
	clipRounded(card.tint, radius, 1);

	card.content = new St.BoxLayout({
		...boxOrientation(vertical),
		x_expand: true,
		y_expand: true,
		x_align: vertical ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL,
		y_align: Clutter.ActorAlign.CENTER,
		style: `spacing: ${gap}px; padding: ${pad}px;`,
	});
	card.container.add_child(card.backdrop);
	card.container.add_child(card.tint);
	card.container.add_child(card.content);

	const coverRadius = Math.max(10, Math.round(cover * 0.11));

	card.coverBox = new St.Widget({
		layout_manager: new Clutter.BinLayout(),
		style_class: 'widget-music-cover-box',
		style: `border-radius: ${coverRadius}px;`,
		clip_to_allocation: true,
	});
	card.coverBox.set_size(coverWidth, cover);
	clipRounded(card.coverBox, coverRadius);
	card.coverBox.x_expand = false;
	card.coverBox.y_expand = false;
	card.coverArt = null;

	card.cover = new St.Icon({
		style_class: 'widget-music-cover',
		icon_name: 'audio-x-generic-symbolic',
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `icon-size: ${Math.round(cover * 0.36)}px; color: ${colors.secondary};`,
	});
	card.cover.set_size(coverWidth, cover);
	card.coverBox.add_child(card.cover);

	card.refreshArtwork = function () {
		const uri = card._artUri;
		const coverActor = uri ? artworkActor(uri, coverWidth, cover, 'widget-music-cover-art') : null;
		if (coverActor) {
			clipRounded(coverActor, coverRadius, 1);
		};
		const backdropActor = uri && card._backgroundEnabled
			? artworkActor(uri, width + backdropInset * 2, height + backdropInset * 2, 'widget-music-backdrop-art')
			: null;
		backdropActor?.set_position(-backdropInset, -backdropInset);

		card.coverArt = replaceActor(card.coverBox, card.coverArt, coverActor);
		card.backdropArt = replaceActor(card.backdrop, card.backdropArt, backdropActor);
		card.cover.visible = !card.coverArt;
		card.backdrop.visible = Boolean(card.backdropArt);
		card.tint.visible = Boolean(card.backdropArt);
	};

	card.showArt = function (artUrl) {
		const uri = safeArtworkUri(artUrl);

		if (uri === card._artUri) return;

		card._artUri = uri;
		card.refreshArtwork();
	};

	card.setBlurredBackground = function (enabled) {
		const next = Boolean(enabled);

		if (next === card._backgroundEnabled) return;

		card._backgroundEnabled = next;
		card.refreshArtwork();
	};

	card.column = new St.BoxLayout({
		...VERTICAL,
		width: contentWidth,
		x_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		y_align: Clutter.ActorAlign.CENTER,
		clip_to_allocation: true,
		style: `spacing: ${roomy ? 6 : 4}px;`,
	});

	card.title = createLabel('', 'widget-music-title', `font-size: ${titleFont}px; color: ${colors.foreground};`);
	card.title.clutter_text.single_line_mode = true;
	card.title.clutter_text.ellipsize = Pango.EllipsizeMode.END;

	card.artist = createLabel('', 'widget-music-artist', `font-size: ${artistFont}px; color: ${colors.secondary};`);
	card.artist.clutter_text.single_line_mode = true;
	card.artist.clutter_text.ellipsize = Pango.EllipsizeMode.END;

	card.times = new St.BoxLayout({
		x_expand: true,
		style_class: 'widget-music-times',
	});

	card.timeElapsed = createLabel('0:00', 'widget-music-time', `font-size: ${timeFont}px; color: ${colors.secondary};`);
	card.timeElapsed.x_align = Clutter.ActorAlign.START;
	card.timeTotal = createLabel('0:00', 'widget-music-time', `font-size: ${timeFont}px; color: ${colors.secondary};`);
	card.timeTotal.x_align = Clutter.ActorAlign.END;

	card._barHeight = barHeight;
	card._thumbSize = thumbSize;
	card._contentWidth = contentWidth;
	card._lastLength = 0;

	card.slider = new St.Button({
		style_class: 'widget-music-slider',
		can_focus: true,
		reactive: true,
		x_expand: true,
		track_hover: true,
	});
	card.slider._desktopWidgetsSelfClick = true;
	card.slider.set_width(contentWidth);
	card.slider.set_height(barHeight + 12);

	card.track = new St.Widget({
		style_class: 'widget-music-track',
		width: contentWidth - 6,
		style: `border-radius: ${barHeight / 2}px; min-height: ${barHeight}px; height: ${barHeight}px;`,
	});
	card.fill = new St.Widget({
		style_class: 'widget-music-fill',
		style: `background-color: ${theme.accent}; border-radius: ${barHeight / 2}px;`,
	});
	card.fill.set_size(0, barHeight);
	card.thumb = new St.Widget({
		style_class: 'widget-music-thumb',
		style: `width: ${thumbSize}px; height: ${thumbSize}px; border-radius: ${Math.round(thumbSize / 2)}px; background-color: ${theme.accent};`,
	});
	card.thumb.set_position(0, Math.round((barHeight - thumbSize) / 2));
	card.track.add_child(card.fill);
	card.track.add_child(card.thumb);
	card.slider.set_child(card.track);

	card.fractionForEvent = function (event) {
		const [stageX] = event.get_coords();
		const [trackX] = card.track.get_transformed_position();
		const [trackWidth] = card.track.get_transformed_size();

		if (trackWidth <= 0) {
			const fallbackWidth = card._contentWidth || card.slider.get_width() || 300;
			const fallbackTrackX = card.slider.get_transformed_position()[0];
			const fraction = (stageX - fallbackTrackX) / fallbackWidth;
			return fraction >= 0 && fraction <= 1 ? fraction : null;
		};

		const fraction = (stageX - trackX) / trackWidth;
		return fraction >= 0 && fraction <= 1 ? fraction : null;
	};

	card.preview = function (fraction) {
		const f = Math.max(0, Math.min(1, fraction ?? 0));
		const length = card._lastLength || 0;
		const trackWidth = card.track.get_width() > 0 ? card.track.get_width() : card._contentWidth;
		const fillWidth = Math.max(0, Math.min(trackWidth, Math.round(trackWidth * f)));

		card.timeElapsed.text = formatUs(Math.round(length * f));
		card.fill.set_size(fillWidth, barHeight);

		const maxThumbX = trackWidth - thumbSize / 2;
		const thumbX = Math.max(thumbSize / 2, Math.min(maxThumbX, fillWidth));
		card.thumb.set_position(Math.round(thumbX - thumbSize / 2), Math.round((barHeight - thumbSize) / 2));
	};

	card.controls = new St.BoxLayout({
		x_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		style: `spacing: ${roomy ? 7 : 4}px;`,
	});

	card.btnLoop = createControlButton('media-playlist-repeat-symbolic', compact ? 16 : 18, controlSize, colors.foreground);
	card.btnPrev = createControlButton('media-skip-backward-symbolic', compact ? 17 : 19, controlSize, colors.foreground);
	card.btnPlay = createControlButton('media-playback-start-symbolic', roomy ? 24 : 21, playSize, colors.foreground);
	card.btnPlay.button.add_style_class_name('widget-music-button-primary');
	card.btnNext = createControlButton('media-skip-forward-symbolic', compact ? 17 : 19, controlSize, colors.foreground);

	const controlsStart = new St.Widget({x_expand: true, style_class: 'widget-music-controls-spacer'});
	const controlsEnd = new St.Widget({x_expand: true, style_class: 'widget-music-controls-spacer'});

	card.controls.add_child(controlsStart);
	card.controls.add_child(card.btnLoop.button);
	card.controls.add_child(card.btnPrev.button);
	card.controls.add_child(card.btnPlay.button);
	card.controls.add_child(card.btnNext.button);
	card.controls.add_child(new St.Widget({width: controlSize, height: controlSize}));
	card.controls.add_child(controlsEnd);

	card.times.add_child(card.timeElapsed);
	card.times.add_child(card.timeTotal);
	card.column.add_child(card.title);
	card.column.add_child(card.artist);
	card.column.add_child(card.slider);
	card.column.add_child(card.times);
	card.column.add_child(card.controls);
	card.content.add_child(card.coverBox);
	card.content.add_child(card.column);

	if (!showTimeline) {
		card.slider.hide();
		card.times.hide();
	};

	card.update = function ({
		title, artist, artUrl, playing, position, length, canControl, canPrev, canNext, canPlay, canPause,
		loop = 'None', canSeek = false, seekPreview = false, loopSupported = true, forcePrev = false, forceNext = false,
	}) {
		const hasTrack = Boolean(title && title.length > 0);
		const control = canControl !== false || canPlay || canPause || canPrev || canNext || canSeek;

		if (hasTrack) {
			card.title.text = title;
			card.artist.text = artist || _('Unknown artist');
			card.showArt(artUrl);
		} else {
			card.title.text = _('Nothing playing');
			card.artist.text = _('Start playback in a media app');
			card.showArt(null);
			card.timeElapsed.text = '0:00';
			card.timeTotal.text = '0:00';
			card.fill.set_size(0, barHeight);
			card.thumb.set_position(0, Math.round((barHeight - thumbSize) / 2));
			card.thumb.opacity = 0;
		};

		const displayLength = hasTrack ? length : 0;
		const displayPosition = boundedPosition(position, displayLength);
		card._lastLength = displayLength;
		card.timeTotal.text = displayLength > 0 ? formatUs(displayLength) : '0:00';

		if (!seekPreview) {
			card.timeElapsed.text = hasTrack ? formatUs(displayPosition) : '0:00';

			const fraction = displayLength > 0 ? displayPosition / displayLength : 0;
			const trackWidth = card.track.get_width() > 0 ? card.track.get_width() : contentWidth;
			const maxFillWidth = trackWidth;
			const fillWidth = Math.max(0, Math.min(maxFillWidth, Math.round(trackWidth * fraction)));

			card.fill.set_size(fillWidth, barHeight);

			const maxThumbX = trackWidth - thumbSize / 2;
			const minThumbX = thumbSize / 2;
			const thumbX = Math.max(minThumbX, Math.min(maxThumbX, fillWidth));
			card.thumb.set_position(Math.round(thumbX - thumbSize / 2), Math.round((barHeight - thumbSize) / 2));
			card.thumb.opacity = hasTrack && displayLength > 0 ? 255 : 0;
		};

		const loopOk = loopSupported !== false;

		card.btnLoop.button.reactive = control && loopOk;
		card.btnLoop.button.opacity = loopOk ? (control ? 255 : 100) : 30;
		card.btnPrev.button.reactive = control && (!!canPrev || forcePrev);
		card.btnPrev.button.opacity = control && (canPrev || forcePrev) ? 255 : 100;
		card.btnPlay.button.reactive = control && (playing ? !!canPause : !!canPlay);
		card.btnPlay.button.opacity = control && (playing ? canPause : canPlay) ? 255 : 100;
		card.btnNext.button.reactive = control && (!!canNext || forceNext);
		card.btnNext.button.opacity = control && (canNext || forceNext) ? 255 : 100;

		const seekable = hasTrack && control && (length > 0 || playing) && (canSeek || canPlay || canPause);
		card.slider.reactive = seekable;
		card.slider.opacity = seekable ? 255 : 90;

		card.btnPlay.icon.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';

		recolorIcon(card.btnPlay, colors.foreground);
		recolorIcon(card.btnLoop, control ? colors.foreground : colors.secondary, control ? 1 : 0.4);
		recolorIcon(card.btnPrev, colors.foreground);
		recolorIcon(card.btnNext, colors.foreground);

		if (loop === 'Track') {
			card.btnLoop.icon.icon_name = 'media-playlist-repeat-song-symbolic';
			recolorIcon(card.btnLoop, theme.accent);
			card.btnLoop.button.add_style_pseudo_class('checked');
		} else if (loop === 'Playlist') {
			card.btnLoop.icon.icon_name = 'media-playlist-repeat-symbolic';
			recolorIcon(card.btnLoop, theme.accent);
			card.btnLoop.button.add_style_pseudo_class('checked');
		} else {
			card.btnLoop.icon.icon_name = 'media-playlist-repeat-symbolic';
			recolorIcon(card.btnLoop, control ? colors.foreground : colors.secondary, control ? 1 : 0.4);
			card.btnLoop.button.remove_style_pseudo_class('checked');
		};
	};

	card.update({title: null, artist: null, artUrl: null, playing: false, position: 0, length: 0,
		canControl: false, canPrev: false, canNext: false, canPlay: false, canPause: false, loop: 'None', canSeek: false});

	return card;
};

let Controller = class Controller {
	constructor(card, bus, settings, editMode = false) {
		this._card = card;
		this._bus = bus;
		this._settings = settings;
		this._editMode = Boolean(editMode);
		this._name = null;
		this._subIds = [];
		this._watchId = 0;
		this._timerId = 0;
		this._retryTimer = 0;
		this._status = 'Stopped';
		this._position = 0;
		this._posAt = 0;
		this._length = 0;
		this._playing = false;
		this._canControl = false;
		this._canPrev = false;
		this._canNext = false;
		this._canPlay = false;
		this._canPause = false;
		this._canSeek = false;
		this._loop = 'None';
		this._rate = 1;
		this._trackId = null;
		this._seekActive = false;
		this._seekFrac = null;
		this._positionBeforeSeek = 0;
		this._seekLockUntil = 0;
		this._lastPosSync = 0;
		this._positionRequestId = 0;
		this._lastPlayerScan = 0;
		this._seekCapture = false;
		this._meta = {title: null, artist: null, artUrl: null};
		this._relisten = false;
		this._destroyed = false;
		this._scanPending = false;
		this._generation = 0;
		this._cancellable = new Gio.Cancellable();
		this._bound = false;
		this._lastPlayingAt = {};
		this._chromium = false;
		this._lockedTrackId = null;
		this._acceptUntil = 0;
		this._loopSupport = null;
		this._controlEmitters = new Set();
		this._bindControls();
		this._bindBackgroundSetting();
	};

	_bindBackgroundSetting() {
		this._card.setBlurredBackground(settingBoolean(this._settings, 'music-blurred-background', true));

		this._settings?.connectObject('changed::music-blurred-background', () => {
			this._card.setBlurredBackground(settingBoolean(this._settings, 'music-blurred-background', true));
		}, this);
	};

	async start() {
		const bus = this._bus;

		if (!bus) {
			this._card.update({title: null, artist: null, artUrl: null, playing: false, position: 0, length: 0,
				canControl: false, canPrev: false, canNext: false, canPlay: false, canPause: false});
			return;
		};

		this._relisten = true;
		const generation = ++this._generation;
		const bestRow = await this._pickActive();

		if (this._destroyed || generation !== this._generation) return;

		if (bestRow && typeof bestRow.name === 'string' && bestRow.name) {
			this._name = bestRow.name;
			this._wire(bestRow.name);
			this._applyProps(bestRow.props);
			this._startTimer();
			return;
		};

		if (this._relisten === false) return;

		this._card.update({title: null, artist: null, artUrl: null, playing: false, position: 0, length: 0,
			canControl: false, canPrev: false, canNext: false, canPlay: false, canPause: false});
		this._startTimer();
		this._scheduleRelisten();
	};

	async _callRemote(busName, path, iface, method, params, type) {
		if (this._cancellable.is_cancelled()) {
			return null;
		};
		return new Promise(resolve => {
			this._bus.call(busName, path, iface, method, params, type,
				Gio.DBusCallFlags.NONE, -1, this._cancellable,
				(connection, result) => {
					try {
						const reply = connection.call_finish(result);
						resolve(this._destroyed ? null : reply);
					} catch {
						resolve(null);
					};
				});
		});
	};

	async listCandidates() {
		const result = await this._callRemote('org.freedesktop.DBus', '/org/freedesktop/DBus',
			'org.freedesktop.DBus', 'ListNames', null, GLib.VariantType.new('(as)'));
		const names = result?.deep_unpack()?.[0] ?? [];

		return names.filter(name => name.startsWith('org.mpris.MediaPlayer2.'));
	};

	async _pickActive() {
		const rows = [];

		for (const candidate of await this.listCandidates()) {
			const props = await this._readProps(candidate);

			if (!props) {
				continue;
			};

			const status = variantValue(props.PlaybackStatus);
			const meta = parseMetadata(variantValue(props.Metadata));
			const hasTitle = Boolean(meta.title && meta.title.length);
			const isChromium = isChromiumName(candidate);
			const ignoreBrowsers = settingBoolean(this._settings, 'music-ignore-browsers');
			
			if (ignoreBrowsers && isChromium) {
				continue;
			};

			const isProxy = candidate.toLowerCase().includes('playerctld');
			let value = 0;

			if (status === 'Playing' && hasTitle) {
				value = 500;

				if (!isChromium) {
					this._lastPlayingAt[candidate] = Date.now();
				};
			} else if (status === 'Paused' && hasTitle) {
				value = 100;
			} else if (hasTitle) {
				value = 50;
			};

			rows.push({name: candidate, props, status, hasTitle, value,
				recency: this._lastPlayingAt[candidate] ?? 0, isChromium, isProxy});
		};

		let bestNonChrome = null;
		let bestChrome = null;

		for (const row of rows) {
			if (row.value <= 0) {
				continue;
			};

			const current = row.isChromium ? bestChrome : bestNonChrome;

			if (!current || row.value > current.value ||
				(row.value === current.value && row.recency > current.recency)) {
				if (row.isChromium) {
					bestChrome = row;
				} else {
					bestNonChrome = row;
				};
			};
		};

		if (bestNonChrome && !(bestNonChrome.isProxy && bestChrome && bestNonChrome.value <= bestChrome.value)) {
			return bestNonChrome;
		};

		return bestChrome;
	};

	async _readProps(name) {
		const result = await this._callRemote(name, PLAYER_PATH, DBUS_IFACE, 'GetAll',
			GLib.Variant.new('(s)', [PLAYER_IFACE]), GLib.VariantType.new('(a{sv})'));
		const props = result?.deep_unpack()?.[0] ?? null;

		return props && typeof props === 'object' ? props : null;
	};

	_wire(name) {
		if (typeof name !== 'string' || !name) return;

		for (const id of this._subIds) {
			this._bus?.signal_unsubscribe(id);
		};

		this._subIds = [];

		this._chromium = isChromiumName(name);
		this._lockedTrackId = null;
		this._acceptUntil = 0;
		this._loopSupport = null;

		this._subIds.push(this._bus.signal_subscribe(name, DBUS_IFACE, 'PropertiesChanged', PLAYER_PATH, null,
			Gio.DBusSignalFlags.NONE,
			(_connection, _sender, _objectPath, _iface, _signal, parameters) => {
				const [changedInterface, changed, _invalidated] = parameters?.deep_unpack() ?? [];

				if (changedInterface !== PLAYER_IFACE) return;

				const statusChanged = changed?.PlaybackStatus !== undefined;

				if (statusChanged) {
					this._applyStatus(variantValue(changed.PlaybackStatus));

					if (this._playing) {
						this._syncPosition();
					};
				};

				if (changed?.Position !== undefined) {
					const value = Number(variantValue(changed.Position));
					if (validPlayerPosition(value, this._position, this._length, this._status)) {
						this._positionRequestId++;
						this._position = boundedPosition(value, this._length);
						this._posAt = Date.now();
						this._lastPosSync = Date.now();
					};
				};

				if (changed?.CanControl !== undefined) {
					this._canControl = Boolean(variantValue(changed.CanControl));
				};

				if (changed?.CanGoPrevious !== undefined) {
					this._canPrev = Boolean(variantValue(changed.CanGoPrevious));
				};

				if (changed?.CanGoNext !== undefined) {
					this._canNext = Boolean(variantValue(changed.CanGoNext));
				};

				if (changed?.CanPlay !== undefined) {
					this._canPlay = Boolean(variantValue(changed.CanPlay));
				};

				if (changed?.CanPause !== undefined) {
					this._canPause = Boolean(variantValue(changed.CanPause));
				};

				if (changed?.CanSeek !== undefined) {
					this._canSeek = Boolean(variantValue(changed.CanSeek));
				};

				if (changed?.LoopStatus !== undefined) {
					this._loop = variantValue(changed.LoopStatus);

					if (this._loopSupport === false) {
						this._loopSupport = null;
					};
				};

				if (changed?.Rate !== undefined) {
					this._rate = Number(variantValue(changed.Rate)) || 1;
				};

				if (changed?.Metadata !== undefined) {
					this._handleMetaChange(parseMetadata(changed.Metadata));
				};

				this._render();
			}));

		this._subIds.push(this._bus.signal_subscribe(name, PLAYER_IFACE, 'Seeked', PLAYER_PATH, null,
			Gio.DBusSignalFlags.NONE,
			(_connection, _sender, _objectPath, _iface, _signal, parameters) => {
				const [position] = parameters?.deep_unpack() ?? [];

				if (typeof position === 'number' && position >= 0) {
					this._positionRequestId++;
					this._position = boundedPosition(position, this._length);
					this._posAt = Date.now();
					this._lastPosSync = Date.now();
					this._seekLockUntil = 0;

					if (this._chromium && this._playing && position < 500000) {
						this._acceptUntil = Date.now() + 1500;
					};
					this._render();
				};
			}));

		if (this._watchId) {
			this._bus.unwatch_name(this._watchId);
			this._watchId = 0;
		};

		this._watchId = this._bus.watch_name(name, Gio.BusNameWatcherFlags.NONE,
			() => {},
			() => {
				if (this._relisten === false) return;

				this._position = 0;
				this._posAt = 0;
				this._meta = {title: null, artist: null, artUrl: null};
				this._playing = false;
				this._canControl = false;
				this._canPrev = false;
				this._canNext = false;
				this._canPlay = false;
				this._canPause = false;
				this._canSeek = false;
				this._loop = 'None';
				this._rate = 1;
				this._trackId = null;
				this._lockedTrackId = null;
				this._acceptUntil = 0;
				this._loopSupport = null;
				this._chromium = false;

				this._card.update({title: null, artist: null, artUrl: null, playing: false, position: 0, length: 0,
					canControl: false, canPrev: false, canNext: false, canPlay: false, canPause: false, canSeek: false});
				this._scheduleRelisten();
			});
	};

	_applyStatus(status) {
		const now = Date.now();
		if (this._playing && now >= this._seekLockUntil && !this._seekActive) {
			this._position = boundedPosition(this._position + (Math.max(0, this._rate) || 1) * (now - this._posAt) * 1000, this._length);
		};
		this._posAt = now;
		this._status = status;
		this._playing = status === 'Playing';

		if (status === 'Playing') {
			this._acceptUntil = Date.now() + 1500;

			if (this._chromium) {
				this._refreshMeta();
			};
		};

		if (status === 'Stopped') {
			this._positionRequestId++;
			this._meta = {title: null, artist: null, artUrl: null};
			this._length = 0;
			this._position = 0;
			this._posAt = Date.now();
			this._seekLockUntil = 0;
			this._seekActive = false;
			this._seekFrac = null;
			this._lockedTrackId = null;
		};
	};

	_refreshMeta() {
		if (!this._name || !this._bus) return;

		try {
			this._bus.call(this._name, PLAYER_PATH, DBUS_IFACE, 'Get',
				GLib.Variant.new('(ss)', [PLAYER_IFACE, 'Metadata']), null,
				Gio.DBusCallFlags.NONE, -1, this._cancellable,
				(_connection, result) => {
					try {
						const reply = _connection.call_finish(result);

						if (this._destroyed) return;

						this._handleMetaChange(parseMetadata(reply?.deep_unpack()?.[0]));
					} catch {
					};
				});
		} catch {
		};
	};

	_handleMetaChange(meta) {
		if (this._status === 'Stopped') return;

		const displayed = this._meta;
		const sameTrack = meta.title === displayed.title && meta.artist === displayed.artist &&
			(!meta.trackId || !this._trackId || meta.trackId === this._trackId);

		if (this._chromium) {
			const pinned = Boolean(this._lockedTrackId) && meta.trackId === this._lockedTrackId;
			const acceptNew = Date.now() < this._acceptUntil;

			if (!(pinned && sameTrack) && !acceptNew) return;

			if (!(pinned && sameTrack) && acceptNew) {
				this._acceptUntil = 0;
			};
		};

		if (sameTrack) {
			if (meta.artUrl !== displayed.artUrl) {
				displayed.artUrl = meta.artUrl;
			};

			if (meta.length > 0) {
				this._length = meta.length;
			};

			if (meta.trackId && !this._trackId) {
				this._trackId = meta.trackId;
			};

			if (this._chromium && !this._lockedTrackId && meta.trackId) {
				this._lockedTrackId = meta.trackId;
			};

			return;
		};

		this._meta = {title: meta.title, artist: meta.artist, artUrl: meta.artUrl};
		this._positionRequestId++;
		this._length = meta.length;

		if (this._chromium) {
			this._lockedTrackId = meta.trackId ?? null;
		};

		if (meta.trackId && meta.trackId !== this._trackId) {
			this._trackId = meta.trackId;
			this._position = 0;
			this._posAt = Date.now();
			this._syncPosition();
		} else if (meta.trackId && !this._trackId) {
			this._trackId = meta.trackId;
		};
	};

	_applyProps(props) {
		const status = variantValue(props.PlaybackStatus) ?? 'Stopped';
		const meta = parseMetadata(variantValue(props.Metadata));
		const position = Number(variantValue(props.Position) ?? 0);
		const trackChanged = meta.trackId && meta.trackId !== this._trackId;

		this._applyStatus(status);

		if (this._status === 'Stopped') {
			this._meta = {title: null, artist: null, artUrl: null};
			this._length = 0;
			this._lockedTrackId = null;
		} else {
			this._meta = {title: meta.title, artist: meta.artist, artUrl: meta.artUrl};
			this._lockedTrackId = meta.trackId ?? null;

			if (trackChanged || meta.length > 0) {
				this._length = meta.length;
			};
		};

		this._canControl = Boolean(variantValue(props.CanControl) ?? false);
		this._canPrev = Boolean(variantValue(props.CanGoPrevious) ?? false);
		this._canNext = Boolean(variantValue(props.CanGoNext) ?? false);
		this._canPlay = Boolean(variantValue(props.CanPlay) ?? false);
		this._canPause = Boolean(variantValue(props.CanPause) ?? false);
		this._canSeek = Boolean(variantValue(props.CanSeek) ?? false);
		this._loop = variantValue(props.LoopStatus) ?? 'None';
		this._loopSupport = props.LoopStatus !== undefined ? null : false;
		this._rate = Number(variantValue(props.Rate) ?? 1) || 1;

		if (trackChanged) {
			this._positionRequestId++;
			this._trackId = meta.trackId;
			this._position = boundedPosition(position, this._length);
			this._posAt = Date.now();
		} else if (this._status !== 'Stopped') {
			if (meta.trackId && !this._trackId) {
				this._trackId = meta.trackId;
			};

			if (position > 0) {
				this._position = position;
			};
		};

		this._posAt = Date.now();
		this._lastPosSync = Date.now();
		this._render();

		if (trackChanged || this._playing) {
			this._syncPosition();
		};
	};

	_startTimer() {
		if (this._timerId) return;

		this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
			const now = Date.now();

			if (this._playing) {
				if (now >= this._seekLockUntil && !this._seekActive) {
					this._position = boundedPosition(this._position + (Math.max(0, this._rate) || 1) * (now - this._posAt) * 1000, this._length);
					this._posAt = now;
				};

				if (now - this._lastPosSync > 5000) {
					this._lastPosSync = now;
					this._syncPosition();
				};
			};

			if (now - this._lastPlayerScan > 3000) {
				this._lastPlayerScan = now;
				this._reconsider();
			};

			this._render();
			return GLib.SOURCE_CONTINUE;
		});
	};

	async _reconsider() {
		if (this._relisten === false || !this._bus || this._scanPending) return;

		this._scanPending = true;
		const generation = this._generation;

		try {
			const best = await this._pickActive();

			if (this._destroyed || generation !== this._generation || !best ||
				typeof best.name !== 'string' || !best.name || best.name === this._name) return;

			this._name = best.name;
			this._wire(best.name);
			this._applyProps(best.props);
		} catch (error) {
			if (!this._destroyed) {
				warn('music: failed to scan MPRIS players', error);
			};
		} finally {
			this._scanPending = false;
		};
	};

	_render() {
		if (!this._card) return;

		const now = Date.now();
		const settle = this._seekActive || now < this._seekLockUntil;
		let position = this._position;

		if (this._playing && !settle) {
			position = this._position + (Math.max(0, this._rate) || 1) * (now - this._posAt) * 1000;
		};
		position = boundedPosition(position, this._length);

		this._card.update({
			title: this._meta.title,
			artist: this._meta.artist,
			artUrl: this._meta.artUrl,
			playing: this._playing,
			position,
			length: this._length,
			canControl: this._canControl,
			canPrev: this._canPrev,
			canNext: this._canNext,
			canPlay: this._canPlay,
			canPause: this._canPause,
			loop: this._loop,
			canSeek: this._canSeek,
			seekPreview: this._seekActive,
			loopSupported: this._loopSupport,
			forcePrev: this._chromium && this._playing,
			forceNext: this._chromium && this._playing,
		});
	};

	_bindControls() {
		if (this._bound) return;

		this._bound = true;

		const c = this._card;
		const callMethod = method => () => this._callMethod(method);
		const connect = (target, signal, handler) => {
			target.connectObject(signal, handler, this);
			this._controlEmitters.add(target);
		};

		connect(c.btnLoop.button, 'clicked', () => this._cycleLoop());
		connect(c.btnPrev.button, 'clicked', callMethod('Previous'));
		connect(c.btnPlay.button, 'clicked', callMethod('PlayPause'));
		connect(c.btnNext.button, 'clicked', callMethod('Next'));
		connect(c.slider, 'button-press-event', (_source, event) => this._onSliderPress(event));
		connect(c.slider, 'touch-event', (_source, event) => this._onSliderTouch(event));
	};

	_onSliderTouch(event) {
		const type = event.type();

		if (type !== Clutter.EventType.TOUCH_BEGIN && type !== Clutter.EventType.TOUCH_UPDATE && type !== Clutter.EventType.TOUCH_END) {
			return Clutter.EVENT_PROPAGATE;
		};

		if (this._editMode) {
			return Clutter.EVENT_PROPAGATE;
		};

		if (!this._card?.slider?.reactive || !this._name) {
			return Clutter.EVENT_PROPAGATE;
		};

		if (type === Clutter.EventType.TOUCH_BEGIN) {
			this._beginSeek(event);
			this._attachSeekCapture();
		} else if (type === Clutter.EventType.TOUCH_UPDATE) {
			this._updateSeek(event);
		} else if (type === Clutter.EventType.TOUCH_END) {
			if (this._seekActive) {
				this._endSeek(event);
				this._detachSeekCapture();
			};
		};

		return Clutter.EVENT_STOP;
	};

	_onSliderPress(event) {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		};

		if (this._editMode) {
			return Clutter.EVENT_PROPAGATE;
		};

		if (!this._card?.slider?.reactive || !this._name) {
			return Clutter.EVENT_PROPAGATE;
		};

		this._beginSeek(event);
		this._attachSeekCapture();

		return Clutter.EVENT_STOP;
	};

	_beginSeek(event) {
		const fraction = this._card.fractionForEvent(event);

		if (fraction === null) return;

		this._seekActive = true;
		this._seekFrac = fraction;
		this._positionBeforeSeek = this._position;
		this._card.preview(fraction);
	};

	_updateSeek(event) {
		const fraction = this._card.fractionForEvent(event);

		if (fraction !== null) {
			this._seekFrac = fraction;
			this._card.preview(fraction);
		};
	};

	_endSeek(event) {
		this._seekActive = false;
		this._card.slider?.remove_style_pseudo_class('active');

		const fraction = this._seekFrac !== null ? this._seekFrac : this._card.fractionForEvent(event);

		this._seekFrac = null;

		if (fraction !== null) {
			this._commitSeek(fraction);
		};
	};

	async _readTrackId() {
		if (!this._name) {
			return null;
		};

		const reply = await this._callRemote(this._name, PLAYER_PATH, DBUS_IFACE, 'Get',
			GLib.Variant.new('(ss)', [PLAYER_IFACE, 'Metadata']), null);
		const meta = parseMetadata(reply?.deep_unpack()?.[0]);

		return meta.trackId || null;
	};

	async _commitSeek(fraction) {
		if (!this._name || !this._length) return;

		const target = Math.max(0, Math.min(this._length, Math.floor(this._length * fraction)));
		const trackId = (await this._readTrackId()) || this._trackId || '/org/mpris/MediaPlayer2/TrackList/NoTrack';

		this._position = target;
		this._positionRequestId++;
		this._posAt = Date.now();
		this._lastPosSync = Date.now();
		this._seekLockUntil = Date.now() + 2000;
		this._render();

		const reply = await this._callRemote(this._name, PLAYER_PATH, PLAYER_IFACE, 'SetPosition',
			GLib.Variant.new('(ox)', [trackId, target]), null);

		if (reply === null) {
			const offset = target - this._positionBeforeSeek;
			const seekReply = await this._callRemote(this._name, PLAYER_PATH, PLAYER_IFACE, 'Seek',
				GLib.Variant.new('(x)', [offset]), null);

			if (seekReply === null) {
				warn('music-seek-failed', 'SetPosition and Seek both failed');
			};
		};
	};

	_attachSeekCapture() {
		if (this._seekCapture) return;

		this._seekCapture = true;

		global.stage.connectObject('captured-event', (_stage, event) => {
			const eventType = event.type();
			const isMotion = eventType === Clutter.EventType.MOTION ||
				eventType === Clutter.EventType.MOTION_NOTIFY ||
				eventType === Clutter.EventType.TOUCH_BEGIN ||
				eventType === Clutter.EventType.TOUCH_UPDATE;
			const isRelease = eventType === Clutter.EventType.BUTTON_RELEASE || eventType === Clutter.EventType.TOUCH_END;

			if (isMotion && this._seekActive) {
				this._updateSeek(event);
				return Clutter.EVENT_STOP;
			};

			if (isRelease && this._seekActive) {
				this._endSeek(event);
				this._detachSeekCapture();
				return Clutter.EVENT_STOP;
			};

			return Clutter.EVENT_PROPAGATE;
		}, this);
	};

	_detachSeekCapture() {
		if (!this._seekCapture) return;

		this._seekCapture = false;
		global.stage.disconnectObject(this);
	};

	_syncPosition() {
		if (!this._name || !this._bus) return;

		const player = this._name;
		const trackId = this._trackId;
		const requestId = ++this._positionRequestId;

		try {
			this._bus.call(player, PLAYER_PATH, DBUS_IFACE, 'Get',
				GLib.Variant.new('(ss)', [PLAYER_IFACE, 'Position']), null,
				Gio.DBusCallFlags.NONE, -1, this._cancellable,
				(_connection, result) => {
					try {
						const reply = _connection.call_finish(result);

						if (this._destroyed || player !== this._name || trackId !== this._trackId ||
							requestId !== this._positionRequestId) return;

						const value = Number(variantValue(reply?.deep_unpack()?.[0]));
						if (!validPlayerPosition(value, this._position, this._length, this._status)) return;

						this._position = boundedPosition(value, this._length);
						this._posAt = Date.now();
						this._render();
					} catch {
					};
				});
		} catch {
		};
	};

	_cycleLoop() {
		if (this._loopSupport === false) return;

		const next = LOOP_CYCLE[(LOOP_CYCLE.indexOf(this._loop) + 1) % LOOP_CYCLE.length];

		this._setLoop(next);
	};

	async _setLoop(next) {
		if (!this._name || this._loopSupport === false) return;

		const reply = await this._callRemote(this._name, PLAYER_PATH, DBUS_IFACE, 'Set',
			GLib.Variant.new('(ssv)', [PLAYER_IFACE, 'LoopStatus', new GLib.Variant('s', next)]), null);
		if (this._cancellable.is_cancelled()) return;

		if (reply !== null) {
			this._loop = next;
			this._loopSupport = true;
		} else if (this._loopSupport !== false) {
			this._loopSupport = false;
			warn('music-loop-unsupported', 'the player does not support setting LoopStatus');
		};

		this._render();
	};

	async _callMethod(method) {
		if (!this._name) return;

		const call = (m) => this._callRemote(this._name, PLAYER_PATH, PLAYER_IFACE, m, null, null);

		if (method === 'PlayPause') {
			const reply = await call('PlayPause');
			if (this._cancellable.is_cancelled()) return;

			if (reply === null) {
				if (this._playing) {
					await call('Pause');
				} else {
					await call('Play');
				};
			};

			return;
		};

		await call(method);
	};

	_scheduleRelisten() {
		if (this._relisten === false || this._retryTimer) return;

		this._retryTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
			this._retryTimer = 0;

			if (this._relisten) {
				this._name = null;
				this.start();
			};

			return GLib.SOURCE_REMOVE;
		});
	};

	destroy() {
		if (this._destroyed) return;

		this._destroyed = true;
		this._relisten = false;
		this._generation++;
		this._cancellable.cancel();

		if (this._timerId) {
			GLib.source_remove(this._timerId);
			this._timerId = 0;
		};

		if (this._retryTimer) {
			GLib.source_remove(this._retryTimer);
			this._retryTimer = 0;
		};

		this._detachSeekCapture();

		for (const id of this._subIds) {
			this._bus?.signal_unsubscribe(id);
		};

		this._subIds = [];

		if (this._watchId) {
			this._bus?.unwatch_name(this._watchId);
			this._watchId = 0;
		};


		this._settings?.disconnectObject(this);

		for (const target of this._controlEmitters) {
			target.disconnectObject(this);
		};

		this._controlEmitters.clear();

		this._card = null;
		this._bus = null;
		this._settings = null;
	};
};

export class SystemMediaControls {
	constructor(settings) {
		this._settings = settings;
		this._messageList = null;
		this._emitters = new Set();
		this._syncId = 0;
	};

	enable() {
		this._messageList = Main.panel.statusArea.dateMenu?._messageList ?? null;
		const view = getMediaContainer(this._messageList);
		if (view) {
			this._emitters.add(view);
			view.connectObject(CHILD_ADDED, () => {
				if (!this._syncId) {
					this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
						this._syncId = 0;
						this.sync();
						return GLib.SOURCE_REMOVE;
					});
				};
			}, this);
		};
		const section = this._messageList?._mediaSection;
		if (section) {
			this._emitters.add(section);
			section.connectObject('notify::visible', () => this.sync(), this);
		};
		this._emitters.add(this._settings);
		this._settings.connectObject('changed::hide-system-media-controls', () => this.sync(), this);
		this.sync();
	};

	sync() {
		const hide = this._settings.get_boolean('hide-system-media-controls');
		const section = this._messageList?._mediaSection;
		if (hide) {
			section?.hide();
		} else {
			section?._sync();
		};
		for (const message of getMediaMessages(this._messageList)) {
			if (hide) {
				message.hide();
			} else {
				message.show();
			};
		};
	};

	destroy() {
		if (this._syncId) {
			GLib.source_remove(this._syncId);
		};
		this._syncId = 0;
		for (const object of this._emitters) {
			object.disconnectObject(this);
		};
		this._emitters.clear();
		for (const message of getMediaMessages(this._messageList)) message.show();
		this._messageList?._mediaSection?._sync();
		this._messageList = null;
		this._settings = null;
	};
};

export let systemMediaControls = null;

export function initialize({settings}) {
	systemMediaControls = new SystemMediaControls(settings);
	systemMediaControls.enable();
};

let cachedBus = null;

function sessionBus() {
	if (cachedBus === null) {
		try {
			cachedBus = Gio.DBus.session;
		} catch (error) {
			warn('music: no session bus', error);
			cachedBus = undefined;
		};
	};

	return cachedBus;
};

export function cleanup() {
	systemMediaControls?.destroy();
	systemMediaControls = null;
	cachedBus = null;
};

export function render({body, createLabel, theme, sizeForWidget, widget, settings, editMode, refresh}) {
	watchSettings(body, settings, ['music-ignore-browsers'], refresh);
	const [widgetWidth, widgetHeight] = sizeForWidget ? sizeForWidget(widget) : [394, 190];
	const card = createCard(theme, createLabel, widgetWidth, widgetHeight,
		settingBoolean(settings, 'music-blurred-background', true));
	const controller = new Controller(card, sessionBus(), settings, editMode);

	body.add_child(card.container);
	card.container.connectObject('destroy', () => controller.destroy(), card.container);
	controller.start();
};
