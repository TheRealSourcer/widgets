import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { warn } from '../../logger.js';

export const type = 'photos';
export const label = 'Photos';
export const stylesheet = 'widgets/photos/stylesheet.css';
export const defaultSize = 'medium';

const IMAGE_EXTENSIONS = ['.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'];
const PHOTO_CACHE_TTL_MS = 60 * 1000;
const PHOTO_REFRESH_SECONDS = 15;
const PHOTO_RADIUS = 26;

let picturePoolCache = {time: 0, pools: []};
const pictureAssignments = new Map();

function collectPictures(directory, images, seenDirectories, depth = 0) {
	if (!directory || depth > 4 || images.length >= 300) {
		return;
	};

	const path = directory.get_path();

	if (!path || seenDirectories.has(path)) {
		return;
	};

	seenDirectories.add(path);

	let enumerator = null;

	try {
		enumerator = directory.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
		let info;

		while ((info = enumerator.next_file(null)) !== null) {
			if (images.length >= 300) {
				break;
			};

			const child = directory.get_child(info.get_name());

			if (info.get_file_type() === Gio.FileType.DIRECTORY) {
				collectPictures(child, images, seenDirectories, depth + 1);
				continue;
			};

			if (info.get_file_type() !== Gio.FileType.REGULAR) {
				continue;
			};

			const lower = info.get_name().toLowerCase();

			if (IMAGE_EXTENSIONS.some(extension => lower.endsWith(extension))) {
				images.push(child);
			};
		};
	} catch (error) {
		warn('photos-directory-read', `Could not read photos from ${path}: ${error.message}`);
	} finally {
		enumerator?.close(null);
	};
};

function filePath(file) {
	return file?.get_path() ?? null;
};

function invalidatePicturePool() {
	picturePoolCache = {time: 0, pools: []};
};

function picturePools(force = false, source = 'camera') {
	const now = Date.now();

	if (!force && now - picturePoolCache.time < PHOTO_CACHE_TTL_MS) {
		return picturePoolCache.pools;
	};

	const homeDir = GLib.get_home_dir();
	const picturesDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? GLib.build_filenamev([homeDir, 'Pictures']);
	const downloadsDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ?? GLib.build_filenamev([homeDir, 'Downloads']);
	
	let searchRoots = [];
	
	// Map source setting to directories
	switch (source) {
		case 'screenshots':
			searchRoots = [GLib.build_filenamev([picturesDir, 'Screenshots'])];
			break;
		case 'downloads':
			searchRoots = [downloadsDir];
			break;
		case 'camera':
		default:
			searchRoots = [GLib.build_filenamev([picturesDir, 'Camera'])];
			break;
	};

	picturePoolCache = {
		time: now,
		pools: searchRoots.map(root => {
			const images = [];

			collectPictures(Gio.File.new_for_path(root), images, new Set());
			images.sort((a, b) => a.get_path().localeCompare(b.get_path()));
			return images;
		}),
	};

	return picturePoolCache.pools;
};

function stablePictureIndex(widgetId, length) {
	let hash = Math.floor(Date.now() / 86400000);

	for (const character of String(widgetId)) {
		hash = ((hash * 31) + character.codePointAt(0)) >>> 0;
	};

	return hash % length;
};

function assignPictureFile(assignment, force = false, excludedPath = null, source = 'camera') {
	const pools = picturePools(force, source);
	const currentPath = pictureAssignments.get(assignment) ?? null;
	const poolPaths = new Set(pools.flatMap(pool => pool.map(filePath)));
	const usedPaths = new Set([...pictureAssignments.entries()].filter(([key, path]) => key !== assignment && poolPaths.has(path)).map(([, path]) => path));

	for (const pool of pools) {
		const available = pool.filter(file => {
			const path = filePath(file);

			return path !== excludedPath && !usedPaths.has(path);
		});

		if (available.length === 0) {
			continue;
		};

		const current = available.find(file => filePath(file) === currentPath);
		const selected = current ?? available[stablePictureIndex(assignment.seed, available.length)];

		pictureAssignments.set(assignment, filePath(selected));
		return selected;
	};

	for (const pool of pools) {
		const available = pool.filter(file => filePath(file) !== excludedPath);

		if (available.length === 0) {
			continue;
		};

		const current = available.find(file => filePath(file) === currentPath);
		const selected = current ?? available[stablePictureIndex(assignment.seed, available.length)];

		pictureAssignments.set(assignment, filePath(selected));
		return selected;
	};

	pictureAssignments.delete(assignment);
	return null;
};

function releasePictureFile(assignment, file) {
	if (pictureAssignments.get(assignment) === filePath(file)) {
		pictureAssignments.delete(assignment);
	};
};

const PhotoFrame = GObject.registerClass(
	class PhotoFrame extends St.Widget {
		_init(assignment, file, source = 'camera') {
			super._init({
				style_class: 'widget-photo',
				x_expand: true,
				y_expand: true,
				x_align: Clutter.ActorAlign.FILL,
				y_align: Clutter.ActorAlign.FILL,
			});

			this._assignment = assignment;
			this._source = source;
			this._file = null;
			this._setFile(file);

			this._refreshTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PHOTO_REFRESH_SECONDS, () => {
				if (!this.get_parent()) {
					this._refreshTimeoutId = 0;
					return GLib.SOURCE_REMOVE;
				};

				this._refreshFile(false);
				return GLib.SOURCE_CONTINUE;
			});

			this.connect('destroy', this._onDestroy.bind(this));
		};

		_onDestroy() {
			releasePictureFile(this._assignment, this._file);

			if (this._refreshTimeoutId) {
				GLib.Source.remove(this._refreshTimeoutId);
				this._refreshTimeoutId = 0;
			};

			this._file = null;
			this.set_style(null);
		};

		_setFile(file) {
			if (filePath(file) === filePath(this._file)) {
				return false;
			};

			this._file = file;
			const uri = file?.get_uri() ?? null;
			this.set_style(uri ? `background-image: url(${JSON.stringify(uri)});` : null);

			return true;
		};

		_refreshFile(force, excludedPath = null) {
			const currentPath = filePath(this._file);

			if (currentPath && !this._file.query_exists(null)) {
				excludedPath ??= currentPath;
				force = true;
				invalidatePicturePool();
			};

			return this._setFile(assignPictureFile(this._assignment, force, excludedPath, this._source));
		};
	}
);

export function style(theme) {
  return `background-color: #000000; border-color: ${theme.border}; border-radius: 26px; padding: 0px;`;
};

export function render({body, widget, photosSource = 'camera'}) {
	const assignment = {seed: widget.id};
	const frame = new PhotoFrame(assignment, assignPictureFile(assignment, false, null, photosSource), photosSource);

	frame.set_x_expand(true);
	frame.set_y_expand(true);
	body.add_child(frame);
};

export function cleanup() {
	invalidatePicturePool();
	pictureAssignments.clear();
};
