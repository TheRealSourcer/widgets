import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {VERTICAL, setScrollViewChild} from './compatibility.js';
import {accentButtonStyle, setButtonStyle} from './utils/buttonStyle.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const CARD_WIDTH = 430;
const CARD_GAP = 16;
const DRAWER_MARGIN = 18;
const ANIMATION_TIME = 220;

const CATEGORY_KEYS = [
	'time',
	'information',
	'media',
	'productivity',
	'applications',
	'finance',
	'calendar',
];

const SIZE_ORDER = [
	'small',
	'medium',
	'large',
];

function categoryLabel(key) {
	const labels = {
		time: _('Time/Clocks'),
		information: _('Information'),
		media: _('Media'),
		productivity: _('Productivity'),
		applications: _('Applications'),
		finance: _('Finance'),
		calendar: _('Calendar'),
	};
	return labels[key] ?? labels.information;
};

function categoryKey(record) {
	const explicit = String(record.categoryKey ?? record.categoryId ?? record.category ?? '')
		.trim().toLocaleLowerCase();
	const type = String(record.type ?? record.id ?? '').toLocaleLowerCase();
	const localizedKey = CATEGORY_KEYS.find(key =>
		explicit === categoryLabel(key).toLocaleLowerCase());

	if (localizedKey) {
		return localizedKey;
	};
	if (type === 'calendar' || explicit === 'calendar') {
		return 'calendar';
	};
	if (['clock', 'digitalclock', 'binaryclock'].includes(type) ||
      ['time', 'clock', 'clocks', 'time/clocks'].includes(explicit)) {
		return 'time';
	};
	if (['photos', 'music'].includes(type) || explicit === 'media') {
		return 'media';
	};
	if (type === 'todo' || explicit === 'productivity') {
		return 'productivity';
	};
	if (type === 'applauncher' || ['application', 'applications', 'apps'].includes(explicit)) {
		return 'applications';
	};
	if (explicit === 'finance' || /(finance|stock|market|currency|crypto)/.test(type)) {
		return 'finance';
	};
	return 'information';
};

function sizeKey(sizeRecord) {
	const value = typeof sizeRecord === 'object' && sizeRecord !== null
		? sizeRecord.size ?? sizeRecord.key ?? sizeRecord.id ?? sizeRecord.value
		: sizeRecord;
	return String(value ?? '').trim().toLocaleLowerCase();
};

function sizeLabel(size) {
	const labels = {
		small: _('Small'),
		medium: _('Wide'),
		large: _('Large'),
	};
	return labels[size] ?? size;
};

function normalizedSizes(record) {
	const supplied = Array.isArray(record.sizes)
		? record.sizes
		: Array.isArray(record.supportedSizes)
			? record.supportedSizes
			: [];
	const unique = new Map();

	for (const sizeRecord of supplied) {
		const size = sizeKey(sizeRecord);
		if (!size || unique.has(size)) {
			continue;
		};

		unique.set(size, {
			...(typeof sizeRecord === 'object' && sizeRecord !== null ? sizeRecord : {}),
			size,
			label: sizeLabel(size),
		});
	};

	const requestedDefault = sizeKey(record.defaultSize ?? record.size);
	if (unique.size === 0) {
		const fallback = requestedDefault || 'small';
		unique.set(fallback, {size: fallback, label: sizeLabel(fallback)});
	};

	const sizes = [...unique.values()].sort((a, b) => {
		const aIndex = SIZE_ORDER.indexOf(a.size);
		const bIndex = SIZE_ORDER.indexOf(b.size);
		return (aIndex < 0 ? SIZE_ORDER.length : aIndex) -
      (bIndex < 0 ? SIZE_ORDER.length : bIndex);
	});

	return {
		sizes,
		defaultSize: unique.has(requestedDefault) ? requestedDefault : sizes[0].size,
	};
};

function safeCall(callback, fallback = undefined) {
	try {
		return typeof callback === 'function' ? callback() : fallback;
	} catch (error) {
		console.error(`[WidgetGallery] Callback failed: ${error.message}`);
		return fallback;
	};
};

