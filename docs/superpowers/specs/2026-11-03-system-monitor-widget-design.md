# System Monitor Widget Design

## 1. Intent & The Why
Provide users with an at-a-glance resource usage monitor on the GNOME desktop without requiring external libraries or heavy background daemons. It fits into the existing GNOME Widgets design language and extension architecture.

## 2. Goals, Non-Goals, and Anti-Goals
- **Goals**:
  - Display CPU and RAM metrics cleanly on Small (220x220) and Medium (460x220) sizes.
  - Read resource data natively via `/proc` and `GLib` (zero external dependencies like `libgtop`).
  - Refresh periodically (default 5 seconds) only when active to preserve CPU and battery.
  - Consistent visual language with existing widgets (e.g., Battery rings, Screen Time bars).
- **Non-Goals**:
  - Full-blown task manager with per-process killing or process lists.
  - Heavy graph rendering with historical logs beyond the immediate session.
- **Anti-Goals**:
  - Calling shell commands (e.g. `top`, `free`, `df`) via subprocesses. Everything must be read via `GLib.file_get_contents` or `GLib.statvfs`.

## 3. Constraints
- Must run in GJS environment without extra package requirements.
- Must support GNOME Shell 45 through 51.
- Responsive to GNOME light/dark themes and accent colors.
- Cleanup any GLib timeouts when widgets are destroyed or extension is disabled.

## 4. Approaches Considered
- **Approach 1 (Selected)**: Adaptive representation by widget size in a single widget module.
  - **Small (220x220)**: Radial gauge rings (Pendekatan A) for CPU and RAM with percentage in center.
  - **Medium (460x220)**: Hybrid layout (Pendekatan C) — CPU & RAM radial rings on the left half, Disk & Memory textual/progress bars on the right half.
  - *Why selected*: Gives the best of both worlds directly in the widget gallery without cluttering the catalog with multiple duplicate widgets.
- **Approach 2 (Rejected)**: Multiple separate widgets in catalog ("System Rings" and "System Bars").
  - *Why rejected*: Causes catalog clutter and redundant code.
- **Approach 3 (Rejected)**: Preferences dropdown for style.
  - *Why rejected*: Users cannot preview the different looks in the widget gallery before placing them.

## 5. Technical Details & Architecture
### Data Sources:
- **CPU Usage**: Read `/proc/stat`. Calculate delta of `idle` vs `total` across refresh intervals:
  `total = user + nice + system + idle + iowait + irq + softirq + steal`
  `usage% = 100 * (delta_total - delta_idle) / delta_total`
- **RAM Usage**: Read `/proc/meminfo`.
  - `MemTotal`, `MemAvailable`
  - `used = MemTotal - MemAvailable`
  - `usage% = 100 * used / MemTotal`
- **Disk Usage**: Use `GLib.statvfs('/')`.
  - `total_bytes = f_blocks * f_frsize`
  - `free_bytes = f_bavail * f_frsize`
  - `used_bytes = total_bytes - free_bytes`
  - `usage% = 100 * used_bytes / total_bytes`

### Widget Component (`widgets/system/widget.js`):
- `export const type = 'system';`
- `export const label = 'System Monitor';`
- `export const supportedSizes = ['small', 'medium'];`
- `export const defaultSize = 'small';`
- `systemService`: Singleton managing 5-second `GLib.timeout_add_seconds` and subscriber callbacks.
- `SystemRing`: Cairo-based `St.DrawingArea` subclass drawing circular track and colored arc based on value.

### Catalog Registration (`desktop/catalog.js`):
- Category: `'Information'`
- Description: `'CPU, RAM, and Disk usage (updates every 5s)'`
- Icon: `'utilities-system-monitor-symbolic'`
- Keywords: `['system', 'cpu', 'ram', 'memory', 'disk']`
