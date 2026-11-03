import assert from 'node:assert';
import { test } from 'node:test';
import { parseCpuStat, parseMemInfo, formatBytes } from '../widgets/system/systemReader.js';

test('parseCpuStat calculates usage percentage from /proc/stat lines', () => {
	// First tick (no prev):
	// cpu  user nice system idle iowait irq softirq steal guest guest_nice
	const line1 = 'cpu  100 0 50 850 0 0 0 0 0 0\n';
	// total = 100 + 0 + 50 + 850 = 1000, idle = 850
	const first = parseCpuStat(line1, 0, 0);
	assert.strictEqual(first.total, 1000);
	assert.strictEqual(first.idle, 850);
	assert.strictEqual(first.usage, 0); // baseline has no delta

	// Second tick:
	// user increased by 100, system by 50, idle by 50. delta_total = 200, delta_idle = 50.
	// usage = 100 * (200 - 50) / 200 = 75%
	const line2 = 'cpu  200 0 100 900 0 0 0 0 0 0\n';
	const second = parseCpuStat(line2, first.total, first.idle);
	assert.strictEqual(second.total, 1200);
	assert.strictEqual(second.idle, 900);
	assert.strictEqual(second.usage, 75);
});

test('parseMemInfo parses MemTotal and MemAvailable to calculate usage', () => {
	const sampleMeminfo = `
MemTotal:       16000000 kB
MemFree:         4000000 kB
MemAvailable:    8000000 kB
Buffers:          500000 kB
Cached:          3500000 kB
`;
	const mem = parseMemInfo(sampleMeminfo);
	// Total: 16,000,000 kB, Available: 8,000,000 kB => Used: 8,000,000 kB (50%)
	assert.strictEqual(mem.usage, 50);
	assert.strictEqual(mem.totalBytes, 16000000 * 1024);
	assert.strictEqual(mem.availableBytes, 8000000 * 1024);
	assert.strictEqual(mem.usedBytes, 8000000 * 1024);
});

test('formatBytes formats bytes to readable human strings', () => {
	assert.strictEqual(formatBytes(0), '0 B');
	assert.strictEqual(formatBytes(1024), '1.0 KB');
	assert.strictEqual(formatBytes(1024 * 1024 * 500), '500.0 MB');
	assert.strictEqual(formatBytes(1024 * 1024 * 1024 * 8.5), '8.5 GB');
});