function normalizedCatalog(catalog) {
	if (!Array.isArray(catalog)) {
		return [];
	};

	return catalog
		.filter(record => record && (record.type || record.id))
		.map(record => {
			const type = String(record.type ?? record.id);
			const label = String(record.label ?? record.name ?? type);
			const category = String(record.category ?? _('Information'));
			const sectionKey = categoryKey(record);
			const sectionLabel = categoryLabel(sectionKey);
			const description = String(record.description ?? '');
			const rawKeywords = Array.isArray(record.keywords)
				? record.keywords.join(' ')
				: String(record.keywords ?? '');
			const iconName = String(record.iconName ?? record.icon_name ?? record.icon ??
        'applications-other-symbolic');
			const sizes = normalizedSizes(record);

			return {
				...record,
				type,
				label,
				category,
				sectionKey,
				sectionLabel,
				description,
				keywords: rawKeywords,
				iconName,
				...sizes,
				searchText: `${label} ${type} ${category} ${sectionLabel} ${description} ${rawKeywords} ${sizes.sizes.map(size => size.label).join(' ')}`.toLocaleLowerCase(),
			};
		});
};

export class WidgetGallery {
	constructor(options = {}) {
		this._catalog = normalizedCatalog(options.catalog);
		this._onAdd = options.onAdd;
		this._onDrop = options.onDrop;
		this._onEditToggle = options.onEditToggle;
		this._onReset = options.onReset;
		this._onSettings = options.onSettings;
		this._getEditMode = options.getEditMode;
		this._createPreview = options.createPreview;
		this._accentColor = options.accentColor ?? '#77767b';

		this._cards = [];
		this._isOpen = false;
		this._destroyed = false;
		this._resetArmed = false;
		this._drag = null;
		this._launcherEnabled = true;

		this._buildOverlay();
		this.createLauncher();

		Main.layoutManager.connectObject('monitors-changed', () => this._syncGeometry(), this._overlay);
		this._syncGeometry();
	};


	_buildOverlay() {
		this._overlay = new St.Widget({
			clip_to_allocation: true,
			visible: false,
			reactive: false,
			can_focus: false,
			layout_manager: new Clutter.FixedLayout(),
			accessible_name: _('Widget gallery'),
		});

		this._drawer = new St.BoxLayout({
			...VERTICAL,
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.START,
			reactive: true,
			can_focus: true,
			style_class: 'widget-gallery-drawer',
			accessible_name: _('Choose a widget'),
		});
		this._overlay.add_child(this._drawer);

		this._buildHeader();
		this._buildSearch();
		this._buildCatalogArea();
		this._buildFooter();

		global.stage.connectObject('captured-event', (_stage, event) => {
			if (!this._isOpen || this._drag || event.type() !== Clutter.EventType.KEY_PRESS) {
				return Clutter.EVENT_PROPAGATE;
			};
			return this._onKeyPress(event);
		}, this._overlay);

		Main.uiGroup.add_child(this._overlay);
	};

