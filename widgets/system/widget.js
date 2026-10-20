import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { boxLayoutProps } from '../../utils/gnomeCompat.js';
import { widgetResourcePath } from '../../paths.js';

export const type = 'system';
export const label = 'System Monitor';
export const defaultSize = 'small';
export const supportedSizes = ['small', 'medium', 'large'];

const POLL_INTERVAL_MS = 5000;
const SWIPE_THRESHOLD = 50;
const SPARK_SAMPLES = 40;
const SPARK_LINE_WIDTH = 2;
const SPARK_FILL_ALPHA = 0.15;
const ANIMATION_DURATION = 250;

const ROW_SPACING = 10;
const CONTAINER_PAD = 3;
const MIN_TILE = 40;

const METRIC_CPU = 0;
const METRIC_RAM = 1;
const METRIC_GPU = 2;
const METRIC_NETWORK_DOWN = 3;
const METRIC_NETWORK_UP = 4;

const VIEW_CPU_RAM = 0;
const VIEW_GPU_RAM = 1;
const VIEW_NETWORK = 2;

/*
 * Header icons are bundled Lucide SVGs (lucide.dev — cpu, memory-stick,
 * gpu, arrow-down, arrow-up), kept in icons/widgets_settings/system/.
 * St renders FileIcons verbatim, so the muted tone is baked into the SVG
 * stroke on disk in a per-(icon, tone) cache file.
 */
const LUCIDE_ICONS = {
  cpu: 'cpu',
  ram: 'memory-stick',
  gpu: 'gpu',
  networkDown: 'arrow-down',
  networkUp: 'arrow-up',
};

