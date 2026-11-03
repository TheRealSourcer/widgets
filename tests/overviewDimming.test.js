import assert from 'node:assert';
import fs from 'node:fs';
import { test } from 'node:test';

test('workspaceIntegration defines OVERVIEW_CLONE_OPACITY constant', () => {
	const code = fs.readFileSync('workspaceIntegration.js', 'utf8');
	assert.match(code, /const OVERVIEW_CLONE_OPACITY\s*=\s*120;/);
});

test('workspaceIntegration applies dimmed opacity to overview clones', () => {
	const code = fs.readFileSync('workspaceIntegration.js', 'utf8');
	assert.match(code, /clone\.opacity\s*=\s*Math\.round\(\(this\._source\.opacity\s*\/\s*255\)\s*\*\s*OVERVIEW_CLONE_OPACITY\);/);
});
