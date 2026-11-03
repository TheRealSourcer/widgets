/**
 * System Resource Reader
 * Reads CPU, RAM, and Disk metrics via native Linux /proc and Gio.
 */

export function formatBytes(bytes, decimals = 1) {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
	const value = bytes / Math.pow(1024, i);

	return `${value.toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
};

export function parseCpuStat(content, prevTotal = 0, prevIdle = 0) {
	if (!content) return { usage: 0, total: prevTotal, idle: prevIdle };

	const match = content.match(/^cpu\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)?\s+(\d+)?\s+(\d+)?\s+(\d+)?/m);
	if (!match) return { usage: 0, total: prevTotal, idle: prevIdle };

	const values = match.slice(1).map(v => parseInt(v || '0', 10));
	const [user, nice, system, idleVal, iowait = 0, irq = 0, softirq = 0, steal = 0] = values;

	const idle = idleVal + iowait;
	const total = user + nice + system + idle + irq + softirq + steal;

	let usage = 0;
	if (prevTotal > 0 && total > prevTotal) {
		const deltaTotal = total - prevTotal;
		const deltaIdle = idle - prevIdle;
		usage = Math.max(0, Math.min(100, Math.round(100 * (deltaTotal - deltaIdle) / deltaTotal)));
	};

	return { usage, total, idle };
};

export function parseMemInfo(content) {
	if (!content) {
		return { totalBytes: 0, availableBytes: 0, usedBytes: 0, usage: 0 };
	};

	const totalMatch = content.match(/MemTotal:\s+(\d+)\s+kB/);
	const availMatch = content.match(/MemAvailable:\s+(\d+)\s+kB/);
	const freeMatch = content.match(/MemFree:\s+(\d+)\s+kB/);
	const buffersMatch = content.match(/Buffers:\s+(\d+)\s+kB/);
	const cachedMatch = content.match(/Cached:\s+(\d+)\s+kB/);

	const totalKb = totalMatch ? parseInt(totalMatch[1], 10) : 0;
	let availKb = 0;

	if (availMatch) {
		availKb = parseInt(availMatch[1], 10);
	} else if (freeMatch) {
		const freeKb = parseInt(freeMatch[1], 10);
		const bufKb = buffersMatch ? parseInt(buffersMatch[1], 10) : 0;
		const cacheKb = cachedMatch ? parseInt(cachedMatch[1], 10) : 0;
		availKb = freeKb + bufKb + cacheKb;
	};

	const totalBytes = totalKb * 1024;
	const availableBytes = availKb * 1024;
	const usedBytes = Math.max(0, totalBytes - availableBytes);
	const usage = totalBytes > 0 ? Math.max(0, Math.min(100, Math.round(100 * usedBytes / totalBytes))) : 0;

	return { totalBytes, availableBytes, usedBytes, usage };
};

export function calculateDiskUsage(sizeBytes, freeBytes) {
	const totalBytes = Math.max(0, sizeBytes || 0);
	const availableBytes = Math.max(0, freeBytes || 0);
	const usedBytes = Math.max(0, totalBytes - availableBytes);
	const usage = totalBytes > 0 ? Math.max(0, Math.min(100, Math.round(100 * usedBytes / totalBytes))) : 0;

	return { totalBytes, availableBytes, usedBytes, usage };
};

export async function readSystemMetrics(prevState = {}) {
	let cpu = { usage: 0, total: prevState?.cpu?.total || 0, idle: prevState?.cpu?.idle || 0 };
	let memory = { totalBytes: 0, availableBytes: 0, usedBytes: 0, usage: 0 };
	let disk = { totalBytes: 0, availableBytes: 0, usedBytes: 0, usage: 0 };

	try {
		const GLib = globalThis?.imports?.gi?.GLib ?? (await import('gi://GLib')).default;
		const Gio = globalThis?.imports?.gi?.Gio ?? (await import('gi://Gio')).default;

		// 1. Read /proc/stat for CPU
		const [statOk, statBytes] = GLib.file_get_contents('/proc/stat');
		if (statOk && statBytes) {
			const statStr = new TextDecoder().decode(statBytes);
			cpu = parseCpuStat(statStr, prevState?.cpu?.total || 0, prevState?.cpu?.idle || 0);
		};

		// 2. Read /proc/meminfo for Memory
		const [memOk, memBytes] = GLib.file_get_contents('/proc/meminfo');
		if (memOk && memBytes) {
			const memStr = new TextDecoder().decode(memBytes);
			memory = parseMemInfo(memStr);
		};

		// 3. Query root filesystem for Disk
		const rootFile = Gio.File.new_for_path('/');
		const fsInfo = rootFile.query_filesystem_info('filesystem::size,filesystem::free', null);
		if (fsInfo) {
			const size = fsInfo.get_attribute_uint64('filesystem::size');
			const free = fsInfo.get_attribute_uint64('filesystem::free');
			disk = calculateDiskUsage(size, free);
		};
	} catch (_error) {
		// Environment fallback (e.g. running in test context)
	};

	return { cpu, memory, disk };
};
