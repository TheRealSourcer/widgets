import Clutter from 'gi://Clutter';
import St from 'gi://St';

// St.BoxLayout gained `orientation` in GNOME 48 and deprecated `vertical`.
export const VERTICAL = 'orientation' in St.BoxLayout.prototype
  ? {orientation: Clutter.Orientation.VERTICAL}
  : {vertical: true};
