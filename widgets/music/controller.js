import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {warn} from '../../logger.js';
import {PLAYER_IFACE, PLAYER_PATH, DBUS_IFACE, isBrowserName, variantValue, parseMetadata, boundedPosition, validPlayerPosition, settingBoolean} from './helpers.js';
import {MprisTransport} from './transport.js';

const TICK_MS = 500;
const LOOP_CYCLE = ['None', 'Track', 'Playlist'];

export class Controller {
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
		this._scanPending = false;
		this._generation = 0;
		this._cancellable = new Gio.Cancellable();
		this._transport = new MprisTransport(bus, this._cancellable);
		this._lastPlayingAt = {};
		this._browser = false;
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
		if (this._cancellable.is_cancelled() || !this._card) return;
		const bus = this._bus;

		if (!bus) {
			this._card.update({title: null, artist: null, artUrl: null, playing: false, position: 0, length: 0,
				canControl: false, canPrev: false, canNext: false, canPlay: false, canPause: false});
			return;
		};

		const generation = ++this._generation;
		const bestRow = await this._pickActive();

		if (this._cancellable.is_cancelled() || generation !== this._generation) return;

		if (bestRow && typeof bestRow.name === 'string' && bestRow.name) {
			this._name = bestRow.name;
			this._wire(bestRow.name);
			this._applyProps(bestRow.props);
			this._startTimer();
			return;
		};

