import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';

const CARD_WIDTH = 160;
const CARD_HEIGHT = 180;
const PREVIEW_WIDTH = 140;
const PREVIEW_HEIGHT = 100;
const COLUMNS = 2;
const DIALOG_WIDTH = 1100;
const DIALOG_HEIGHT = 650;

// Widget catalog without gettext (initialized later)
const WIDGET_CATALOG_DATA = [
	{
		type: 'clock',
		labelKey: 'Analog Clock',
		descKey: 'Classic round clock',
		icon: 'clock.svg',
		category: 'time',
	},
	{
		type: 'digitalclock',
		labelKey: 'Digital Clock',
		descKey: 'Modern time display',
		icon: 'digidal_clock.svg',
		category: 'time',
	},
	{
		type: 'binaryclock',
		labelKey: 'Binary Clock',
		descKey: 'Geek time display',
		icon: 'binary_clock.svg',
		category: 'time',
	},
	{
		type: 'calendar',
		labelKey: 'Calendar',
		descKey: 'Monthly calendar view',
		icon: 'calendar.svg',
		category: 'productivity',
	},
	{
		type: 'weather',
		labelKey: 'Weather',
		descKey: 'Current conditions',
		icon: 'weather.svg',
		category: 'info',
	},
	{
		type: 'music',
		labelKey: 'Music Player',
		descKey: 'Media controls',
		icon: 'music.svg',
		category: 'media',
	},
	{
		type: 'battery',
		labelKey: 'Battery',
		descKey: 'Power status',
		icon: 'battery.svg',
		category: 'system',
	},
	{
		type: 'system',
		labelKey: 'System Monitor',
		descKey: 'CPU, RAM, Disk',
		icon: 'system_monitor.svg',
		category: 'system',
	},
	{
		type: 'screentime',
		labelKey: 'Screen Time',
		descKey: 'Usage tracker',
		icon: 'sreen_time.svg',
		category: 'productivity',
	},
	{
		type: 'todo',
		labelKey: 'Todo List',
		descKey: 'Task manager',
		icon: 'task.svg',
		category: 'productivity',
	},
	{
		type: 'notes',
		labelKey: 'Notes',
		descKey: 'Quick notes',
		icon: 'notes.svg',
		category: 'productivity',
	},
	{
		type: 'github',
		labelKey: 'GitHub',
		descKey: 'Repository stats',
		icon: 'github.svg',
		category: 'info',
	},
	{
		type: 'photos',
		labelKey: 'Photos',
		descKey: 'Image viewer',
		icon: 'photo.svg',
		category: 'media',
	},
	{
		type: 'applauncher',
		labelKey: 'App Launcher',
		descKey: 'Quick app access',
		icon: 'app_launcher.svg',
		category: 'productivity',
	},
	{
		type: 'folder',
		labelKey: 'Folder Launcher',
		descKey: 'Quick folder access',
		icon: 'folder.svg',
		category: 'productivity',
	},
	{
		type: 'pomodoro',
		labelKey: 'Pomodoro',
		descKey: 'Time management timer',
		icon: 'pomodoro.svg',
		category: 'productivity',
	},
	{
		type: 'stopwatch',
		labelKey: 'Stopwatch',
		descKey: 'Timer with lap tracking',
		icon: 'stopwatch.svg',
		category: 'time',
	},
	{
		type: 'timer',
		labelKey: 'Timer',
		descKey: 'Countdown timer',
		icon: 'timer.svg',
		category: 'time',
	},
	{
		type: 'lava',
		labelKey: 'Lava Lamp',
		descKey: 'Animated metaballs',
		icon: 'lavat.svg',
		category: 'media',
	},
];

const CATEGORY_KEYS = {
	time: 'Time',
	productivity: 'Productivity',
	info: 'Information',
	media: 'Media',
	system: 'System',
};

