import {watchSettings} from '../../utils/widget.js';
import {createCard} from './card.js';
import {Controller} from './controller.js';
import {settingBoolean} from './helpers.js';
import {sessionBus, resetSessionBus} from './transport.js';
import {SystemMediaControls} from './systemMediaControls.js';

export {style} from './card.js';
export {SystemMediaControls};

export const type = 'music';
export const label = 'Media Player';
export const stylesheet = 'widgets/music/stylesheet.css';
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium', 'large'];

export let systemMediaControls = null;

export function initialize({settings}) {
	systemMediaControls = new SystemMediaControls(settings);
	systemMediaControls.enable();
};

export function cleanup() {
	systemMediaControls?.destroy();
	systemMediaControls = null;
	resetSessionBus();
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