function lucideIcon(theme, metricKey) {
  const name = LUCIDE_ICONS[metricKey];
  const color = String(theme?.muted ?? '#c0bfbc').trim();
  const file = widgetResourcePath('system', `${name}.svg`);

  if (!name || !file || !Gio.File.new_for_path(file).query_exists(null)) {
    return null;
  };

  const id = `${name}-${color.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const cachePath = GLib.build_filenamev([
    GLib.get_user_cache_dir(), 'desktop-widgets', 'system-icons', `${id}.svg`,
  ]);

  try {
    if (!Gio.File.new_for_path(cachePath).query_exists(null)) {
      const [ok, contents] = Gio.File.new_for_path(file).load_contents(null);

      if (ok) {
        const svg = new TextDecoder().decode(contents)
          .replace(/stroke="[^"]*"/g, `stroke="${color}"`);

        GLib.mkdir_with_parents(GLib.path_get_dirname(cachePath), 0o755);
        Gio.File.new_for_path(cachePath).replace_contents(svg, null, false, Gio.FileCreateFlags.NONE, null);
      };
    };

    return Gio.FileIcon.new(Gio.File.new_for_path(cachePath));
  } catch (_error) {
    // Fall back to the classic symbolic icon rather than nothing.
    return null;
  };
};

class SystemMonitor {
  constructor() {
    this.subscribers = [];
    this.timerId = null;
    this.lastData = {
      cpu: 0,
      ram: 0,
      gpu: 0,
      cpuTemp: 0,
      gpuTemp: 0,
      networkDown: 0,
      networkUp: 0,
      cpuSamples: [],
      ramSamples: [],
      gpuSamples: [],
      netDownSamples: [],
      netUpSamples: [],
    };
    this.prevCpuTotal = 0;
    this.prevCpuIdle = 0;
    this.prevRxBytes = 0;
    this.prevTxBytes = 0;
    this.prevTimeMs = 0;
    this.gpuPath = null;
    this.cpuTempPath = null;
    this.gpuTempPath = null;
    this.findGpuPath();
    this.findCpuTempPath();
    this.findGpuTempPath();
  }

  findGpuPath() {
    const cards = ['/sys/class/drm/card0/device/gpu_busy_percent',
                   '/sys/class/drm/card1/device/gpu_busy_percent'];
    for (const path of cards) {
      const file = Gio.File.new_for_path(path);
      if (file.query_exists(null)) {
        this.gpuPath = path;
        break;
      }
    }
  }

  findCpuTempPath() {
    const paths = [
      '/sys/class/hwmon/hwmon0/temp1_input',
      '/sys/class/hwmon/hwmon1/temp1_input',
      '/sys/class/hwmon/hwmon2/temp1_input',
      '/sys/class/thermal/thermal_zone0/temp',
      '/sys/class/thermal/thermal_zone1/temp',
    ];
    for (const path of paths) {
      const file = Gio.File.new_for_path(path);
      if (file.query_exists(null)) {
        this.cpuTempPath = path;
        break;
      }
    }
  }

  findGpuTempPath() {
    const paths = [
      '/sys/class/drm/card0/device/hwmon/hwmon0/temp1_input',
      '/sys/class/drm/card0/device/hwmon/hwmon1/temp1_input',
      '/sys/class/drm/card1/device/hwmon/hwmon0/temp1_input',
      '/sys/class/drm/card1/device/hwmon/hwmon1/temp1_input',
      '/sys/class/hwmon/hwmon3/temp1_input',
      '/sys/class/hwmon/hwmon4/temp1_input',
    ];
    for (const path of paths) {
      const file = Gio.File.new_for_path(path);
      if (file.query_exists(null)) {
        this.gpuTempPath = path;
        break;
      }
    }
  }

  async readFile(path) {
    try {
      const file = Gio.File.new_for_path(path);
      const [success, contents] = await new Promise((resolve, reject) => {
        file.load_contents_async(null, (f, res) => {
          try {
            resolve(f.load_contents_finish(res));
          } catch (e) {
            reject(e);
          }
        });
      });
      if (success) {
        const decoder = new TextDecoder('utf-8');
        return decoder.decode(contents);
      }
    } catch (e) {
      console.error(`Error reading ${path}:`, e);
    }
    return '';
  }

  async sampleCPU() {
    const text = await this.readFile('/proc/stat');
    const match = text.match(/^cpu\s+(.+)$/m);
    if (match) {
      const parts = match[1].trim().split(/\s+/).map(Number);
      const idle = parts[3] + parts[4];
      const total = parts.reduce((a, b) => a + b, 0);

      if (this.prevCpuTotal > 0) {
        const deltaTotal = total - this.prevCpuTotal;
        const deltaIdle = idle - this.prevCpuIdle;
        if (deltaTotal > 0) {
          return 1.0 - (deltaIdle / deltaTotal);
        }
      }
      this.prevCpuTotal = total;
      this.prevCpuIdle = idle;
    }
    return this.lastData.cpu;
  }

  async sampleRAM() {
    const text = await this.readFile('/proc/meminfo');
    const totalMatch = text.match(/MemTotal:\s+(\d+)/);
    const availMatch = text.match(/MemAvailable:\s+(\d+)/);
    if (totalMatch && availMatch) {
      const total = parseInt(totalMatch[1], 10);
      const avail = parseInt(availMatch[1], 10);
      if (total > 0) {
        return 1.0 - (avail / total);
      }
    }
    return this.lastData.ram;
  }

  async sampleGPU() {
    if (!this.gpuPath) return 0;
    const text = await this.readFile(this.gpuPath);
    const value = parseInt(text.trim(), 10);
    return isNaN(value) ? 0 : value / 100.0;
  }

  async sampleCpuTemp() {
    if (!this.cpuTempPath) return 0;
    const text = await this.readFile(this.cpuTempPath);
    const value = parseInt(text.trim(), 10);
    return isNaN(value) ? 0 : value / 1000.0;
  }

  async sampleGpuTemp() {
    if (!this.gpuTempPath) return 0;
    const text = await this.readFile(this.gpuTempPath);
    const value = parseInt(text.trim(), 10);
    return isNaN(value) ? 0 : value / 1000.0;
  }

  async sampleNetwork() {
    const text = await this.readFile('/proc/net/dev');
    const lines = text.split('\n');
    let totalRx = 0;
    let totalTx = 0;

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('lo:')) continue;
      const parts = line.split(':');
      if (parts.length >= 2) {
        const data = parts[1].trim().split(/\s+/);
        if (data.length >= 9) {
          totalRx += parseInt(data[0], 10) || 0;
          totalTx += parseInt(data[8], 10) || 0;
        }
      }
    }

    const nowMs = GLib.get_monotonic_time() / 1000;
    let down = 0;
    let up = 0;

    if (this.prevTimeMs > 0) {
      const deltaMs = nowMs - this.prevTimeMs;
      if (deltaMs > 0) {
        down = Math.max(0, ((totalRx - this.prevRxBytes) / deltaMs) * 1000);
        up = Math.max(0, ((totalTx - this.prevTxBytes) / deltaMs) * 1000);
      }
    }

    this.prevRxBytes = totalRx;
    this.prevTxBytes = totalTx;
    this.prevTimeMs = nowMs;

    return { down, up };
  }

  async poll() {
    const [cpu, ram, gpu, cpuTemp, gpuTemp, network] = await Promise.all([
      this.sampleCPU(),
      this.sampleRAM(),
      this.sampleGPU(),
      this.sampleCpuTemp(),
      this.sampleGpuTemp(),
      this.sampleNetwork(),
    ]);

    this.lastData.cpu = cpu;
    this.lastData.ram = ram;
    this.lastData.gpu = gpu;
    this.lastData.cpuTemp = cpuTemp;
    this.lastData.gpuTemp = gpuTemp;
    this.lastData.networkDown = network.down;
    this.lastData.networkUp = network.up;

    this.lastData.cpuSamples.push(cpu);
    if (this.lastData.cpuSamples.length > SPARK_SAMPLES) this.lastData.cpuSamples.shift();

    this.lastData.ramSamples.push(ram);
    if (this.lastData.ramSamples.length > SPARK_SAMPLES) this.lastData.ramSamples.shift();

    this.lastData.gpuSamples.push(gpu);
    if (this.lastData.gpuSamples.length > SPARK_SAMPLES) this.lastData.gpuSamples.shift();

    this.lastData.netDownSamples.push(network.down / 1024 / 1024);
    if (this.lastData.netDownSamples.length > SPARK_SAMPLES) this.lastData.netDownSamples.shift();

    this.lastData.netUpSamples.push(network.up / 1024 / 1024);
    if (this.lastData.netUpSamples.length > SPARK_SAMPLES) this.lastData.netUpSamples.shift();

    for (const cb of [...this.subscribers]) {
      try {
        cb(this.lastData);
      } catch (e) {
        console.error('Subscriber error:', e);
      }
    }
  }

  subscribe(callback) {
    this.subscribers.push(callback);

    if (this.lastData.cpu > 0 || this.lastData.ram > 0) {
      callback(this.lastData);
    }

    if (this.subscribers.length === 1) {
      this.poll();
      this.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
        this.poll();
        return GLib.SOURCE_CONTINUE;
      });
    }

    return () => this.unsubscribe(callback);
  }

  unsubscribe(callback) {
    this.subscribers = this.subscribers.filter(cb => cb !== callback);
    if (this.subscribers.length === 0 && this.timerId) {
      GLib.Source.remove(this.timerId);
      this.timerId = null;
      this.prevCpuTotal = 0;
      this.prevCpuIdle = 0;
      this.prevRxBytes = 0;
      this.prevTxBytes = 0;
      this.prevTimeMs = 0;
    }
  }

  // Fullscreen optimization: pause/resume polling
  pausePolling() {
    this.paused = true;
    if (this.timerId) {
      GLib.Source.remove(this.timerId);
      this.timerId = null;
    }
  }

  resumePolling() {
    this.paused = false;
    if (this.subscribers.length > 0 && !this.timerId) {
      this.poll();
      this.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
        if (!this.paused) {
          this.poll();
        }
        return GLib.SOURCE_CONTINUE;
      });
    }
  }
}

let monitor = null;

// Lazy singleton: the GObject instance is created on first use in render()
// (i.e. after enable()), not at module import time.
function getSystemMonitor() {
  if (monitor === null) {
    monitor = new SystemMonitor();
  }
  return monitor;
}

// Export monitor for the fullscreen pause optimization
export { monitor };

function formatBytes(bytes) {
  if (bytes === 0) return ['0.0', 'B/s'];
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return [(bytes / Math.pow(k, i)).toFixed(1), sizes[i]];
}

function hexToRgb(color) {
  const str = String(color ?? '').trim();
  const hex = str.replace('#', '');

  if (/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) {
    const expanded = hex.length === 3
      ? hex.split('').map(ch => ch + ch).join('')
      : hex;
    return {
      r: parseInt(expanded.slice(0, 2), 16) / 255,
      g: parseInt(expanded.slice(2, 4), 16) / 255,
      b: parseInt(expanded.slice(4, 6), 16) / 255,
    };
  }

  const match = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (match) {
    return {
      r: Number(match[1]) / 255,
      g: Number(match[2]) / 255,
      b: Number(match[3]) / 255,
    };
  }

  return { r: 0.2, g: 0.6, b: 0.9 };
}

function drawSparkline(ctx, width, height, samples, maxValue, color, lineAlpha) {
  ctx.setOperator(0); // CAIRO_OPERATOR_CLEAR
  ctx.paint();
  ctx.setOperator(2); // CAIRO_OPERATOR_OVER

  if (!samples || samples.length < 2 || width <= 0 || height <= 0) return;

  const rgb = hexToRgb(color);
  const span = Math.max(maxValue, 0.01);
  const stepX = width / (SPARK_SAMPLES - 1);
  const offsetX = width - ((samples.length - 1) * stepX);

  const pointAt = (index) => [
    offsetX + (index * stepX),
    height - 1 - ((samples[index] / span) * (height - 2)),
  ];

  ctx.newPath();
  for (let i = 0; i < samples.length; i++) {
    const [x, y] = pointAt(i);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.setSourceRGBA(rgb.r, rgb.g, rgb.b, lineAlpha);
  ctx.setLineWidth(SPARK_LINE_WIDTH);
  ctx.stroke();

  const [firstX, firstY] = pointAt(0);
  const [lastX] = pointAt(samples.length - 1);
  ctx.newPath();
  ctx.moveTo(firstX, firstY);
  for (let i = 1; i < samples.length; i++) {
    const [x, y] = pointAt(i);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(lastX, height);
  ctx.lineTo(firstX, height);
  ctx.closePath();
  ctx.setSourceRGBA(rgb.r, rgb.g, rgb.b, SPARK_FILL_ALPHA * lineAlpha);
  ctx.fill();
}

function createSparkTile(theme, label, value, unit, accentColor, samples, maxValue, extraInfo = null, metricKey = null) {
  const tile = new St.BoxLayout(boxLayoutProps({
    vertical: true,
    x_expand: false,
    y_expand: false,
    style: `
      background-color: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 6px;
      spacing: 4px;
    `,
  }));

  const headerRow = new St.BoxLayout(boxLayoutProps({
    x_expand: true,
    style: `spacing: 6px;`,
  }));

  const lucideGIcon = lucideIcon(theme, metricKey);

  const icon = lucideGIcon
    ? new St.Icon({
        gicon: lucideGIcon,
        icon_size: 14,
        y_align: Clutter.ActorAlign.CENTER,
      })
    : new St.Icon({
        icon_name: 'computer-symbolic',
        icon_size: 14,
        y_align: Clutter.ActorAlign.CENTER,
        style: `color: ${theme.muted};`,
      });

  const nameLabel = new St.Label({
    text: label,
    style: `
      color: ${theme.muted};
      font-size: 13px;
      font-weight: 400;
    `,
  });

  headerRow.add_child(icon);
  headerRow.add_child(nameLabel);

  const headerSpacer = new St.Widget({
    x_expand: true,
  });
  headerRow.add_child(headerSpacer);

  let extraLabel = null;
  const needsTemp = (label === 'CPU' || label === 'GPU');

  if (needsTemp || extraInfo) {
    extraLabel = new St.Label({
      text: extraInfo || '',
      visible: !!extraInfo,
      style: `
        color: ${theme.muted};
        font-size: 16px;
        font-weight: 500;
      `,
    });
    headerRow.add_child(extraLabel);
  }

  tile.add_child(headerRow);

  const valueRow = new St.BoxLayout(boxLayoutProps({
    x_align: Clutter.ActorAlign.START,
    style: `spacing: 0px;`,
  }));

  const valueLabel = new St.Label({
    text: value,
    style: `
      color: ${theme.text};
      font-size: 26px;
      font-weight: 600;
    `,
  });

  const unitLabel = new St.Label({
    text: unit,
    style: `
      color: ${theme.text};
      font-size: 26px;
      font-weight: 600;
    `,
  });

  valueRow.add_child(valueLabel);
  valueRow.add_child(unitLabel);

  const sparkArea = new St.DrawingArea({
    x_expand: true,
    y_expand: true,
  });

  sparkArea.connect('repaint', (area) => {
    const ctx = area.get_context();
    const [w, h] = area.get_surface_size();
    drawSparkline(ctx, w, h, samples, maxValue, accentColor, 1.0);
    ctx.$dispose();
  });

  tile.add_child(valueRow);
  tile.add_child(sparkArea);

  return { tile, valueLabel, unitLabel, sparkArea, extraLabel };
}

export function render({body, theme, widget, sizeForWidget}) {
  monitor = getSystemMonitor();
  const size = widget?.size || defaultSize;
  const [width, height] = sizeForWidget(widget);
  const accentColor = theme.accent || '#3584e4';

  let currentMetric = METRIC_CPU;
  let currentView = VIEW_CPU_RAM;
  let unsubscribe = null;
  const animatingActors = new Set();

  const container = new St.BoxLayout(boxLayoutProps({
    vertical: true,
    x_expand: true,
    y_expand: true,
    clip_to_allocation: true,
    style: `padding: 3px;`,
  }));

  // Explicitly size the tiles: one row of two tiles (medium) or two rows of
  // two tiles (large) get equal halves of the inner width. We read the real
  // allocation and force set_size / set_width so text length never changes
  // tile width (tiles are x_expand:false on purpose).
  let layoutMode = null; // 'medium' | 'large'
  let layoutRows = [];   // row actors whose tiles get sized by layoutTiles()
  let dashWrap = null;   // small (1x1) only: page-dash overlay over the pages

  const layoutTiles = () => {
    if (!layoutMode || layoutRows.length === 0) return;

    const box = container.get_allocation_box();
    const innerW = Math.floor(box.get_width()) - CONTAINER_PAD * 2;
    const innerH = Math.floor(box.get_height()) - CONTAINER_PAD * 2;
    if (innerW <= 0 || innerH <= 0) return;

    if (layoutMode === 'small') {
      const singleTile = layoutRows[0]?.get_children()?.[0];
      if (singleTile) {
        const cur = singleTile.get_allocation_box();
        if (cur.get_width() !== innerW) {
          singleTile.set_width(innerW);
        }
      }
      return;
    }

    if (layoutMode === 'medium') {
      const tileW = Math.max(MIN_TILE, Math.floor((innerW - ROW_SPACING) / 2));
      for (const row of layoutRows) {
        for (const child of row.get_children()) {
          const cur = child.get_allocation_box();
          if (cur.get_width() !== tileW) {
            child.set_width(tileW);
          }
        }
      }
    } else {
      const tileW = Math.max(MIN_TILE, Math.floor((innerW - ROW_SPACING) / 2));
      const rowH = Math.max(MIN_TILE, Math.floor((innerH - ROW_SPACING) / 2));
      for (const row of layoutRows) {
        const curRow = row.get_allocation_box();
        if (curRow.get_height() !== rowH) {
          row.set_height(rowH);
        }
        for (const child of row.get_children()) {
          const cur = child.get_allocation_box();
          if (cur.get_width() !== tileW) {
            child.set_width(tileW);
          }
        }
      }
    }
  };

  container.connect('notify::allocation', layoutTiles);

  if (size === 'small') {
    layoutMode = 'small';

    const metricConfigs = [
      { label: 'CPU', key: 'cpu', samplesKey: 'cpuSamples', maxValue: 1.0, unit: '%' },
      { label: 'RAM', key: 'ram', samplesKey: 'ramSamples', maxValue: 1.0, unit: '%' },
      { label: 'GPU', key: 'gpu', samplesKey: 'gpuSamples', maxValue: 1.0, unit: '%' },
      { label: _('Download'), key: 'networkDown', samplesKey: 'netDownSamples', maxValue: 10, unit: '' },
      { label: _('Upload'), key: 'networkUp', samplesKey: 'netUpSamples', maxValue: 10, unit: '' },
    ];

    let tile, valueLabel, unitLabel, sparkArea, extraLabel;
    let scrollBox;

    // Page dashes over the bottom edge, one per metric (5): the active
    // metric lights up in the accent color, the rest stay muted —
    // the same idea as the calendar 1x1 page dots.
    const dashRow = new St.BoxLayout(boxLayoutProps({
      x_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      // Flush against the bottom (the body clip cuts anything below), so
      // the dashes hug the pane edge like the calendar 1x1 page dots.
      style: `spacing: 5px; margin-bottom: 1px;`,
    }));
    const dashes = metricConfigs.map(() => new St.Widget({
      width: 10,
      height: 3,
      opacity: 72,
      reactive: false,
      style: `border-radius: 999px; background-color: ${theme.muted};`,
    }));
    dashes.forEach(dash => dashRow.add_child(dash));

    // y-expanding filler above the row pins it to the very bottom of the
    // overlay (BinLayout gives children the shared rect).
    dashWrap = new St.BoxLayout(boxLayoutProps({
      vertical: true,
      x_expand: true,
      y_expand: true,
    }));
    dashWrap.add_child(new St.Widget({y_expand: true, reactive: false}));
    dashWrap.add_child(dashRow);

    const refreshDashes = () => {
      dashes.forEach((dash, index) => {
        dash.style = `border-radius: 999px; background-color: ${index === currentMetric ? accentColor : theme.muted};`;
        dash.ease({
          opacity: index === currentMetric ? 255 : 72,
          duration: 120,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
      });
    };

    const rebuild = (enterX = 0) => {
      container.remove_all_children();
      
      scrollBox = new St.BoxLayout(boxLayoutProps({
        x_expand: true,
        y_expand: true,
      }));

      const config = metricConfigs[currentMetric];
      const samples = monitor.lastData[config.samplesKey] || [];
      
      let extraInfo = null;
      if (config.label === 'CPU' && monitor.lastData.cpuTemp > 0) {
        extraInfo = `${Math.round(monitor.lastData.cpuTemp)}°C`;
      } else if (config.label === 'GPU' && monitor.lastData.gpuTemp > 0) {
        extraInfo = `${Math.round(monitor.lastData.gpuTemp)}°C`;
      }
      
      const result = createSparkTile(theme, config.label, '0', config.unit, accentColor, samples, config.maxValue, extraInfo, config.key);
      tile = result.tile;
      valueLabel = result.valueLabel;
      unitLabel = result.unitLabel;
      sparkArea = result.sparkArea;
      extraLabel = result.extraLabel;
      
      scrollBox.add_child(tile);
      container.add_child(scrollBox);

      layoutRows = [scrollBox];
      layoutTiles();

      tile.translation_x = enterX;
      tile.set_opacity(0);
      tile.ease({
        translation_x: 0,
        opacity: 255,
        duration: ANIMATION_DURATION,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    };

    const onData = (data) => {
      const config = metricConfigs[currentMetric];
      
      if (config.key === 'networkDown' || config.key === 'networkUp') {
        const [val, unit] = formatBytes(data[config.key]);
        valueLabel.set_text(val);
        unitLabel.set_text(unit);
      } else {
        const val = Math.round(data[config.key] * 100);
        valueLabel.set_text(String(val));
        unitLabel.set_text('%');
      }
      
      if (extraLabel) {
        if (config.label === 'CPU' && data.cpuTemp > 0) {
          extraLabel.set_text(`${Math.round(data.cpuTemp)}°C`);
          extraLabel.show();
        } else if (config.label === 'GPU' && data.gpuTemp > 0) {
          extraLabel.set_text(`${Math.round(data.gpuTemp)}°C`);
          extraLabel.show();
        }
      }
      
      sparkArea.queue_repaint();
      
      // Reallocate tile widths after text updates (especially for network)
      layoutTiles();
    };

    let startX = 0;
    let dragging = false;

    container.reactive = true;
    container.connect('button-press-event', (actor, event) => {
      startX = event.get_coords()[0];
      dragging = true;
      return Clutter.EVENT_PROPAGATE;
    });

    container.connect('button-release-event', (actor, event) => {
      if (!dragging) return Clutter.EVENT_PROPAGATE;
      dragging = false;
      const endX = event.get_coords()[0];
      const delta = endX - startX;

      if (Math.abs(delta) > SWIPE_THRESHOLD) {
        const oldTile = tile;
        const exitX = delta < 0 ? -width : width;
        
        animatingActors.add(oldTile);
        oldTile.ease({
          opacity: 0,
          translation_x: exitX,
          duration: ANIMATION_DURATION,
          mode: Clutter.AnimationMode.EASE_IN_QUAD,
          onComplete: () => {
            animatingActors.delete(oldTile);
            if (oldTile.get_parent()) {
              oldTile.get_parent().remove_child(oldTile);
            }
          },
        });

        if (delta > 0) {
          currentMetric = (currentMetric - 1 + 5) % 5;
        } else {
          currentMetric = (currentMetric + 1) % 5;
        }
        refreshDashes();
        
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANIMATION_DURATION / 2, () => {
          rebuild(-exitX);
          if (monitor.lastData.cpu > 0 || monitor.lastData.ram > 0) {
            onData(monitor.lastData);
          }
          return GLib.SOURCE_REMOVE;
        });
      }
      return Clutter.EVENT_STOP;
    });

    rebuild();
    unsubscribe = monitor.subscribe(onData);
    refreshDashes();

  } else if (size === 'medium') {
    layoutMode = 'medium';

    const viewConfigs = [
      [
        { label: 'CPU', key: 'cpu', samplesKey: 'cpuSamples', maxValue: 1.0, unit: '%' },
        { label: 'RAM', key: 'ram', samplesKey: 'ramSamples', maxValue: 1.0, unit: '%' },
      ],
      [
        { label: 'GPU', key: 'gpu', samplesKey: 'gpuSamples', maxValue: 1.0, unit: '%' },
        { label: 'RAM', key: 'ram', samplesKey: 'ramSamples', maxValue: 1.0, unit: '%' },
      ],
      [
      { label: _('Download'), key: 'networkDown', samplesKey: 'netDownSamples', maxValue: 10, unit: '' },
      { label: _('Upload'), key: 'networkUp', samplesKey: 'netUpSamples', maxValue: 10, unit: '' },
      ],
    ];

    let tiles = [];
    let currentRow;

    const rebuild = (enterX = 0) => {
      container.remove_all_children();
      currentRow = new St.BoxLayout(boxLayoutProps({
        x_expand: true,
        y_expand: true,
        style: `spacing: 10px;`,
      }));

      const view = viewConfigs[currentView];
      tiles = [];

      for (const config of view) {
        const samples = monitor.lastData[config.samplesKey] || [];
        
        let extraInfo = null;
        if (config.label === 'CPU' && monitor.lastData.cpuTemp > 0) {
          extraInfo = `${Math.round(monitor.lastData.cpuTemp)}°C`;
        } else if (config.label === 'GPU' && monitor.lastData.gpuTemp > 0) {
          extraInfo = `${Math.round(monitor.lastData.gpuTemp)}°C`;
        }
        
        const result = createSparkTile(theme, config.label, '0', config.unit, accentColor, samples, config.maxValue, extraInfo, config.key);
        tiles.push(result);
        currentRow.add_child(result.tile);
        
        result.tile.translation_x = enterX;
        result.tile.set_opacity(0);
        result.tile.ease({
          translation_x: 0,
          opacity: 255,
          duration: ANIMATION_DURATION,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
      }

      container.add_child(currentRow);
      layoutRows = [currentRow];
      layoutTiles();
    };

    const onData = (data) => {
      const view = viewConfigs[currentView];
      
      for (let i = 0; i < tiles.length; i++) {
        const config = view[i];
        const tile = tiles[i];
        
        if (config.key === 'networkDown' || config.key === 'networkUp') {
          const [val, unit] = formatBytes(data[config.key]);
          tile.valueLabel.set_text(val);
          tile.unitLabel.set_text(unit);
        } else {
          const val = Math.round(data[config.key] * 100);
          tile.valueLabel.set_text(String(val));
          tile.unitLabel.set_text('%');
        }
        
        if (tile.extraLabel) {
          if (config.label === 'CPU' && data.cpuTemp > 0) {
            tile.extraLabel.set_text(`${Math.round(data.cpuTemp)}°C`);
            tile.extraLabel.show();
          } else if (config.label === 'GPU' && data.gpuTemp > 0) {
            tile.extraLabel.set_text(`${Math.round(data.gpuTemp)}°C`);
            tile.extraLabel.show();
          }
        }
        
        tile.sparkArea.queue_repaint();
      }
      
      // Reallocate tile widths after text updates (especially for network)
      layoutTiles();
    };

    let startX = 0;
    let dragging = false;

    container.reactive = true;
    container.connect('button-press-event', (actor, event) => {
      startX = event.get_coords()[0];
      dragging = true;
      return Clutter.EVENT_PROPAGATE;
    });

    container.connect('button-release-event', (actor, event) => {
      if (!dragging) return Clutter.EVENT_PROPAGATE;
      dragging = false;
      const endX = event.get_coords()[0];
      const delta = endX - startX;

      if (Math.abs(delta) > SWIPE_THRESHOLD) {
        const oldRow = currentRow;
        const exitX = delta < 0 ? -width : width;
        
        animatingActors.add(oldRow);
        oldRow.ease({
          opacity: 0,
          translation_x: exitX,
          duration: ANIMATION_DURATION,
          mode: Clutter.AnimationMode.EASE_IN_QUAD,
          onComplete: () => {
            animatingActors.delete(oldRow);
            if (oldRow.get_parent()) {
              oldRow.get_parent().remove_child(oldRow);
            }
          },
        });

        if (delta > 0) {
          currentView = (currentView - 1 + 3) % 3;
        } else {
          currentView = (currentView + 1) % 3;
        }
        
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANIMATION_DURATION / 2, () => {
          rebuild(-exitX);
          if (monitor.lastData.cpu > 0 || monitor.lastData.ram > 0) {
            onData(monitor.lastData);
          }
          return GLib.SOURCE_REMOVE;
        });
      }
      return Clutter.EVENT_STOP;
    });

    rebuild();
    unsubscribe = monitor.subscribe(onData);

  } else if (size === 'large') {
    layoutMode = 'large';

    const tilesGrid = new St.BoxLayout(boxLayoutProps({
      vertical: true,
      x_expand: true,
      y_expand: true,
      style: `spacing: 10px;`,
    }));

    const topRow = new St.BoxLayout(boxLayoutProps({
      x_expand: true,
      style: `spacing: 10px;`,
    }));

    const bottomRow = new St.BoxLayout(boxLayoutProps({
      x_expand: true,
      style: `spacing: 10px;`,
    }));

    const cpuExtraInfo = monitor.lastData.cpuTemp > 0 ? `${Math.round(monitor.lastData.cpuTemp)}°C` : null;
    const cpuTile = createSparkTile(theme, 'CPU', '0', '%', accentColor, monitor.lastData.cpuSamples, 1.0, cpuExtraInfo, 'cpu');
    const ramTile = createSparkTile(theme, 'RAM', '0', '%', accentColor, monitor.lastData.ramSamples, 1.0, null, 'ram');
    const downTile = createSparkTile(theme, 'Download', '0', 'KB/s', accentColor, monitor.lastData.netDownSamples, 10, null, 'networkDown');
    const upTile = createSparkTile(theme, 'Upload', '0', 'KB/s', accentColor, monitor.lastData.netUpSamples, 10, null, 'networkUp');

    topRow.add_child(cpuTile.tile);
    topRow.add_child(ramTile.tile);
    bottomRow.add_child(downTile.tile);
    bottomRow.add_child(upTile.tile);

    tilesGrid.add_child(topRow);
    tilesGrid.add_child(bottomRow);
    container.add_child(tilesGrid);
    layoutRows = [topRow, bottomRow];
    layoutTiles();

    const onData = (data) => {
      cpuTile.valueLabel.set_text(String(Math.round(data.cpu * 100)));
      ramTile.valueLabel.set_text(String(Math.round(data.ram * 100)));

      if (cpuTile.extraLabel && data.cpuTemp > 0) {
        cpuTile.extraLabel.set_text(`${Math.round(data.cpuTemp)}°C`);
        cpuTile.extraLabel.show();
      }

      const [dVal, dUnit] = formatBytes(data.networkDown);
      downTile.valueLabel.set_text(dVal);
      downTile.unitLabel.set_text(dUnit);

      const [uVal, uUnit] = formatBytes(data.networkUp);
      upTile.valueLabel.set_text(uVal);
      upTile.unitLabel.set_text(uUnit);

      cpuTile.sparkArea.queue_repaint();
      ramTile.sparkArea.queue_repaint();
      downTile.sparkArea.queue_repaint();
      upTile.sparkArea.queue_repaint();
    };

    unsubscribe = monitor.subscribe(onData);
  }

  // Small (1x1): BinLayout stacks the pages and the dash overlay in the
  // same rect — the dashes paint above and are not reactive, so the
  // container keeps the swipe handling untouched.
  if (dashWrap) {
    const pageStack = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      x_expand: true,
      y_expand: true,
    });
    pageStack.add_child(container);
    pageStack.add_child(dashWrap);
    body.add_child(pageStack);
  } else {
    body.add_child(container);
  }

  body.connect('destroy', () => {
    // Cancel all active ease animations to prevent ghost content
    for (const actor of animatingActors) {
      actor.remove_all_transitions();
    }
    animatingActors.clear();
    
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  });
}

export function style(theme) {
  return `
    background-color: ${theme.background};
    border: ${theme.borderWidth}px solid ${theme.border};
    border-radius: ${theme.radius}px;
  `;
}