	_buildHeader() {
		const header = new St.BoxLayout({
			x_expand: true,
			y_align: Clutter.ActorAlign.CENTER,
			style_class: 'widget-gallery-header',
		});

		const titles = new St.BoxLayout({
			...VERTICAL,
			x_expand: false,
			y_align: Clutter.ActorAlign.CENTER,
		});
		titles.add_child(new St.Label({
			text: _('Widgets'),
			style_class: 'widget-gallery-title',
			y_align: Clutter.ActorAlign.CENTER,
		}));
		header.add_child(titles);

		this._editButton = this._makeTextButton('', () => {
			this._disarmReset();
			safeCall(this._onEditToggle);
			this._updateEditButton();
		});
		header.add_child(this._editButton);

		const closeButton = new St.Button({
			child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 16,
				x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}),
			width: 38,
			height: 38,
			style_class: 'button widget-gallery-button widget-gallery-close-button',
			can_focus: true,
			track_hover: true,
			accessible_name: _('Close'),
		});
		setButtonStyle(closeButton, '');
		closeButton.connectObject('clicked', () => this.close(), closeButton);
		header.add_child(closeButton);

		this._drawer.add_child(header);
		this._header = header;
		this._updateEditButton();
	};

	_buildSearch() {
		this._searchEntry = new St.Entry({
			x_expand: true,
			can_focus: true,
			style_class: 'widget-gallery-search-entry',
			hint_text: _('Search widgets'),
			accessible_name: _('Search widgets'),
			primary_icon: new St.Icon({icon_name: 'system-search-symbolic', icon_size: 16}),
		});
		this._searchEntry.clutter_text.connectObject('text-changed', () => {
			this._disarmReset();
			this._rebuildGrid();
		}, this._searchEntry);
		this._searchEntry.clutter_text.connectObject('activate', () => {
			if (this._cards.length > 0) {
				this._cards[0].grab_key_focus();
			};
		}, this._searchEntry);
		this._header.insert_child_at_index(this._searchEntry, 1);
	};

	_buildCatalogArea() {
		this._scrollView = new St.ScrollView({
			x_expand: true,
			y_expand: true,
			overlay_scrollbars: true,
			hscrollbar_policy: St.PolicyType.AUTOMATIC,
			vscrollbar_policy: St.PolicyType.AUTOMATIC,
			enable_mouse_scrolling: true,
			style_class: 'widget-gallery-scroll-view',
		});

		this._grid = new St.BoxLayout({
			...VERTICAL,
			x_expand: true,
			style_class: 'widget-gallery-sections',
		});
		setScrollViewChild(this._scrollView, this._grid);
		this._drawer.add_child(this._scrollView);
		this._rebuildGrid();
	};

	_buildFooter() {
		const footer = new St.BoxLayout({
			x_expand: true,
			style_class: 'widget-gallery-footer',
		});

		this._resetButton = this._makeTextButton(_('Reset Layout'), () => {
			if (!this._resetArmed) {
				this._resetArmed = true;
				this._resetButton.label = _('Confirm Reset');
				this._resetButton.add_style_class_name('widget-gallery-reset-armed');
				this._resetButton.set_style('');
				const color = this._resetButton.get_theme_node().get_background_color();
				setButtonStyle(this._resetButton, '',
					`rgba(${color.red}, ${color.green}, ${color.blue}, ${Math.min(1, color.alpha / 255 + 0.025)})`);
				this._resetButton.accessible_name = _('Confirm reset layout');
				return;
			};

			this._disarmReset();
			safeCall(this._onReset);
			this._rebuildGrid();
		});

		const spacer = new St.Widget({x_expand: true});
		footer.add_child(spacer);
		footer.add_child(this._resetButton);

		const settingsButton = new St.Button({
			child: new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 18,
				x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}),
			width: 38,
			height: 38,
			can_focus: true,
			track_hover: true,
			style_class: 'button widget-gallery-button widget-gallery-settings-button',
			accessible_name: _('Open widget settings'),
		});
		setButtonStyle(settingsButton, '');
		settingsButton.connectObject('clicked', () => {
			this.close();
			safeCall(this._onSettings);
		}, settingsButton);
		footer.add_child(settingsButton);
		this._drawer.add_child(footer);
	};

	_makeTextButton(label, callback, accent = false) {
		const button = new St.Button({
			label,
			can_focus: true,
			reactive: true,
			track_hover: true,
			style_class: `button widget-gallery-button${accent ? ' widget-gallery-button-accent widget-accent-button' : ''}`,
		});
		setButtonStyle(button, accent ? accentButtonStyle(this._accentColor) : '');
		button.connectObject('clicked', callback, button);
		return button;
	};

	_matchingRecords() {
		const query = this._searchEntry?.get_text().trim().toLocaleLowerCase() ?? '';
		if (!query) {
			return this._catalog;
		};

		const terms = query.split(/\s+/).filter(Boolean);
		return this._catalog.filter(record =>
			terms.every(term => record.searchText.includes(term)));
	};

	_rebuildGrid() {
		if (!this._grid || this._destroyed || !this._isOpen) return;

		this._finishCardDrag();
		this._grid.destroy_all_children();
		this._cards = [];

		const records = this._matchingRecords();
		if (records.length === 0) {
			const empty = new St.BoxLayout({
				...VERTICAL,
				x_expand: true,
				y_expand: true,
				x_align: Clutter.ActorAlign.CENTER,
				y_align: Clutter.ActorAlign.CENTER,
				style_class: 'widget-gallery-empty-state',
			});
			empty.add_child(new St.Icon({
				icon_name: 'system-search-symbolic',
				icon_size: 32,
				style_class: 'widget-gallery-empty-icon',
			}));
			empty.add_child(new St.Label({
				text: _('No widgets found'),
				style_class: 'widget-gallery-empty-label',
			}));
			this._grid.add_child(empty);
			return;
		};

		const columns = this._columnCount || 1;
		for (const key of CATEGORY_KEYS) {
			const sectionRecords = records.filter(record => record.sectionKey === key);
			if (sectionRecords.length === 0) {
				continue;
			};

			const section = new St.BoxLayout({
				...VERTICAL,
				x_expand: true,
				style_class: `widget-gallery-section widget-gallery-section-${key}`,
			});
			section.add_child(new St.Label({
				text: categoryLabel(key),
				x_expand: true,
				style_class: 'widget-gallery-section-header',
				accessible_name: _('%s widgets').replace('%s', categoryLabel(key)),
			}));

			const layout = new Clutter.GridLayout({
				column_spacing: CARD_GAP,
				row_spacing: CARD_GAP,
				column_homogeneous: true,
			});
			const sectionGrid = new St.Widget({
				layout_manager: layout,
				x_expand: true,
				style_class: 'widget-gallery-section-grid',
			});

			sectionRecords.forEach((record, index) => {
				const card = this._createCard(record);
				this._cards.push(card._focusButton);
				layout.attach(card, index % columns, Math.floor(index / columns), 1, 1);
			});
			section.add_child(sectionGrid);
			this._grid.add_child(section);
		};
	};

	_createCard(record) {
		const card = new St.BoxLayout({
			...VERTICAL,
			width: CARD_WIDTH,
			x_align: Clutter.ActorAlign.CENTER,
			style_class: 'widget-gallery-preview-item',
		});

		const content = new St.BoxLayout({
			...VERTICAL,
			width: CARD_WIDTH,
			x_align: Clutter.ActorAlign.CENTER,
			y_expand: true,
			style_class: 'widget-gallery-preview-content',
		});

		const preview = new St.Widget({
			layout_manager: new Clutter.FixedLayout(),
			width: CARD_WIDTH,
			height: this._previewHeight ?? 180,
			x_align: Clutter.ActorAlign.CENTER,
			reactive: true,
			track_hover: true,
			style_class: 'widget-gallery-card-preview',
			clip_to_allocation: true,
		});
		let selectedSize = record.defaultSize;
		const renderPreview = size => {
			selectedSize = size;
			preview.destroy_all_children();
			const rendered = this._createPreview?.(record.type, size, CARD_WIDTH, this._previewHeight ?? 180);
			if (rendered) {
				preview.add_child(rendered);
			};
		};
		renderPreview(selectedSize);
		preview.connectObject('button-press-event', (_actor, event) =>
			this._beginCardDrag(preview, record, event, selectedSize), preview);
		preview.connectObject('button-release-event', (_actor, event) => {
			if (event.get_button() === 1 && !this._suppressClick) {
				this._addWidget(record, selectedSize);
			};
			return Clutter.EVENT_STOP;
		}, preview);
		content.add_child(preview);

		const titleRow = new St.BoxLayout({
			width: CARD_WIDTH,
			x_align: Clutter.ActorAlign.CENTER,
		});
		titleRow.add_child(new St.Widget({x_expand: true}));
		titleRow.add_child(new St.Label({
			text: record.label,
			style_class: 'widget-gallery-preview-title',
		}));
		titleRow.add_child(new St.Widget({x_expand: true}));

		content.add_child(titleRow);

		card.add_child(content);

		card.add_child(new St.Label({
			text: _('Size'),
			x_align: Clutter.ActorAlign.CENTER,
			style_class: 'widget-gallery-size-label',
		}));
		const chips = new St.BoxLayout({
			...VERTICAL,
			width: CARD_WIDTH,
			x_align: Clutter.ActorAlign.CENTER,
			style_class: 'widget-gallery-size-options',
			accessible_name: _('%s size options').replace('%s', record.label),
		});
		const chipButtons = [];
		let chipRow = null;
		for (const [index, sizeRecord] of record.sizes.entries()) {
			if (index % 4 === 0) {
				if (chipRow) {
					chipRow.add_child(new St.Widget({x_expand: true}));
				};
				chipRow = new St.BoxLayout({
					x_expand: true,
					x_align: Clutter.ActorAlign.FILL,
					style_class: 'widget-gallery-size-row',
				});
				chipRow.add_child(new St.Widget({x_expand: true}));
				chips.add_child(chipRow);
			};
			const chip = new St.Button({
				label: sizeRecord.label,
				can_focus: true,
				reactive: true,
				track_hover: true,
				style_class: 'button widget-gallery-button widget-gallery-size-chip',
				accessible_name: _('Add %s widget to Desktop at %s size')
					.replace('%s', record.label)
					.replace('%s', sizeRecord.label),
			});
			setButtonStyle(chip, '');
			chip.connectObject('clicked', () => {
				if (!this._suppressClick) {
					renderPreview(sizeRecord.size);
					for (const [key, button] of chipButtons) {
						if (key === sizeRecord.size) {
							button.add_style_class_name('widget-gallery-size-chip-selected');
						} else {
							button.remove_style_class_name('widget-gallery-size-chip-selected');
						};
						setButtonStyle(button, key === sizeRecord.size
							? `background-color: ${this._accentColor};`
							: '');
					};
				};
			}, chip);
			chip.connectObject('button-press-event', (_actor, event) =>
				this._beginCardDrag(chip, record, event, sizeRecord.size), chip);
			chipButtons.push([sizeRecord.size, chip]);
			chipRow.add_child(chip);

			if (!card._focusButton) {
				card._focusButton = chip;
				chip._widgetGalleryRecord = record;
				chip.connectObject('key-press-event', (_actor, event) =>
					this._onCardKeyPress(chip, event), chip);
			};
		};
		if (chipRow) {
			chipRow.add_child(new St.Widget({x_expand: true}));
		};
		for (const [key, button] of chipButtons) {
			if (key === selectedSize) {
				button.add_style_class_name('widget-gallery-size-chip-selected');
				setButtonStyle(button, `background-color: ${this._accentColor};`);
			};
		};
		card.add_child(chips);
		return card;
	};

	_beginCardDrag(source, record, event, requestedSize = null) {
		if ((event.get_button?.() ?? 1) !== 1 || this._drag) {
			return Clutter.EVENT_PROPAGATE;
		};

		const [startX, startY] = event.get_coords();
		this._suppressClick = false;
		const size = requestedSize ?? record.defaultSize ?? record.sizes?.[0]?.size ?? 'small';
		this._drag = {source, record, size, startX, startY, active: false, ghost: null};
		const handleDragEvent = (_stage, capturedEvent) => {
			if (!this._drag || this._drag.source !== source) {
				return Clutter.EVENT_PROPAGATE;
			};

			const type = capturedEvent.type();
			if (type === Clutter.EventType.KEY_RELEASE &&
          [Clutter.KEY_Super_L, Clutter.KEY_Super_R].includes(capturedEvent.get_key_symbol())) {
				return Clutter.EVENT_STOP;
			};
			if (type === Clutter.EventType.KEY_PRESS) {
				const key = capturedEvent.get_key_symbol();
				if (key === Clutter.KEY_Escape) {
					this._finishCardDrag();
					return Clutter.EVENT_STOP;
				};
				if (key === Clutter.KEY_Super_L || key === Clutter.KEY_Super_R) {
					Main.overview.toggle();
					return Clutter.EVENT_STOP;
				};
			};
			if (type !== Clutter.EventType.MOTION && type !== Clutter.EventType.BUTTON_RELEASE) {
				return Clutter.EVENT_PROPAGATE;
			};
			const [stageX, stageY] = capturedEvent.get_coords();
			if (type === Clutter.EventType.MOTION || type === Clutter.EventType.MOTION_NOTIFY) {
				if (!this._drag.active && Math.hypot(stageX - startX, stageY - startY) >= 8) {
					this._drag.active = true;
					this._suppressClick = true;
					this._drag.ghost = new St.BoxLayout({
						style_class: 'widget-gallery-drag-ghost',
						reactive: true,

					});
					this._drag.ghost.add_child(new St.Icon({icon_name: record.iconName, icon_size: 24}));
					this._drag.ghost.add_child(new St.Label({text: record.label, y_align: Clutter.ActorAlign.CENTER}));
					Main.uiGroup.add_child(this._drag.ghost);
					this._drag.ghost.connectObject('event', handleDragEvent, this._drag.ghost);
					global.stage.disconnectObject(source);
					this._drag.grab = global.stage.grab(this._drag.ghost);
					this.close(true);
					this._launcher?.hide();
				};
				if (this._drag.active) {
					this._drag.ghost?.set_position(Math.round(stageX + 12), Math.round(stageY + 12));
				};
				return this._drag.active ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
			};

			if (type === Clutter.EventType.BUTTON_RELEASE) {
				const active = this._drag.active;
				this._finishCardDrag();
				if (active) {
					safeCall(() => this._onDrop?.(record.type, size, stageX, stageY));
					return Clutter.EVENT_STOP;
				};
			};
			return Clutter.EVENT_PROPAGATE;
		};
		global.stage.connectObject('captured-event', handleDragEvent, source);
		return Clutter.EVENT_PROPAGATE;
	};

	_finishCardDrag() {
		if (!this._drag) return;
		global.stage.disconnectObject(this._drag.source);
		this._drag.grab?.dismiss();
		this._drag.ghost?.destroy();
		this._drag = null;
		if (!this._isOpen) {
			this._grid?.destroy_all_children();
			this._cards = [];
		};
		if (this._launcherEnabled) {
			this._launcher?.show();
		};
	};

	_addWidget(record, size) {
		this._disarmReset();
		safeCall(() => this._onAdd?.(record.type, size));
		this._rebuildGrid();
	};

	_onCardKeyPress(card, event) {
		const symbol = event.get_key_symbol();
		const current = this._cards.indexOf(card);
		const columns = this._columnCount || 1;
		let next = current;

		if (symbol === Clutter.KEY_Left) {
			next--;
		} else if (symbol === Clutter.KEY_Right) {
			next++;
		} else if (symbol === Clutter.KEY_Up) {
			next -= columns;
		} else if (symbol === Clutter.KEY_Down) {
			next += columns;
		} else {
			return Clutter.EVENT_PROPAGATE;
		};

		if (next >= 0 && next < this._cards.length) {
			this._cards[next].grab_key_focus();
			this._cards[next].scroll_to_point?.(0, 0);
		};
		return Clutter.EVENT_STOP;
	};

	_onKeyPress(event) {
		const symbol = event.get_key_symbol();
		if (symbol === Clutter.KEY_Escape) {
			this.close();
			return Clutter.EVENT_STOP;
		};

		if ((symbol === Clutter.KEY_f || symbol === Clutter.KEY_F) &&
        (event.get_state() & Clutter.ModifierType.CONTROL_MASK)) {
			this._searchEntry.grab_key_focus();
			return Clutter.EVENT_STOP;
		};

		return Clutter.EVENT_PROPAGATE;
	};

	_updateEditButton() {
		if (!this._editButton) return;

		const editing = !!safeCall(this._getEditMode, false);
		this._editButton.label = editing ? _('Done') : _('Edit');
		this._editButton.accessible_name = editing
			? _('Finish editing widgets')
			: _('Edit widgets');
		if (editing) {
			this._editButton.add_style_class_name('widget-accent-button');
		} else {
			this._editButton.remove_style_class_name('widget-accent-button');
		};
		setButtonStyle(this._editButton, editing
			? accentButtonStyle(this._accentColor)
			: '');
	};

	_disarmReset() {
		if (!this._resetArmed || !this._resetButton) return;

		this._resetArmed = false;
		this._resetButton.label = _('Reset Layout');
		this._resetButton.remove_style_class_name('widget-gallery-reset-armed');
		setButtonStyle(this._resetButton, '');
		this._resetButton.accessible_name = _('Reset widget layout');
	};

	_monitor() {
		return Main.layoutManager.primaryMonitor ?? Main.layoutManager.monitors?.[0] ?? null;
	};

	_syncGeometry() {
		if (this._destroyed) return;

		const monitor = this._monitor();
		if (!monitor) return;

		const availableWidth = Math.max(280, monitor.width - DRAWER_MARGIN * 2);
		const drawerWidth = Math.min(980, availableWidth);
		const smallPreviewSize = Math.min(170, Math.max(90, Math.floor(monitor.height * 0.4 * 0.36)));
		const previewHeight = Math.min(CARD_WIDTH, Math.ceil(smallPreviewSize * 460 / 220 + 16));
		const drawerHeight = Math.min(monitor.height - DRAWER_MARGIN * 2,
			Math.max(Math.round(monitor.height * 0.72), previewHeight + 280));
		this._overlay.set_position(monitor.x + Math.round((monitor.width - drawerWidth) / 2),
			monitor.y + monitor.height - drawerHeight);
		this._overlay.set_size(drawerWidth, drawerHeight);
		this._drawer.set_size(drawerWidth, drawerHeight);
		this._drawer.set_position(0, 0);
		this._drawerRestY = 0;
		this._drawer.translation_y = 0;

		const contentWidth = Math.max(CARD_WIDTH, drawerWidth - 36);
		const columns = Math.max(1, Math.floor((contentWidth + CARD_GAP) /
      (CARD_WIDTH + CARD_GAP)));
		if (columns !== this._columnCount || previewHeight !== this._previewHeight) {
			this._columnCount = columns;
			this._previewHeight = previewHeight;
			this._rebuildGrid();
		};

	};

	createLauncher() {
		if (this._launcher) {
			return this._launcher;
		};

		this._launcher = new PanelMenu.Button(0.5, _('Widgets'), true);
		this._launcher.add_child(new St.Icon({
			icon_name: 'view-grid-symbolic',
			style_class: 'system-status-icon',
		}));
		this._launcher.accessible_name = _('Open widget gallery');
		this._launcher.connectObject('button-release-event', (_actor, event) => {
			if (event.get_button() === 1) {
				this.toggle();
				return Clutter.EVENT_STOP;
			};
			if (event.get_button() === 3) {
				this._openLauncherMenu();
				return Clutter.EVENT_STOP;
			};
			return Clutter.EVENT_PROPAGATE;
		}, this._launcher);
		this._launcher.connectObject('key-press-event', (_actor, event) => {
			const symbol = event.get_key_symbol();
			if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space].includes(symbol)) {
				this.toggle();
				return Clutter.EVENT_STOP;
			};
			return Clutter.EVENT_PROPAGATE;
		}, this._launcher);
		Main.panel.addToStatusArea('widgets-gallery', this._launcher, 0, 'right');
		return this._launcher;
	};

	_openLauncherMenu() {
		if (!this._launcherMenu) {
			this._launcherMenu = new PopupMenu.PopupMenu(this._launcher, 0.5, St.Side.TOP);
			this._launcherMenu.actor.add_style_class_name('panel-menu');
			this._launcherMenu.actor.hide();
			Main.uiGroup.add_child(this._launcherMenu.actor);
			this._launcherMenuManager = new PopupMenu.PopupMenuManager(this._launcher);
			this._launcherMenuManager.addMenu(this._launcherMenu);
			this._toggleMenuItem = new PopupMenu.PopupMenuItem(_('Open Widget Gallery'));
			this._toggleMenuItem.connectObject('activate', () => this.toggle(), this._toggleMenuItem);
			this._launcherMenu.addMenuItem(this._toggleMenuItem);
			this._launcherMenu.addAction(_('Extension Settings'), () => safeCall(this._onSettings));
			this._launcherMenu.connectObject('open-state-changed', (_menu, open) => {
				if (open) {
					this._toggleMenuItem.label.text = this._isOpen ? _('Close Widget Gallery') : _('Open Widget Gallery');
				};
			}, this._launcherMenu.actor);
		};
		this._toggleMenuItem.label.text = this._isOpen ? _('Close Widget Gallery') : _('Open Widget Gallery');
		this._launcherMenu.open();
	};

	setCatalog(catalog) {
		this._catalog = normalizedCatalog(catalog);
		this._rebuildGrid();
	};

	setAccentColor(accentColor) {
		if (!accentColor || accentColor === this._accentColor) return;

		this._accentColor = accentColor;
		this._updateEditButton();
		this._rebuildGrid();
	};

	setLauncherEnabled(enabled) {
		this._launcherEnabled = Boolean(enabled);
		if (!this._launcher) return;

		if (this._launcherEnabled) {
			this._launcher.show();
		} else {
			this._launcher.hide();
		};
	};

	open() {
		if (this._destroyed || this._isOpen) return;

		this._syncGeometry();
		this._disarmReset();
		this._updateEditButton();
		this._isOpen = true;
		this._rebuildGrid();
		this._overlay.visible = true;
		this._overlay.get_parent()?.set_child_above_sibling(this._overlay, null);

		this._drawer.remove_all_transitions();
		this._drawer.opacity = 255;
		this._drawer.translation_y = this._drawer.height;
		this._drawer.ease({
			opacity: 255,
			translation_y: this._drawerRestY,
			duration: ANIMATION_TIME,
			mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			onComplete: () => {
				if (this._isOpen) {
					this._searchEntry.grab_key_focus();
				};
			},
		});
	};

	close(immediate = false) {
		if (!this._isOpen) return;

		this._isOpen = false;
		this._disarmReset();

		this._drawer.remove_all_transitions();
		const finish = () => {
			if (!this._isOpen && !this._destroyed) {
				this._overlay.hide();
				if (!this._drag) {
					this._grid.destroy_all_children();
					this._cards = [];
				};
				this._drawer.translation_y = this._drawerRestY;
				if (this._launcherEnabled) {
					this._launcher?.show();
				} else {
					this._launcher?.hide();
				};
			};
		};

		if (immediate) {
			this._drawer.opacity = 0;
			finish();
			return;
		};

		this._drawer.ease({
			translation_y: this._drawer.height,
			duration: ANIMATION_TIME,
			mode: Clutter.AnimationMode.EASE_IN_QUAD,
			onComplete: finish,
		});
	};

	toggle() {
		if (this._isOpen) {
			this.close();
		} else {
			this.open();
		};
	};

	get isOpen() {
		return this._isOpen;
	};

	destroy() {
		if (this._destroyed) return;

		this._finishCardDrag();
		this.close(true);
		this._destroyed = true;


		this._launcherMenu?.destroy();
		this._launcherMenu = null;
		this._launcherMenuManager = null;
		if (this._launcher) {
			this._launcher.destroy();
			this._launcher = null;
		};

		this._overlay?.destroy();
		this._overlay = null;
		this._drawer = null;
		this._searchEntry = null;
		this._grid = null;
		this._cards = [];
	};
};
