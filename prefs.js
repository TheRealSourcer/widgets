ort Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const WIDGETS = ['clock', 'calendar', 'weather', 'photos', 'battery'];

export default class WidgetsPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    
    // Create main page
    const page = new Adw.PreferencesPage({
      title: _('Widgets Settings'),
      icon_name: 'preferences-system-symbolic',
    });
    window.add(page);

    // Create widget visibility group
    const widgetGroup = new Adw.PreferencesGroup({
      title: _('Widget Visibility'),
      description: _('Enable or disable individual widgets'),
    });
    page.add(widgetGroup);

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
      
      // Bind setting to switch
      settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
      widgetGroup.add(row);
    });

    // Create display options group
    const displayGroup = new Adw.PreferencesGroup({
      title: _('Display Options'),
      description: _('Customize widget appearance'),
    });
    page.add(displayGroup);

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

    // Create info group
    const infoGroup = new Adw.PreferencesGroup({
      title: _('Information'),
    });
    page.add(infoGroup);

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
  }
}
