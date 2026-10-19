// Layout document contract: its version and the single write path.
// Imported by both the extension and the prefs window so both sides
// write the same version.

const LAYOUT_KEY = 'layout-json';
const LAYOUT_VERSION = 3;

// The only place a version is written into the document, so a document
// without a version can never be produced on either side.
function layoutJson(widgets) {
  return JSON.stringify({version: LAYOUT_VERSION, widgets});
};

// An empty string means "no layout set": the extension shows an empty
// desktop. That is not a document, so no version is needed here.
function clearLayout(settings) {
  settings.set_string(LAYOUT_KEY, '');
};

function writeLayout(settings, widgets) {
  settings.set_string(LAYOUT_KEY, layoutJson(widgets));
};

export { LAYOUT_KEY, LAYOUT_VERSION, clearLayout, layoutJson, writeLayout };
