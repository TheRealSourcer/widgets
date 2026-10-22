import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {VERTICAL, setScrollViewChild} from './compatibility.js';
import {accentButtonStyle, setButtonStyle} from './utils/buttonStyle.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {CATEGORY_KEYS, categoryLabel, normalizedCatalog} from './gallery/catalog.js';
import {CARD_WIDTH, createCard} from './gallery/card.js';
import {GalleryDrag} from './gallery/drag.js';
import {DrawerAnimation} from './gallery/animation.js';
import {GalleryLauncher} from './gallery/launcher.js';
import {ensureVisible, nextCardIndex} from './gallery/navigation.js';

const CARD_GAP = 16;
const DRAWER_MARGIN = 18;
const ANIMATION_TIME = 220;

function safeCall(callback, fallback = undefined) {
	try {
		return callback();
	} catch (error) {
		console.error(`[WidgetGallery] Callback failed: ${error.message}`);
		return fallback;
	};
};

export class WidgetGallery {
	constructor(options) {
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
		this._resetArmed = false;
		this._launcherEnabled = true;

		try {
			this._buildOverlay();
			this._animation = new DrawerAnimation(this._drawer, this._overlay);
			this._drag = new GalleryDrag({
				close: immediate => this.close(immediate),
				hideLauncher: () => this._launcher.hide(),
				onDrop: (type, size, x, y) => safeCall(() => this._onDrop(type, size, x, y)),
				onFinish: () => {
					if (!this._isOpen) {
						this._clearCards();
					};
					if (this._launcherEnabled) {
						this._launcher.show();
					};
				},
			});
			const gallery = this;
			this._panelLauncher = new GalleryLauncher({
				toggle: () => this.toggle(),
				onSettings: () => safeCall(this._onSettings),
				get isOpen() { return gallery.isOpen; },
			});
			this._launcher = this.createLauncher();

			Main.layoutManager.connectObject('monitors-changed', () => this._syncGeometry(), this._overlay);
			this._syncGeometry();
		} catch (error) {
			this.destroy();
			throw error;
		};
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
			if (!this._isOpen || this._drag.pending || event.type() !== Clutter.EventType.KEY_PRESS) {
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
		this._drawer.add_child(header);
		this._header = header;

		const titles = new St.BoxLayout({
			...VERTICAL,
			x_expand: false,
			y_align: Clutter.ActorAlign.CENTER,
		});
		header.add_child(titles);
		titles.add_child(new St.Label({
			text: _('Widgets'),
			style_class: 'widget-gallery-title',
			y_align: Clutter.ActorAlign.CENTER,
		}));

		this._editButton = this._makeTextButton(header, '', () => {
			this._disarmReset();
			safeCall(this._onEditToggle);
			this._updateEditButton();
		});

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
		header.add_child(closeButton);
		setButtonStyle(closeButton, '');
		closeButton.connectObject('clicked', () => this.close(), closeButton);
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
		this._header.insert_child_at_index(this._searchEntry, 1);
		this._searchEntry.clutter_text.connectObject('text-changed', () => {
			this._disarmReset();
			this._rebuildGrid();
		}, this._searchEntry);
		this._searchEntry.clutter_text.connectObject('activate', () => {
			if (this._cards.length > 0) {
				this._focusCard(0);
			};
		}, this._searchEntry);
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
		this._drawer.add_child(this._scrollView);

		this._grid = new St.BoxLayout({
			...VERTICAL,
			x_expand: true,
			style_class: 'widget-gallery-sections',
		});
		setScrollViewChild(this._scrollView, this._grid);
		this._rebuildGrid();
	};

	_buildFooter() {
		const footer = new St.BoxLayout({
			x_expand: true,
			style_class: 'widget-gallery-footer',
		});
		this._drawer.add_child(footer);
		footer.add_child(new St.Widget({x_expand: true}));

		this._resetButton = this._makeTextButton(footer, _('Reset Layout'), () => {
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
		footer.add_child(settingsButton);
		setButtonStyle(settingsButton, '');
		settingsButton.connectObject('clicked', () => {
			this.close();
			safeCall(this._onSettings);
		}, settingsButton);
	};

	_makeTextButton(parent, label, callback, accent = false) {
		const button = new St.Button({
			label,
			can_focus: true,
			reactive: true,
			track_hover: true,
			style_class: `button widget-gallery-button${accent ? ' widget-gallery-button-accent widget-accent-button' : ''}`,
		});
		parent.add_child(button);
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
		if (!this._grid || !this._isOpen) return;

		this._drag.finish();
		this._clearCards();

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
			this._grid.add_child(section);
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

			section.add_child(sectionGrid);
			const sectionStart = this._cards.length;
			sectionRecords.forEach((record, index) => {
				const card = createCard(record, {
					previewHeight: this._previewHeight,
					accentColor: this._accentColor,
					createPreview: this._createPreview,
					drag: this._drag,
					onAdd: (item, size) => this._addWidget(item, size),
					onKeyPress: (button, event) => this._onCardKeyPress(button, event),
				});
				this._cards.push(card._focusButton);
				layout.attach(card, index % columns, Math.floor(index / columns), 1, 1);
			});
			for (let index = sectionStart; index < this._cards.length; index += columns) {
				this._rows.push(this._cards.slice(index, Math.min(index + columns, this._cards.length)));
			};
		};
	};

	_addWidget(record, size) {
		this._disarmReset();
		safeCall(() => this._onAdd(record.type, size));
		this._rebuildGrid();
	};

	_clearCards() {
		this._cards = [];
		this._rows = [];
		this._grid?.destroy_all_children();
	};

	_focusCard(index) {
		const card = this._cards[index];
		card.grab_key_focus();
		ensureVisible(this._scrollView, this._grid, card);
	};

	_onCardKeyPress(card, event) {
		const next = nextCardIndex(this._cards, this._rows, card, event.get_key_symbol());
		if (next === null) {
			return Clutter.EVENT_PROPAGATE;
		};
		if (next >= 0 && next < this._cards.length) {
			this._focusCard(next);
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
		return this._panelLauncher.create();
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
		if (!this._overlay || this._isOpen) return;

		this._animation.cancel();
		this._syncGeometry();
		this._disarmReset();
		this._updateEditButton();
		this._isOpen = true;
		this._rebuildGrid();
		this._overlay.visible = true;
		this._overlay.get_parent()?.set_child_above_sibling(this._overlay, null);
		this._drawer.opacity = 255;
		this._drawer.translation_y = this._drawer.height;
		this._animation.run({
			opacity: 255,
			translation_y: this._drawerRestY,
			duration: ANIMATION_TIME,
			mode: Clutter.AnimationMode.EASE_OUT_QUAD,
		}, () => this._searchEntry.grab_key_focus());
	};

	close(immediate = false) {
		if (!this._isOpen) return;

		this._isOpen = false;
		this._disarmReset();

		this._animation.cancel();
		const finish = () => {
			if (!this._isOpen) {
				this._overlay.hide();
				if (!this._drag.pending) {
					this._clearCards();
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

		this._animation.run({
			translation_y: this._drawer.height,
			duration: ANIMATION_TIME,
			mode: Clutter.AnimationMode.EASE_IN_QUAD,
		}, finish);
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
		this._animation?.destroy();
		this._animation = null;
		this._isOpen = false;
		this._drag?.destroy();
		this._drag = null;
		global.stage.disconnectObject(this._overlay);
		Main.layoutManager.disconnectObject(this._overlay);
		this._panelLauncher?.destroy();
		this._panelLauncher = null;
		this._launcher = null;
		this._clearCards();
		if (this._grid && !this._grid.get_parent()) {
			this._grid.destroy();
		};
		this._overlay.destroy();
		this._overlay = null;
		this._drawer = null;
		this._searchEntry = null;
		this._scrollView = null;
		this._grid = null;
		this._header = null;
		this._editButton = null;
		this._resetButton = null;
		this._catalog = [];
		this._onAdd = null;
		this._onDrop = null;
		this._onEditToggle = null;
		this._onReset = null;
		this._onSettings = null;
		this._getEditMode = null;
		this._createPreview = null;
	};
};
