import {ease} from '../utils/animation.js';

export class DrawerAnimation {
	constructor(actor, owner) {
		this._actor = actor;
		this._owner = owner;
		this._transition = null;
	};

	run(properties, onComplete) {
		this.cancel();
		ease(this._actor, properties);
		this._transition = this._actor.get_transition('translation-y');
		if (!this._transition) {
			onComplete();
			return;
		};
		this._transition.connectObject('stopped', (_transition, finished) => {
			this._transition.disconnectObject(this._owner);
			this._transition = null;
			if (finished) {
				onComplete();
			};
		}, this._owner);
	};

	cancel() {
		this._transition?.disconnectObject(this._owner);
		this._transition = null;
		this._actor.remove_all_transitions();
	};

	destroy() {
		this.cancel();
		this._actor = null;
		this._owner = null;
	};
};
