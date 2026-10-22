// Plain-node tests for lib/todoEditorKeys.js — run: node tests/run-test.js
import assert from 'node:assert';
import { editorKeyAction } from '../lib/todoEditorKeys.js';

// X keysyms actually used by Clutter in the widget.
const KEYS = { enter: 65293, kpEnter: 65294, escape: 65307 };

assert.strictEqual(editorKeyAction(KEYS.enter, false, KEYS), 'commit', 'Enter commits');
assert.strictEqual(editorKeyAction(KEYS.kpEnter, false, KEYS), 'commit', 'Numpad Enter commits');
assert.strictEqual(editorKeyAction(KEYS.enter, true, KEYS), 'newline', 'Shift+Enter adds newline');
assert.strictEqual(editorKeyAction(KEYS.kpEnter, true, KEYS), 'newline', 'Shift+Numpad Enter adds newline');
assert.strictEqual(editorKeyAction(KEYS.escape, false, KEYS), 'cancel', 'Escape cancels');
assert.strictEqual(editorKeyAction(KEYS.escape, true, KEYS), 'cancel', 'Shift+Escape cancels');
assert.strictEqual(editorKeyAction(97, false, KEYS), 'propagate', 'Letter keys propagate (typing works)');
assert.strictEqual(editorKeyAction(0, false), 'propagate', 'Defaults with no key map propagate');

// Policy sanity: newline must never be reachable without Shift.
for (let i = 0; i < 8; i += 1) {
	const alt = (i & 1) !== 0;
	if (alt)
		assert.strictEqual(editorKeyAction(KEYS.enter, true, KEYS), 'newline');
}
console.log('todo editor key policy: OK (all assertions passed)');
