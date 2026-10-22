import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {VERTICAL} from '../compatibility.js';
import {setButtonStyle} from '../utils/buttonStyle.js';

export const CARD_WIDTH = 430;

export function createCard(record, options) {
	const card = new St.BoxLayout({
		...VERTICAL,
		width: CARD_WIDTH,
		x_align: Clutter.ActorAlign.CENTER,
		style_class: 'widget-gallery-preview-item',
	});

	try {
		const content = new St.BoxLayout({
			...VERTICAL,
			width: CARD_WIDTH,
			x_align: Clutter.ActorAlign.CENTER,
			y_expand: true,
			style_class: 'widget-gallery-preview-content',
		});
		card.add_child(content);

		const preview = new St.Widget({
			layout_manager: new Clutter.FixedLayout(),
			width: CARD_WIDTH,
			height: options.previewHeight,
			x_align: Clutter.ActorAlign.CENTER,
			reactive: true,
			track_hover: true,
			style_class: 'widget-gallery-card-preview',
			clip_to_allocation: true,
		});
		content.add_child(preview);
		let selectedSize = record.defaultSize;
		const renderPreview = size => {
			selectedSize = size;
			preview.destroy_all_children();
			const rendered = options.createPreview(record.type, size, CARD_WIDTH, options.previewHeight);
			if (rendered) {
				preview.add_child(rendered);
			};
		};
		renderPreview(selectedSize);
		preview.connectObject('button-press-event', (_actor, event) =>
			options.drag.begin(preview, record, event, selectedSize), preview);
		preview.connectObject('button-release-event', (_actor, event) => {
			if (event.get_button() === 1 && !options.drag.suppressClick) {
				options.onAdd(record, selectedSize);
			};
			return Clutter.EVENT_STOP;
		}, preview);

		const titleRow = new St.BoxLayout({
			width: CARD_WIDTH,
			x_align: Clutter.ActorAlign.CENTER,
		});
		content.add_child(titleRow);
		titleRow.add_child(new St.Widget({x_expand: true}));
		titleRow.add_child(new St.Label({
			text: record.label,
			style_class: 'widget-gallery-preview-title',
		}));
		titleRow.add_child(new St.Widget({x_expand: true}));

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
		card.add_child(chips);
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
				chips.add_child(chipRow);
				chipRow.add_child(new St.Widget({x_expand: true}));
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
			chipRow.add_child(chip);
			setButtonStyle(chip, '');
			chip.connectObject('clicked', () => {
				if (!options.drag.suppressClick) {
					renderPreview(sizeRecord.size);
					for (const [key, button] of chipButtons) {
						if (key === sizeRecord.size) {
							button.add_style_class_name('widget-gallery-size-chip-selected');
						} else {
							button.remove_style_class_name('widget-gallery-size-chip-selected');
						};
						setButtonStyle(button, key === sizeRecord.size
							? `background-color: ${options.accentColor};`
							: '');
					};
				};
			}, chip);
			chip.connectObject('button-press-event', (_actor, event) =>
				options.drag.begin(chip, record, event, sizeRecord.size), chip);
			chipButtons.push([sizeRecord.size, chip]);

			if (!card._focusButton) {
				card._focusButton = chip;
				chip.connectObject('key-press-event', (_actor, event) =>
					options.onKeyPress(chip, event), chip);
			};
		};
		if (chipRow) {
			chipRow.add_child(new St.Widget({x_expand: true}));
		};
		for (const [key, button] of chipButtons) {
			if (key === selectedSize) {
				button.add_style_class_name('widget-gallery-size-chip-selected');
				setButtonStyle(button, `background-color: ${options.accentColor};`);
			};
		};
		return card;
	} catch (error) {
		card.destroy();
		throw error;
	};
};
