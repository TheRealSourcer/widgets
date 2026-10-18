import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

const hasOrientation = 'orientation' in St.BoxLayout.prototype;
export const VERTICAL = hasOrientation
	? {orientation: Clutter.Orientation.VERTICAL}
	: {vertical: true};
export const HORIZONTAL = hasOrientation
	? {orientation: Clutter.Orientation.HORIZONTAL}
	: {vertical: false};

export function boxOrientation(vertical) {
	return vertical ? VERTICAL : HORIZONTAL;
};

export const CHILD_ADDED = GObject.signal_lookup('child-added', Clutter.Actor.$gtype)
	? 'child-added' : 'actor-added';

export function hasSetting(settings, key) {
	return settings?.settings_schema?.has_key(key) ?? false;
};

export function createBlurEffect({radius, ...params}) {
	// GNOME 45 uses sigma, while 46+ uses radius = 2 * sigma
	const size = 'radius' in Shell.BlurEffect.prototype ? {radius} : {sigma: Math.max(0, Math.round(radius / 2))};
	return new Shell.BlurEffect({...params, ...size});
};

const scrollViewIsBin = GObject.type_is_a(St.ScrollView.$gtype, St.Bin.$gtype);
export function setScrollViewChild(scrollView, child) {
	// In 45, St.Bin.set_child() bypasses St.ScrollView's Container add hook
	// that assigns scroll adjustments. The 46+ setter performs that setup
	if (scrollViewIsBin) {
		scrollView.add_actor(child);
	} else {
		scrollView.set_child(child);
	};
};

export function getMediaContainer(messageList) {
	return messageList?._messageView ?? messageList?._mediaSection?._list ?? null;
};

export function getMediaMessages(messageList) {
	// GNOME 48 replaced MediaSection with MessageView/MprisSource
	const messages = messageList?._messageView?._playerToMessage;
	return messages ? [...messages.values()] : messageList?._mediaSection?._messages ?? [];
};
