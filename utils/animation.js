import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function ease(actor, properties) {
	return Promise.resolve(actor.ease(properties)).catch(error => {
		if (error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;

		console.error('Actor animation failed:', error);
	});
};
