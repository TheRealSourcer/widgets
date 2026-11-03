# System Monitor Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native GNOME Shell desktop widget that displays CPU, RAM, and Disk usage with adaptive layouts for Small and Medium sizes.

**Architecture:** A standalone resource reader parses `/proc/stat` and `/proc/meminfo` and queries `GLib.statvfs('/')`. A centralized singleton service polls every 5 seconds when widgets are active and cleans up timers on unsubscribe. A Cairo-based `St.DrawingArea` renders radial gauge rings for Small size, and a hybrid layout renders rings alongside progress bars and details for Medium size.

**Tech Stack:** GNOME Shell (GJS), Clutter, St, Cairo, GLib, Linux `/proc` filesystem.

**Spec:** `docs/superpowers/specs/2026-11-03-system-monitor-widget-design.md`

## Global Constraints
- Zero external package dependencies (no `libgtop` or CLI subprocesses).
- Support GNOME Shell 45 through 51.
- Respect theme colors (light/dark and accent).
- Clean up all GLib timeout sources upon destruction.

## Review Focus
- High CPU delta / divide-by-zero protection on first read or instant ticks.
- Graceful fallback when `/proc` files or filesystem stats are temporarily unreadable.
- Exact styling consistency with existing widgets (`Battery`, `Screen Time`).
- Memory leak prevention: ensure timeout source is removed when all widgets unmount.

---

### Task 1: System Resource Reader (`widgets/system/systemReader.js`)

**Files:**
- Create: `widgets/system/systemReader.js`
- Test: `tests/systemReader.test.js`

**Interfaces:**
- Produces:
  - `parseCpuStat(content: string, prevTotal: number, prevIdle: number): { usage: number, total: number, idle: number }`
  - `parseMemInfo(content: string): { totalBytes: number, availableBytes: number, usage: number }`
  - `readDiskUsage(path: string): { totalBytes: number, usedBytes: number, usage: number }`
  - `readSystemMetrics(prevState): Promise<SystemMetrics>`

- [ ] **Step 1: Write test for CPU and RAM parsing**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `widgets/system/systemReader.js`**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit reader module**

---

### Task 2: System Monitor UI & Service (`widgets/system/widget.js`, `widgets/system/stylesheet.css`)

**Files:**
- Create: `widgets/system/stylesheet.css`
- Create: `widgets/system/widget.js`

**Interfaces:**
- Consumes: `readSystemMetrics` from `widgets/system/systemReader.js`
- Produces: Standard widget interface (`type = 'system'`, `label = 'System Monitor'`, `stylesheet`, `defaultSize = 'small'`, `supportedSizes = ['small', 'medium']`, `style`, `render`, `cleanup`)

- [ ] **Step 1: Create `widgets/system/stylesheet.css`**
- [ ] **Step 2: Implement `widgets/system/widget.js` with `SystemRing` and layout components**
- [ ] **Step 3: Verify syntax with `node --check`**
- [ ] **Step 4: Commit widget component**

---

### Task 3: Catalog Registration & Integration (`desktop/catalog.js`)

**Files:**
- Modify: `desktop/catalog.js`

**Interfaces:**
- Consumes: `SystemWidget` from `widgets/system/widget.js`
- Produces: `system` entry in `WIDGET_MODULES` and `widgetCatalog()`

- [ ] **Step 1: Import `SystemWidget` and add to `WIDGET_MODULES` and `widgetCatalog()`**
- [ ] **Step 2: Verify syntax and catalog integrity test**
- [ ] **Step 3: Commit catalog integration**

---

### Task 4: Full Branch Verification

- [ ] **Step 1: Run comprehensive syntax and lint verification across the repo**
- [ ] **Step 2: Verify git status and diff cleanliness**