export const WidgetPickerDialog = GObject.registerClass({
	Signals: {
		'widget-selected': { param_types: [GObject.TYPE_STRING] },
	},
}, class WidgetPickerDialog extends Gtk.Window {
	_init(parent, extensionPath, gettextFn) {
		super._init({
			transient_for: parent,
			modal: true,
			default_width: DIALOG_WIDTH,
			default_height: DIALOG_HEIGHT,
			decorated: false,
		});

		this._extensionPath = extensionPath;
		this._ = gettextFn;

		// Load the CSS
		this._loadCSS();

		this._buildUI();
	}

	_loadCSS() {
		const cssPath = `${this._extensionPath}/prefs/widgetPickerDialog.css`;
		const cssFile = Gio.File.new_for_path(cssPath);

		if (cssFile.query_exists(null)) {
			const cssProvider = new Gtk.CssProvider();
			cssProvider.load_from_file(cssFile);

			Gtk.StyleContext.add_provider_for_display(
				Gdk.Display.get_default(),
				cssProvider,
				Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
			);
		}
	}

	_buildUI() {
		const _ = this._;

		// Root container
		const mainBox = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 0,
		});
		this.set_child(mainBox);

		// Header, no search
		const headerBar = new Gtk.HeaderBar();
		headerBar.set_show_title_buttons(true);
		headerBar.set_title_widget(new Gtk.Label({
			label: _('Select Widget'),
			css_classes: ['title'],
		}));

		mainBox.append(headerBar);

		// Scrollable area
		const scrolled = new Gtk.ScrolledWindow({
			vexpand: true,
			hexpand: true,
			hscrollbar_policy: Gtk.PolicyType.NEVER,
			vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
		});
		mainBox.append(scrolled);

		// Category container
		const contentBox = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 24,
			margin_top: 24,
			margin_bottom: 24,
			margin_start: 24,
			margin_end: 24,
		});
		scrolled.set_child(contentBox);

		// Group widgets by category
		const categorized = {};

		for (const widgetData of WIDGET_CATALOG_DATA) {
			if (!categorized[widgetData.category]) {
				categorized[widgetData.category] = [];
			}
			const widget = {
				type: widgetData.type,
				label: _(widgetData.labelKey),
				description: _(widgetData.descKey),
				icon: widgetData.icon,
				category: widgetData.category,
			};
			categorized[widgetData.category].push(widget);
		}

		// Add the categories
		for (const [categoryKey, widgets] of Object.entries(categorized)) {
			const categoryName = _(CATEGORY_KEYS[categoryKey] || categoryKey);
			const categoryBox = this._buildCategory(categoryName, widgets);
			contentBox.append(categoryBox);
		}
	}

	_buildCategory(categoryName, widgets) {
		const categoryBox = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 12,
		});

		// Category name
		const categoryLabel = new Gtk.Label({
			label: categoryName,
			xalign: 0,
			css_classes: ['title-3'],
			margin_bottom: 8,
		});
		categoryBox.append(categoryLabel);

		// Card grid: Gtk.Grid, not Gtk.FlowBox.
		//
		// Why not FlowBox: with homogeneous:true it sizes every card by the widest
		// card in the category — set not by width_request but by the intrinsic
		// size of the texture in Gtk.Picture. SVGs in icons/widgets
		// can be as large as 480x270. Productivity contains
		// app_launcher.svg (480px), so FlowBox decided only one card fits per
		// row and stretched it full width. Grid ignores texture size:
		// a position is simply index % COLUMNS.
		const grid = new Gtk.Grid({
			column_spacing: 12,
			row_spacing: 12,
			hexpand: true,
			halign: Gtk.Align.FILL,
			column_homogeneous: true,
			row_homogeneous: true,
		});

		// One SizeGroup per column: cards in it share the width, so a row looks
		// even when a single card is left in the last row
		// (5 widgets in 2 columns -> 2+2+1).
		const columnGroups = [];
		for (let i = 0; i < COLUMNS; i++) {
			columnGroups.push(new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.HORIZONTAL }));
		}

		widgets.forEach((widget, index) => {
			const column = index % COLUMNS;
			const row = Math.floor(index / COLUMNS);
			const card = this._buildWidgetCard(widget);
			card.hexpand = true;
			columnGroups[column].add_widget(card);
			grid.attach(card, column, row, 1, 1);
		});

		categoryBox.append(grid);
		return categoryBox;
	}

	_buildWidgetCard(widgetMeta) {
		// The card is a container, not a button — a clickable area on top
		// (preview + text) with a separate "Add" button at the bottom.
		const card = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			css_classes: ['card', 'widget-picker-card'],
			width_request: CARD_WIDTH,
			height_request: CARD_HEIGHT,
			margin_top: 12,
			margin_bottom: 12,
			margin_start: 10,
			margin_end: 10,
			spacing: 8,
		});

		// Clickable area on top (preview, name, description)
		const previewButton = new Gtk.Button({
			css_classes: ['flat'],
		});
		const cardBox = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 8,
		});
		previewButton.set_child(cardBox);

		// Widget icon
		const iconPath = `${this._extensionPath}/icons/widgets/${widgetMeta.icon}`;
		const iconFile = Gio.File.new_for_path(iconPath);

		let iconWidget;
		if (iconFile.query_exists(null)) {
			// Scale at load time instead of handing over the original
			// texture: SVGs in icons/widgets have intrinsic sizes up to
			// 480x270, and a Gtk.Picture holding such a texture makes the card
			// "wider than configured": width_request sets only the MINIMUM, while
			// the natural width stays 480px. As a result the FlowBox card
			// looked much wider than configured, and in Grid it pushed neighboring
			// columns apart. new_from_file_at_scale keeps the aspect ratio (true) and
			// returns a texture exactly the size of the preview.
			let paintable = null;
			try {
				const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
					iconPath, PREVIEW_WIDTH, PREVIEW_HEIGHT, true);
				paintable = Gdk.Texture.new_for_pixbuf(pixbuf);
			} catch (e) {
				// librsvg unavailable — fall back to the original; Gtk.Picture
				// renders it via content_fit CONTAIN.
				paintable = Gdk.Texture.new_from_file(iconFile);
			}

			iconWidget = new Gtk.Picture({
				paintable,
				width_request: PREVIEW_WIDTH,
				height_request: PREVIEW_HEIGHT,
				can_shrink: true,
				content_fit: Gtk.ContentFit.CONTAIN,
			});
		} else {
			// Fallback to a symbolic icon
			iconWidget = new Gtk.Image({
				icon_name: 'application-x-addon-symbolic',
				pixel_size: 48,
			});
		}

		const iconBox = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			valign: Gtk.Align.START,
		});
		iconBox.append(iconWidget);
		cardBox.append(iconBox);

		// Widget name
		const label = new Gtk.Label({
			label: widgetMeta.label,
			xalign: 0.5,
			wrap: true,
			wrap_mode: Pango.WrapMode.WORD_CHAR,
			max_width_chars: 16,
			css_classes: ['title-4'],
		});
		cardBox.append(label);

		// Description
		const desc = new Gtk.Label({
			label: widgetMeta.description,
			xalign: 0.5,
			wrap: true,
			wrap_mode: Pango.WrapMode.WORD_CHAR,
			max_width_chars: 18,
			css_classes: ['dim-label', 'caption'],
		});
		cardBox.append(desc);

		card.append(previewButton);

		// The "Add" button at the bottom
		const addButton = new Gtk.Button({
			label: this._('Add'),
			css_classes: ['suggested-action'],
			halign: Gtk.Align.CENTER,
		});

		card.append(addButton);

		// Click handling: both the preview and "Add" emit a signal but DO NOT close the dialog
		const onSelect = () => {
			this.emit('widget-selected', widgetMeta.type);
		};
		previewButton.connect('clicked', onSelect);
		addButton.connect('clicked', onSelect);

		return card;
	}
});

// Entry point to open the dialog
export function openWidgetPicker(parent, extensionPath, gettextFn, onWidgetSelected) {
	const dialog = new WidgetPickerDialog(parent, extensionPath, gettextFn);

	dialog.connect('widget-selected', (_dialog, widgetType) => {
		if (onWidgetSelected) {
			onWidgetSelected(widgetType);
		}
	});

	dialog.present();
}