		this._card.update({title: null, artist: null, artUrl: null, playing: false, position: 0, length: 0,
			canControl: false, canPrev: false, canNext: false, canPlay: false, canPause: false});
		this._startTimer();
		this._scheduleRelisten();
	};


	_pickActive() {
		return this._transport.pickActive(settingBoolean(this._settings, 'music-ignore-browsers'), this._lastPlayingAt);
	};

	_wire(name) {
		if (this._cancellable.is_cancelled() || typeof name !== 'string' || !name) return;

		this._generation++;

		for (const id of this._subIds) {
			this._bus?.signal_unsubscribe(id);
		};

		this._subIds = [];

		this._browser = isBrowserName(name);
		this._lockedTrackId = null;
		this._acceptUntil = 0;
		this._loopSupport = null;

		this._subIds.push(this._bus.signal_subscribe(name, DBUS_IFACE, 'PropertiesChanged', PLAYER_PATH, null,
			Gio.DBusSignalFlags.NONE,
			(_connection, _sender, _objectPath, _iface, _signal, parameters) => {
				if (this._cancellable.is_cancelled() || !this._card || name !== this._name) return;

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
				if (this._cancellable.is_cancelled() || !this._card || name !== this._name) return;

				const [position] = parameters?.deep_unpack() ?? [];

				if (typeof position === 'number' && position >= 0) {
					this._positionRequestId++;
					this._position = boundedPosition(position, this._length);
					this._posAt = Date.now();
					this._lastPosSync = Date.now();
					this._seekLockUntil = 0;

					if (this._browser && this._playing && position < 500000) {
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
				if (this._cancellable.is_cancelled() || !this._card || name !== this._name) return;

				this._generation++;
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
				this._browser = false;

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

			if (this._browser) {
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

	async _refreshMeta() {
		if (!this._name || this._cancellable.is_cancelled()) return;

		const player = this._name;
		const generation = this._generation;
		const requestId = this._positionRequestId;
		const reply = await this._transport.call(player, PLAYER_PATH, DBUS_IFACE, 'Get',
			GLib.Variant.new('(ss)', [PLAYER_IFACE, 'Metadata']), null);

		if (this._cancellable.is_cancelled() || !this._card || !reply || player !== this._name ||
			generation !== this._generation || requestId !== this._positionRequestId) return;

		this._handleMetaChange(parseMetadata(reply.deep_unpack()?.[0]));
		this._render();
	};

	_handleMetaChange(meta) {
		if (this._status === 'Stopped') return;

		const displayed = this._meta;
		const sameTrack = meta.title === displayed.title && meta.artist === displayed.artist &&
			(!meta.trackId || !this._trackId || meta.trackId === this._trackId);

		if (this._browser) {
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

			if (this._browser && !this._lockedTrackId && meta.trackId) {
				this._lockedTrackId = meta.trackId;
			};

			return;
		};

		this._meta = {title: meta.title, artist: meta.artist, artUrl: meta.artUrl};
		this._positionRequestId++;
		this._length = meta.length;

		if (this._browser) {
			this._lockedTrackId = meta.trackId ?? null;
		};

		if (meta.trackId && meta.trackId !== this._trackId) {
			this._trackId = meta.trackId;
			this._position = 0;
			this._posAt = Date.now();
			this._syncPosition();
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
		if (this._cancellable.is_cancelled() || !this._bus || this._scanPending) return;

		this._scanPending = true;
		const generation = this._generation;

		try {
			const best = await this._pickActive();

			if (this._cancellable.is_cancelled() || generation !== this._generation || !best ||
				typeof best.name !== 'string' || !best.name || best.name === this._name) return;

			this._name = best.name;
			this._wire(best.name);
			this._applyProps(best.props);
		} catch (error) {
			if (!this._cancellable.is_cancelled()) {
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
			forcePrev: this._browser && this._playing,
			forceNext: this._browser && this._playing,
		});
	};

	_bindControls() {
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

	async _readTrackId(player) {
		if (this._cancellable.is_cancelled()) {
			return null;
		};

		const reply = await this._transport.call(player, PLAYER_PATH, DBUS_IFACE, 'Get',
			GLib.Variant.new('(ss)', [PLAYER_IFACE, 'Metadata']), null);
		const meta = parseMetadata(reply?.deep_unpack()?.[0]);

		return meta.trackId || null;
	};

	async _commitSeek(fraction) {
		if (!this._name || !this._length || this._cancellable.is_cancelled()) return;

		const player = this._name;
		const generation = this._generation;
		const previousTrack = this._trackId;

		const target = Math.max(0, Math.min(this._length, Math.floor(this._length * fraction)));
		const trackId = (await this._readTrackId(player)) || previousTrack || '/org/mpris/MediaPlayer2/TrackList/NoTrack';

		if (this._cancellable.is_cancelled() || !this._card || player !== this._name ||
			generation !== this._generation || previousTrack !== this._trackId) return;

		this._position = target;
		this._positionRequestId++;
		this._posAt = Date.now();
		this._lastPosSync = Date.now();
		this._seekLockUntil = Date.now() + 2000;
		this._render();

		const reply = await this._transport.call(player, PLAYER_PATH, PLAYER_IFACE, 'SetPosition',
			GLib.Variant.new('(ox)', [trackId, target]), null, true);

		if (this._cancellable.is_cancelled() || !this._card || player !== this._name ||
			generation !== this._generation || previousTrack !== this._trackId) return;

		if (reply === null) {
			const offset = target - this._positionBeforeSeek;
			const seekReply = await this._transport.call(player, PLAYER_PATH, PLAYER_IFACE, 'Seek',
				GLib.Variant.new('(x)', [offset]), null);

			if (this._cancellable.is_cancelled() || player !== this._name || generation !== this._generation) return;

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

	async _syncPosition() {
		if (!this._name || this._cancellable.is_cancelled()) return;

		const player = this._name;
		const generation = this._generation;
		const trackId = this._trackId;
		const requestId = ++this._positionRequestId;
		const reply = await this._transport.call(player, PLAYER_PATH, DBUS_IFACE, 'Get',
			GLib.Variant.new('(ss)', [PLAYER_IFACE, 'Position']), null, true);

		if (this._cancellable.is_cancelled() || !this._card || !reply || player !== this._name ||
			generation !== this._generation || trackId !== this._trackId || requestId !== this._positionRequestId) return;

		const value = Number(variantValue(reply.deep_unpack()?.[0]));
		if (!validPlayerPosition(value, this._position, this._length, this._status)) return;

		this._position = boundedPosition(value, this._length);
		this._posAt = Date.now();
		this._render();
	};

	_cycleLoop() {
		if (this._loopSupport === false) return;

		const next = LOOP_CYCLE[(LOOP_CYCLE.indexOf(this._loop) + 1) % LOOP_CYCLE.length];

		this._setLoop(next);
	};

	async _setLoop(next) {
		if (!this._name || this._loopSupport === false || this._cancellable.is_cancelled()) return;

		const player = this._name;
		const generation = this._generation;

		const reply = await this._transport.call(player, PLAYER_PATH, DBUS_IFACE, 'Set',
			GLib.Variant.new('(ssv)', [PLAYER_IFACE, 'LoopStatus', new GLib.Variant('s', next)]), null, true);
		if (this._cancellable.is_cancelled() || !this._card || player !== this._name || generation !== this._generation) return;

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
		if (!this._name || this._cancellable.is_cancelled()) return;

		const player = this._name;
		const generation = this._generation;
		const call = m => this._transport.call(player, PLAYER_PATH, PLAYER_IFACE, m, null, null, m === 'PlayPause');

		if (method === 'PlayPause') {
			const reply = await call('PlayPause');
			if (this._cancellable.is_cancelled() || !this._card || player !== this._name || generation !== this._generation) return;

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
		if (this._cancellable.is_cancelled() || this._retryTimer) return;

		this._retryTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
			this._retryTimer = 0;

			if (!this._cancellable.is_cancelled()) {
				this._name = null;
				this.start();
			};

			return GLib.SOURCE_REMOVE;
		});
	};

	destroy() {
		this._generation++;

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
		this._transport.destroy();
		this._seekActive = false;
		this._name = null;

		this._card = null;
		this._bus = null;
		this._settings = null;
	};
};
