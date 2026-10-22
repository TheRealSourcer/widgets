// Pure key policy for the task editor's Clutter.Text — no GI dependencies so
// tests/run-test.js can exercise it with plain node.
// Returns one of: 'commit', 'newline', 'cancel', 'propagate'.
export function editorKeyAction(keySymbol, shiftPressed, keys) {
	const k = keys ?? {};
	if (keySymbol === k.enter || keySymbol === k.kpEnter) {
		return shiftPressed ? 'newline' : 'commit';
	}
	if (keySymbol === k.escape) {
		return 'cancel';
	}
	return 'propagate';
}
