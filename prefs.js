import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const WIDGETS = ['clock', 'calendar', 'weather', 'photos', 'battery'];

export default class WidgetsPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    
    // ========== GENERAL PAGE ==========
    const generalPage = new Adw.PreferencesPage({
      title: _('General'),
      icon_name: 'preferences-system-symbolic',
    });
    window.add(generalPage);

    // Widget visibility group
    const widgetGroup = new Adw.PreferencesGroup({
      title: _('Widget Visibility'),
      description: _('Enable or disable individual widgets'),
    });
    generalPage.add(widgetGroup);

    // Add toggle for each widget
    const widgetLabels = {
      clock: _('Clock Widget'),
      calendar: _('Calendar Widget'),
      weather: _('Weather Widget'),
      photos: _('Photos Widget'),
      battery: _('Battery Widget'),
    };

    WIDGETS.forEach(widget => {
      const key = `enable-${widget}`;
      const row = new Adw.SwitchRow({
        title: widgetLabels[widget],
      });
      
      settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
      widgetGroup.add(row);
    });

    // Display options group
    const displayGroup = new Adw.PreferencesGroup({
      title: _('Display Options'),
      description: _('Customize widget appearance'),
    });
    generalPage.add(displayGroup);

    // Auto-hide toggle
    const autoHideRow = new Adw.SwitchRow({
      title: _('Auto Hide Widgets'),
      subtitle: _('Automatically hide widgets when not in focus'),
    });
    settings.bind('auto-hide', autoHideRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    displayGroup.add(autoHideRow);

    // Widget opacity slider
    const opacityRow = new Adw.SpinRow({
      title: _('Widget Opacity'),
      subtitle: _('Adjust transparency (0-100%)'),
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 100,
        step_increment: 5,
        page_increment: 10,
      }),
    });
    settings.bind('widget-opacity', opacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    displayGroup.add(opacityRow);

    // Info group
    const infoGroup = new Adw.PreferencesGroup({
      title: _('Information'),
    });
    generalPage.add(infoGroup);

    const infoRow = new Adw.ActionRow({
      title: _('Layout Management'),
      subtitle: _('Drag widgets on the desktop to reposition them'),
    });
    infoGroup.add(infoRow);

    const resetButton = new Gtk.Button({
      label: _('Reset Layout to Default'),
      css_classes: ['destructive-action'],
      halign: Gtk.Align.CENTER,
      margin_top: 12,
      margin_bottom: 12,
    });
    
    resetButton.connect('clicked', () => {
      settings.set_string('layout-json', '');
    });

    infoGroup.add(resetButton);

    // ========== PHOTOS PAGE ==========
    const photosPage = new Adw.PreferencesPage({
      title: _('Photos'),
      icon_name: 'image-x-generic-symbolic',
    });
    window.add(photosPage);

    const photosGroup = new Adw.PreferencesGroup({
      title: _('Photos Widget'),
      description: _('Configure where photos are fetched from'),
    });
    photosPage.add(photosGroup);

    // Photos source combo box
    const sourceStore = new Gtk.StringList();
    sourceStore.append(_('Camera Roll'));
    sourceStore.append(_('Screenshots'));
    sourceStore.append(_('Downloads'));

    const photosSourceRow = new Adw.ComboRow({
      title: _('Photo Source'),
      subtitle: _('Choose where to fetch photos'),
      model: sourceStore,
    });

    // Map display names to setting values
    const sourceMap = {
      0: 'camera',
      1: 'screenshots',
      2: 'downloads',
    };

    const reverseSourceMap = {
      'camera': 0,
      'screenshots': 1,
      'downloads': 2,
    };

    // Set initial value
    const currentSource = settings.get_string('photos-source');
    photosSourceRow.set_selected(reverseSourceMap[currentSource] ?? 0);

    // Connect to changes
    photosSourceRow.connect('notify::selected', () => {
      const selected = photosSourceRow.get_selected();
      settings.set_string('photos-source', sourceMap[selected]);
    });

    photosGroup.add(photosSourceRow);

    const photosInfoRow = new Adw.ActionRow({
      title: _('Photo Directories'),
      subtitle: _('Camera Roll: ~/Pictures/Camera\nScreenshots: ~/Pictures/Screenshots\nDownloads: ~/Downloads'),
    });
    photosGroup.add(photosInfoRow);

    // ========== WIDGET POSITIONING PAGE ==========
    const positionPage = new Adw.PreferencesPage({
      title: _('Positions'),
      icon_name: 'view-grid-symbolic',
    });
    window.add(positionPage);

    const positionGroup = new Adw.PreferencesGroup({
      title: _('Widget Positions'),
      description: _('Manage widget layout presets'),
    });
    positionPage.add(positionGroup);

    const currentLayoutRow = new Adw.ActionRow({
      title: _('Current Layout'),
      subtitle: _('Your widgets are positioned on the desktop'),
    });
    positionGroup.add(currentLayoutRow);

    const saveLayoutButton = new Gtk.Button({
      label: _('Save Current Layout as Preset'),
      css_classes: ['suggested-action'],
      halign: Gtk.Align.CENTER,
      margin_top: 12,
      margin_bottom: 6,
    });

    saveLayoutButton.connect('clicked', () => {
      const layoutJson = settings.get_string('layout-json');
      settings.set_string('widget-positions-json', layoutJson);
      
      // Show confirmation
      const dialog = new Adw.MessageDialog({
        transient_for: window,
        heading: _('Layout Saved'),
        body: _('Current layout has been saved as a preset'),
      });
      dialog.add_response('ok', _('OK'));
      dialog.present();
    });
    positionGroup.add(saveLayoutButton);

    const loadLayoutButton = new Gtk.Button({
      label: _('Load Saved Layout Preset'),
      halign: Gtk.Align.CENTER,
      margin_bottom: 12,
    });

    loadLayoutButton.connect('clicked', () => {
      const savedLayout = settings.get_string('widget-positions-json');
      
      if (!savedLayout) {
        const dialog = new Adw.MessageDialog({
          transient_for: window,
          heading: _('No Saved Layout'),
          body: _('Please save a layout first'),
        });
        dialog.add_response('ok', _('OK'));
        dialog.present();
        return;
      }

      settings.set_string('layout-json', savedLayout);
      
      const dialog = new Adw.MessageDialog({
        transient_for: window,
        heading: _('Layout Loaded'),
        body: _('Saved layout has been applied'),
      });
      dialog.add_response('ok', _('OK'));
      dialog.present();
    });
    positionGroup.add(loadLayoutButton);

    const positionInfoGroup = new Adw.PreferencesGroup({
      title: _('How to Reposition'),
    });
    positionPage.add(positionInfoGroup);

    const positionInfoRow = new Adw.ActionRow({
      title: _('Edit Mode'),
      subtitle: _('Enable Edit Widgets from the panel menu to drag widgets around. Disable to save your changes.'),
    });
    positionInfoGroup.add(positionInfoRow);
  }
}
