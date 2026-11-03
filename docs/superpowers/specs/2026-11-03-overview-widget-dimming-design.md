# Overview Widget Dimming Design

## 1. Intent & The Why
When entering GNOME Shell Overview, desktop widgets clones rendered on workspace previews currently display at full opacity (100%). Because widget surfaces resemble application cards, users find it visually distracting and confusing to distinguish open application windows from passive desktop widgets.

Dimming the widget clones in Overview (~50% opacity) pushes widgets visually into the background, providing clear visual hierarchy and distinct z-index separation so active windows stand out.

## 2. Approach Selected (Option 1)
- Set opacity on overview preview clones (`Clutter.Clone` in `workspaceIntegration.js`).
- Constant: `const OVERVIEW_CLONE_OPACITY = 120;` (~47% opacity, 0-255 scale).
- Respect source layer opacity: `clone.opacity = Math.round((this._source.opacity / 255) * OVERVIEW_CLONE_OPACITY);`.
- Zero overhead, native Clutter property without shader or performance penalty.

## 3. Files Touched
- `workspaceIntegration.js`: set opacity in `_addOverviewClone` and update during `_syncOverviewPreviews`.
- Unit test in `tests/workspaceIntegration.test.js` to verify opacity configuration.
