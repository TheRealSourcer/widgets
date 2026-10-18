import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DATA_DIR_NAME = 'widgets@distro.com';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const ensuredDirectories = new Set();

function setMode(path, mode) {
	try {
		GLib.chmod(path, mode);
	} catch (error) {
		console.debug(`Could not set private permissions on ${path}: ${error}`);
	};
};

function ensureDirectory(dirPath) {
	if (ensuredDirectories.has(dirPath)) {
		return true;
	};

	try {
		const file = Gio.File.new_for_path(dirPath);
		if (!file.query_exists(null)) {
			file.make_directory_with_parents(null);
		};
		setMode(dirPath, DIRECTORY_MODE);
		ensuredDirectories.add(dirPath);
		return true;
	} catch (error) {
		console.error(`Error creating data directory ${dirPath}: ${error}`);
		return false;
	};
};

export function getDataDir(subFolder = '') {
	const root = GLib.build_filenamev([GLib.get_user_data_dir(), DATA_DIR_NAME]);
	ensureDirectory(root);
	if (!subFolder) {
		return root;
	};

	const dir = GLib.build_filenamev([root, String(subFolder)]);
	ensureDirectory(dir);
	return dir;
};

export function safeStorageId(value) {
	const safe = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
	return safe || 'default';
};

export function loadJsonFromFileAsync(filePath, callback, cancellable = null) {
	const file = Gio.File.new_for_path(filePath);
	file.load_contents_async(cancellable, (source, result) => {
		let data = null;
		let loadError = null;

		try {
			const [ok, contents] = source.load_contents_finish(result);
			if (ok && contents?.length) {
				data = JSON.parse(new TextDecoder('utf-8').decode(contents));
			};
		} catch (error) {
			loadError = error;
			if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) &&
				!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
				console.error(`Error reading JSON from ${filePath}: ${error}`);
			};
		};

		if (!cancellable?.is_cancelled()) {
			callback(data, loadError);
		};
	});
};

export function saveJsonToFile(filePath, data) {
	const file = Gio.File.new_for_path(filePath);
	const parent = file.get_parent();
	if (parent && !ensureDirectory(parent.get_path())) {
		return false;
	};

	try {
		const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
		file.replace_contents(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null);
		setMode(filePath, FILE_MODE);
		return true;
	} catch (error) {
		console.error(`Error saving JSON to ${filePath}: ${error}`);
		return false;
	};
};

export function cleanup() {
	ensuredDirectories.clear();
};
