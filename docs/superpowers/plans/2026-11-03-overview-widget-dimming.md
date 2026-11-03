# Overview Widget Dimming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dim desktop widgets preview in GNOME Shell Overview to establish visual hierarchy and prevent visual confusion with active application windows.

**Architecture:** Set `clone.opacity` to a dimmed factor (`OVERVIEW_CLONE_OPACITY = 120`, ~47%) when creating or syncing overview clones in `workspaceIntegration.js`.

**Tech Stack:** GNOME Shell (GJS), Clutter.

**Spec:** `docs/superpowers/specs/2026-11-03-overview-widget-dimming-design.md`

## Global Constraints
- Zero external package dependencies.
- Retain existing workspace switching animations at full fidelity.
- Clean and minimal diff.

## Review Focus
- Ensure thumbnail previews (dock/dash previews) and full workspace previews both apply the dimmed opacity consistently.
- Source layer opacity scaling: if source layer has opacity < 255, scale proportionally.

---

### Task 1: Overview Clone Dimming (`workspaceIntegration.js`)

**Files:**
- Modify: `workspaceIntegration.js`
- Test: `tests/overviewDimming.test.js`

**Interfaces:**
- Produces: `OVERVIEW_CLONE_OPACITY = 120` applied to `clone.opacity` in `_addOverviewClone` and `_syncOverviewPreviews`.

- [x] **Step 1: Write failing test in `tests/overviewDimming.test.js`**
- [x] **Step 2: Run test to verify it fails**
- [x] **Step 3: Implement `OVERVIEW_CLONE_OPACITY` in `workspaceIntegration.js`**
- [x] **Step 4: Run test to verify it passes**
- [x] **Step 5: Verify with `node --check`**
- [x] **Step 6: Commit changes**
