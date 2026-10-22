import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const CATEGORY_KEYS = [
	'time',
	'information',
	'media',
	'productivity',
	'applications',
	'finance',
	'calendar',
];

const SIZE_ORDER = [
	'small',
	'medium',
	'large',
];

export function categoryLabel(key) {
	const labels = {
		time: _('Time/Clocks'),
		information: _('Information'),
		media: _('Media'),
		productivity: _('Productivity'),
		applications: _('Applications'),
		finance: _('Finance'),
		calendar: _('Calendar'),
	};
	return labels[key] ?? labels.information;
};

function categoryKey(record) {
	const explicit = String(record.categoryKey ?? record.categoryId ?? record.category ?? '')
		.trim().toLocaleLowerCase();
	const type = String(record.type ?? record.id ?? '').toLocaleLowerCase();
	const localizedKey = CATEGORY_KEYS.find(key =>
		explicit === categoryLabel(key).toLocaleLowerCase());

	if (localizedKey) {
		return localizedKey;
	};
	if (type === 'calendar' || explicit === 'calendar') {
		return 'calendar';
	};
	if (['clock', 'digitalclock', 'binaryclock'].includes(type) ||
      ['time', 'clock', 'clocks', 'time/clocks'].includes(explicit)) {
		return 'time';
	};
	if (['photos', 'music'].includes(type) || explicit === 'media') {
		return 'media';
	};
	if (type === 'todo' || explicit === 'productivity') {
		return 'productivity';
	};
	if (type === 'applauncher' || ['application', 'applications', 'apps'].includes(explicit)) {
		return 'applications';
	};
	if (explicit === 'finance' || /(finance|stock|market|currency|crypto)/.test(type)) {
		return 'finance';
	};
	return 'information';
};

function sizeKey(sizeRecord) {
	const value = typeof sizeRecord === 'object' && sizeRecord !== null
		? sizeRecord.size ?? sizeRecord.key ?? sizeRecord.id ?? sizeRecord.value
		: sizeRecord;
	return String(value ?? '').trim().toLocaleLowerCase();
};

function sizeLabel(size) {
	const labels = {
		small: _('Small'),
		medium: _('Wide'),
		large: _('Large'),
	};
	return labels[size] ?? size;
};

function normalizedSizes(record) {
	const supplied = Array.isArray(record.sizes)
		? record.sizes
		: Array.isArray(record.supportedSizes)
			? record.supportedSizes
			: [];
	const unique = new Map();

	for (const sizeRecord of supplied) {
		const size = sizeKey(sizeRecord);
		if (!size || unique.has(size)) {
			continue;
		};

		unique.set(size, {
			...(typeof sizeRecord === 'object' && sizeRecord !== null ? sizeRecord : {}),
			size,
			label: sizeLabel(size),
		});
	};

	const requestedDefault = sizeKey(record.defaultSize ?? record.size);
	if (unique.size === 0) {
		const fallback = requestedDefault || 'small';
		unique.set(fallback, {size: fallback, label: sizeLabel(fallback)});
	};

	const sizes = [...unique.values()].sort((a, b) => {
		const aIndex = SIZE_ORDER.indexOf(a.size);
		const bIndex = SIZE_ORDER.indexOf(b.size);
		return (aIndex < 0 ? SIZE_ORDER.length : aIndex) -
      (bIndex < 0 ? SIZE_ORDER.length : bIndex);
	});

	return {
		sizes,
		defaultSize: unique.has(requestedDefault) ? requestedDefault : sizes[0].size,
	};
};

export function normalizedCatalog(catalog) {
	if (!Array.isArray(catalog)) {
		return [];
	};

	return catalog
		.filter(record => record && (record.type || record.id))
		.map(record => {
			const type = String(record.type ?? record.id);
			const label = String(record.label ?? record.name ?? type);
			const category = String(record.category ?? _('Information'));
			const sectionKey = categoryKey(record);
			const sectionLabel = categoryLabel(sectionKey);
			const description = String(record.description ?? '');
			const rawKeywords = Array.isArray(record.keywords)
				? record.keywords.join(' ')
				: String(record.keywords ?? '');
			const iconName = String(record.iconName ?? record.icon_name ?? record.icon ??
        'applications-other-symbolic');
			const sizes = normalizedSizes(record);

			return {
				...record,
				type,
				label,
				category,
				sectionKey,
				sectionLabel,
				description,
				keywords: rawKeywords,
				iconName,
				...sizes,
				searchText: `${label} ${type} ${category} ${sectionLabel} ${description} ${rawKeywords} ${sizes.sizes.map(size => size.label).join(' ')}`.toLocaleLowerCase(),
			};
		});
};

