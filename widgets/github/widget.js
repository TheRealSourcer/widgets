import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';
import {surfaceStyle, watchSettings} from '../../utils/widget.js';
import {VERTICAL, HORIZONTAL} from '../../compatibility.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import {getDataDir, loadJsonFromFileAsync, saveJsonToFile} from '../../utils/storage.js';
import {parseCssColor, cssColorToRgba} from '../../utils/colors.js';

export const type = 'github';
export const label = 'GitHub Activity';
export const stylesheet = 'widgets/github/stylesheet.css';
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium', 'large'];

const profileUrlFor = username => `https://github.com/${encodeURIComponent(username)}`;

function normalizeUsername(value) {
	return String(value ?? '').trim().replace(/^@/, '');
};

function isValidUsername(value) {
	return value.length >= 1 && value.length <= 39 &&
        /^[A-Za-z0-9-]+$/.test(value) && !value.startsWith('-') &&
        !value.endsWith('-') && !value.includes('--');
};

function settingBoolean(settings, key, fallback = false) {
	return settings?.get_boolean(key) ?? fallback;
};

function settingString(settings, key) {
	return settings?.get_string(key) ?? '';
};

function storageId(value) {
	const safe = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
	return safe || 'default';
};


const DAY_LABEL_ROWS = { 1: 'Mon', 3: 'Wed', 5: 'Fri' };
const DAY_LABEL_ROWS_MINI = { 1: 'M', 3: 'W', 5: 'F' };
const REFRESH_INTERVAL = 600;
const HTTP_OK = 200;
const WIDGET_PADDING = 16;
const GITHUB_GREEN_COLORS = ['#39d353', '#26a641', '#006d32', '#0e4429'];

const monthNames = () =>
	[_('Jan'), _('Feb'), _('Mar'), _('Apr'), _('May'), _('Jun'),
		_('Jul'), _('Aug'), _('Sep'), _('Oct'), _('Nov'), _('Dec')];

const translateDayRows = rows => {
	const labels = {
		Mon: _('Mon'),
		Wed: _('Wed'),
		Fri: _('Fri'),
		M: _('M'),
		W: _('W'),
		F: _('F'),
	};
	return Object.fromEntries(
		Object.entries(rows).map(([day, label]) => [day, labels[label] ?? label]));
};

const decoder = new TextDecoder();

function contributionLevel(count) {
	if (count >= 10) {
		return 4;
	};
	if (count >= 6) {
		return 3;
	};
	if (count >= 3) {
		return 2;
	};
	if (count >= 1) {
		return 1;
	};
	return 0;
};

function formatCount(n) {
	if (n >= 10000) {
		return `${(n / 1000).toFixed(0)}k`;
	};
	if (n >= 1000) {
		return `${(n / 1000).toFixed(1).replace('.0', '')}k`;
	};
	return String(n);
};

export function style(theme) {
	return surfaceStyle(theme);
};

export function render({ body, widget, theme, sizeForWidget, settings, refresh }) {
	watchSettings(body, settings, ['github-username', 'github-use-green'], refresh);
	const textColor = theme.text;
	const accentHex = theme.accent || '#3584e4';
	const textRgba = (a) => cssColorToRgba(textColor, a);

	const emptyCellColor = '#454545';

	const useGreen = settingBoolean(settings, 'github-use-green');
	const levelColors = useGreen
		? GITHUB_GREEN_COLORS
		: [
			cssColorToRgba(accentHex, 1.0),
			cssColorToRgba(accentHex, 0.75),
			cssColorToRgba(accentHex, 0.50),
			cssColorToRgba(accentHex, 0.25),
		];

	const sizeKey = widget?.size ?? 'medium';
	const isMini = sizeKey === 'small';
	const isTall = sizeKey === 'tall';
	const isLarge = sizeKey === 'large' || sizeKey === 'huge';
	const isWide = sizeKey === 'wide';

	const [refW, refH] = sizeForWidget ? sizeForWidget(widget) : [454, 220];
	const contentW = Math.max(120, refW - WIDGET_PADDING * 2 - 2);
	const contentH = Math.max(100, refH - WIDGET_PADDING * 2 - 2);

	const layout = isMini
		? {
			avatar: 24, username: 12, badge: 11, label: 11, entryWidth: 112,
			footer: 0, month: 0, spacing: 5, gap: 2, daysW: 22,
			footerFont: 0, dayRows: translateDayRows(DAY_LABEL_ROWS_MINI), maxWeeks: 16,
		}
		: isLarge
			? {
				avatar: 34, username: 16, badge: 14, label: 12, entryWidth: 170,
				footer: 14, month: 14, spacing: 8, gap: 3, daysW: 30,
				footerFont: 13, dayRows: translateDayRows(DAY_LABEL_ROWS), maxWeeks: sizeKey === 'huge' ? 30 : 24,
			}
			: isTall
				? {
					avatar: 30, username: 14, badge: 12, label: 11, entryWidth: 130,
					footer: 12, month: 12, spacing: 7, gap: 2, daysW: 26,
					footerFont: 11, dayRows: translateDayRows(DAY_LABEL_ROWS), maxWeeks: 16,
				}
				: {
					avatar: 28, username: 14, badge: 12, label: 11, entryWidth: 150,
					footer: 12, month: 12, spacing: 7, gap: 2, daysW: 28,
					footerFont: 11, dayRows: translateDayRows(DAY_LABEL_ROWS), maxWeeks: isWide ? 40 : 24,
				};

	const avatarSize = layout.avatar;
	const cellGap = layout.gap;
	const dayLabelsWidth = layout.daysW;
	const showFooter = !isMini;
	const showStats = isLarge;
	const monthBottomMargin = isMini ? 0 : 4;
	const childCount = 2 + (showStats ? 1 : 0) + (showFooter ? 1 : 0);
	const mainGaps = Math.max(0, childCount - 1) * layout.spacing;
	const statsBudget = showStats ? 68 : 0;
	const matrixBudget = contentH - layout.avatar - layout.month - layout.footer -
        monthBottomMargin - mainGaps - statsBudget;
	const cellMax = isLarge ? 20 : 16;
	const cellSize = Math.max(4, Math.min(cellMax, Math.floor((matrixBudget - 6 * cellGap) / 7)));
	const matrixBodyGap = isMini ? 6 : 0;
	const availableGridWidth = contentW - dayLabelsWidth - matrixBodyGap;
	const weeks = Math.max(6, Math.min(layout.maxWeeks,
		Math.floor((availableGridWidth + cellGap) / (cellSize + cellGap))));

	const dataFilePath = GLib.build_filenamev([getDataDir('github'), `github-${storageId(widget?.id)}.json`]);

	const configuredUsername = normalizeUsername(settingString(settings, 'github-username'));
	const settingsUsername = isValidUsername(configuredUsername) ? configuredUsername : '';
	let username = settingsUsername;
	const state = {
		timerId: null,
		editing: false,
		requestGeneration: 0,
		cancellable: new Gio.Cancellable(),
	};
	let session = new Soup.Session();
	let latestByDate = new Map();
	let lastSyncTime = null;
	let currentStreak = 0;
	let longestStreak = 0;
	let todayCount = 0;


	body.set_clip_to_allocation(true);

	const setStatus = (text) => {
		statusLabel.text = text;
	};

	const mainBox = new St.BoxLayout({
		...VERTICAL,
		x_expand: true,
		y_expand: true,
		style: `spacing: ${layout.spacing}px;`,
	});
	body.add_child(mainBox);

	const headerBox = new St.BoxLayout({
		...HORIZONTAL,
		x_align: Clutter.ActorAlign.FILL,
		x_expand: true,
		style: `spacing: ${isMini ? 5 : 8}px;`,
	});

	const avatarInitialsLabel = new St.Label({
		style_class: 'widget-github-bold',
		text: '',
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		style: `font-size: ${Math.max(6, Math.round(avatarSize * 0.4))}px; color: ${textColor};`,
	});

	const avatarWidget = new St.Bin({
		style_class: 'widget-github-avatar',
		child: avatarInitialsLabel,
		reactive: true,
		track_hover: true,
		style: `background-color: ${textRgba(0.15)}; width: ${avatarSize}px; height: ${avatarSize}px;`,
		y_align: Clutter.ActorAlign.CENTER,
		x_expand: false,
	});


	const usernameLabel = new St.Label({
		style_class: 'widget-github-bold',
		text: _('Click to set username'),
		y_align: Clutter.ActorAlign.CENTER,
		style: `font-size: ${layout.username}px; color: ${textColor};`,
		reactive: true,
	});

	const usernameEntry = new St.Entry({
		can_focus: true,
		y_align: Clutter.ActorAlign.CENTER,
		style: `font-size: ${layout.username}px; color: ${textColor}; width: ${layout.entryWidth}px;`,
	});
	usernameEntry.hide();

	const headerSpacer = new St.Widget({ x_expand: true });

	const badgeLabel = new St.Label({
		style_class: 'widget-github-bold',
		text: '',
		y_align: Clutter.ActorAlign.CENTER,
		style: `font-size: ${layout.badge || 11}px; color: ${textColor};`,
	});

	const statusLabel = new St.Label({
		style_class: 'widget-github-secondary',
		text: isMini ? _('Set user') : _('Click username to configure'),
		y_align: Clutter.ActorAlign.CENTER,
		style: `font-size: ${isMini ? 10 : (isLarge ? 15 : 12)}px; color: ${textColor};`,
	});

	headerBox.add_child(avatarWidget);
	headerBox.add_child(usernameLabel);
	headerBox.add_child(usernameEntry);
	headerBox.add_child(headerSpacer);
	headerBox.add_child(badgeLabel);
	mainBox.add_child(headerBox);

	const matrixBox = new St.BoxLayout({
		...VERTICAL,
		x_expand: true,
		y_expand: isLarge ? false : true,
	});
	mainBox.add_child(matrixBox);

	const monthLabelsRow = new St.Widget({ x_align: Clutter.ActorAlign.START });
	matrixBox.add_child(monthLabelsRow);

	const matrixBody = new St.BoxLayout({
		...HORIZONTAL,
		x_align: Clutter.ActorAlign.FILL,
		x_expand: true,
		y_expand: isLarge ? false : true,
		style: `spacing: ${isMini ? 6 : 0}px;`,
	});
	matrixBox.add_child(matrixBody);

	const dayLabelsColumn = new St.BoxLayout({
		...VERTICAL,
		style: `width: ${dayLabelsWidth}px;`,
	});
	matrixBody.add_child(dayLabelsColumn);

	const gridCanvas = new St.DrawingArea({
		x_expand: false,
		style: `background-color: ${theme.background};`,
	});
	matrixBody.add_child(gridCanvas);

	let statsBox = null;
	if (isLarge) {
		statsBox = new St.BoxLayout({
			...VERTICAL,
			x_expand: true,
			style_class: 'widget-github-stats',
		});
		mainBox.add_child(statsBox);
	};


	let footerBox = null;
	if (!isMini) {
		footerBox = new St.BoxLayout({
			...HORIZONTAL,
			x_align: Clutter.ActorAlign.FILL,
			x_expand: true,
		});

		footerBox.add_child(statusLabel);

		const legendBox = new St.BoxLayout({
			y_align: Clutter.ActorAlign.CENTER,
			x_align: Clutter.ActorAlign.END,
			x_expand: true,
			style_class: 'widget-github-legend',
		});

		const lessLabel = new St.Label({
			style_class: 'widget-github-secondary widget-github-legend-less',
			text: _('Less'),
			y_align: Clutter.ActorAlign.CENTER,
			style: `font-size: ${isLarge ? 15 : 12}px; color: ${textColor};`,
		});
		legendBox.add_child(lessLabel);

		const legendColors = [emptyCellColor, ...levelColors.slice().reverse()];
		legendColors.forEach(color => {
			const sq = new St.Widget({
				style_class: 'widget-github-legend-cell',
				y_align: Clutter.ActorAlign.CENTER,
				style: `background-color: ${color};`,
			});
			legendBox.add_child(sq);
		});

		const moreLabel = new St.Label({
			style_class: 'widget-github-secondary widget-github-legend-more',
			text: _('More'),
			y_align: Clutter.ActorAlign.CENTER,
			style: `font-size: ${isLarge ? 15 : 12}px; color: ${textColor};`,
		});
		legendBox.add_child(moreLabel);

		footerBox.add_child(legendBox);
		mainBox.add_child(footerBox);
	};

	const matrixGeometry = { size: 0, gap: 0, dataKey: '', cells: [] };

	function traceRoundedRect(ctx, x, y, w, h, radius) {
		ctx.newSubPath();
		ctx.arc(x + radius, y + radius, radius, Math.PI, 1.5 * Math.PI);
		ctx.arc(x + w - radius, y + radius, radius, 1.5 * Math.PI, 2 * Math.PI);
		ctx.arc(x + w - radius, y + h - radius, radius, 2 * Math.PI, 2.5 * Math.PI);
		ctx.arc(x + radius, y + h - radius, radius, 2.5 * Math.PI, 3 * Math.PI);
		ctx.closePath();
	};

	gridCanvas.connectObject('repaint', canvas => {
		const { size, cells } = matrixGeometry;
		if (size <= 0) return;
		const ctx = canvas.get_context();
		const [cw, ch] = canvas.get_surface_size();
		const radius = isMini ? 1.2 : 2.5;
		for (const cell of cells) {
			if (cell.x + size > cw || cell.y + size > ch) {
				continue;
			};
			const c = parseCssColor(cell.color);
			ctx.setSourceRGBA(c.r, c.g, c.b, c.a !== undefined ? c.a : 1);
			traceRoundedRect(ctx, cell.x, cell.y, size, size, radius);
			ctx.fill();
		};
		ctx.$dispose();
	}, mainBox);

	function renderMonthLabels(weeksToRender, startUnix) {
		if (isMini) return;
		const pitch = cellSize + cellGap;
		monthLabelsRow.destroy_all_children();
		monthLabelsRow.style = `margin-left: ${dayLabelsWidth}px; height: ${layout.month}px; margin-bottom: ${monthBottomMargin}px;`;

		let curMonth = -1;
		let lastLabelEnd = -50;
		const minLabelSpacing = isLarge ? 20 : 30;

		for (let w = 0; w < weeksToRender; w++) {
			const weekStartUnix = startUnix + w * 7 * 86400;

			for (let d = 0; d < 7; d++) {
				const dayUnix = weekStartUnix + d * 86400;
				const dt = GLib.DateTime.new_from_unix_local(dayUnix);
				const month = dt.get_month() - 1;

				if (month === curMonth) {
					continue;
				};

				const columnIndex = w;
				const xPos = columnIndex * pitch;

				const effectiveXPos = xPos;

				if (effectiveXPos < lastLabelEnd + minLabelSpacing) {
					continue;
				};

				const estimatedLabelWidth = 30;
				if (dayLabelsWidth + effectiveXPos + estimatedLabelWidth > contentW) {
					break;
				};

				curMonth = month;

				const lbl = new St.Label({
					style_class: 'widget-github-secondary',
					text: monthNames()[month],
					x_align: Clutter.ActorAlign.START,
					y_align: Clutter.ActorAlign.CENTER,
					style: `font-size: ${layout.month}px; color: ${textColor};`,
				});

				lbl.translation_x = effectiveXPos;
				monthLabelsRow.add_child(lbl);

				lastLabelEnd = effectiveXPos + estimatedLabelWidth;
				break;
			};
		};
	};

	function renderDayLabels() {
		dayLabelsColumn.destroy_all_children();
		dayLabelsColumn.style = `width: ${dayLabelsWidth}px; spacing: ${cellGap}px;`;
		for (let row = 0; row < 7; row++) {
			const slot = new St.Widget({
				layout_manager: new Clutter.BinLayout(),
				width: dayLabelsWidth,
				height: cellSize,
			});
			if (layout.dayRows[row]) {
				const lbl = new St.Label({
					style_class: 'widget-github-secondary',
					text: layout.dayRows[row],
					y_align: Clutter.ActorAlign.CENTER,
					style: `font-size: ${layout.label}px; color: ${textColor};`,
				});
				const clutterText = lbl.get_clutter_text();
				if (clutterText) {
					clutterText.ellipsize = Pango.EllipsizeMode.NONE;
				};
				slot.add_child(lbl);
			};
			dayLabelsColumn.add_child(slot);
		};
	};

	function cellColorFor(level) {
		if (level === 0) {
			return emptyCellColor;
		};
		return levelColors[4 - level];
	};

	function renderMatrix(contributionsByDate) {
		const byDate = contributionsByDate || latestByDate;
		const dataKey = `${cellSize}|${cellGap}|${weeks}|${useGreen}|${contentW}`;
		if (dataKey === matrixGeometry.dataKey && !contributionsByDate) return;

		renderDayLabels();

		const today = GLib.DateTime.new_now_local();
		const daysInGrid = weeks * 7;
		const gridEnd = today.add_days(6 - (today.get_day_of_week() % 7));
		const alignedStart = gridEnd.add_days(-(daysInGrid - 1));

		renderMonthLabels(weeks + 1, alignedStart.to_unix());

		const cells = [];
		for (let i = 0; i < daysInGrid; i++) {
			const date = alignedStart.add_days(i);
			if (date.compare(today) > 0) {
				break;
			};
			const dateKey = date.format('%Y-%m-%d');
			const col = Math.floor(i / 7);
			const row = date.get_day_of_week() % 7;
			const level = contributionLevel(byDate.get(dateKey) ?? 0);
			cells.push({
				x: col * (cellSize + cellGap),
				y: row * (cellSize + cellGap),
				color: cellColorFor(level),
			});
		};

		matrixGeometry.size = cellSize;
		matrixGeometry.gap = cellGap;
		matrixGeometry.dataKey = dataKey;
		matrixGeometry.cells = cells;

		gridCanvas.set_width(Math.max(1, weeks * (cellSize + cellGap) - cellGap));
		gridCanvas.set_height(Math.max(1, 7 * (cellSize + cellGap) - cellGap));
		gridCanvas.queue_repaint();
	};

	function computeStats(byDate) {
		const today = GLib.DateTime.new_now_local();
		const todayKey = today.format('%Y-%m-%d');
		todayCount = byDate.get(todayKey) ?? 0;

		let streak = 0;
		let longest = 0;
		let tempStreak = 0;

		const checkDate = GLib.DateTime.new_now_local();
		for (let i = 0; i < 365; i++) {
			const d = checkDate.add_days(-i);
			const key = d.format('%Y-%m-%d');
			const count = byDate.get(key) ?? 0;
			if (count > 0) {
				tempStreak++;
				if (tempStreak > longest) {
					longest = tempStreak;
				};
				if (i === 0 || streak === i) {
					streak = tempStreak;
				};
			} else {
				tempStreak = 0;
			};
		};

		currentStreak = streak;
		longestStreak = longest;
	};

	function renderStats() {
		if (!statsBox) return;
		statsBox.destroy_all_children();

		const accentRgb = parseCssColor(accentHex);
		const accentBytes = `${Math.round(accentRgb.r * 255)},${Math.round(accentRgb.g * 255)},${Math.round(accentRgb.b * 255)}`;
		const statBg = `background-color: rgba(${accentBytes},0.08);`;

		const statsData = [
			{ icon: 'emoji-recent-symbolic', label: _('Today'), value: String(todayCount) },
			{ icon: 'media-playlist-consecutive-symbolic', label: _('Current streak'), value: `${currentStreak}d` },
			{ icon: 'starred-symbolic', label: _('Longest streak'), value: `${longestStreak}d` },
		];

		for (const stat of statsData) {
			const row = new St.BoxLayout({
				...HORIZONTAL,
				x_expand: true,
				style_class: 'widget-github-stat-row',
				style: statBg,
			});

			const icon = new St.Icon({
				icon_name: stat.icon,
				icon_size: 14,
				style: `color: ${accentHex};`,
				y_align: Clutter.ActorAlign.CENTER,
			});

			const labelWidget = new St.Label({
				style_class: 'widget-github-stat-label',
				text: stat.label,
				x_expand: true,
				y_align: Clutter.ActorAlign.CENTER,
				style: `color: ${textColor};`,
			});

			const valueWidget = new St.Label({
				style_class: 'widget-github-stat-value',
				text: stat.value,
				y_align: Clutter.ActorAlign.CENTER,
				style: `color: ${textColor};`,
			});

			row.add_child(icon);
			row.add_child(labelWidget);
			row.add_child(valueWidget);
			statsBox.add_child(row);
		};
	};

	function fetchContributions() {
		if (state.cancellable.is_cancelled() || !isValidUsername(username)) return;
		setStatus(isMini ? '…' : _('Fetching…'));

		const requestedUsername = username;
		const requestGeneration = ++state.requestGeneration;
		const url = `https://github.com/users/${encodeURIComponent(requestedUsername)}/contributions`;
		const message = Soup.Message.new('GET', url);
		session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, state.cancellable, (s, res) => {
			try {
				const bytes = s.send_and_read_finish(res);

				if (state.cancellable.is_cancelled() || requestGeneration !== state.requestGeneration ||
                    requestedUsername !== username || mainBox.get_parent() !== body) return;
				if (message.get_status() !== HTTP_OK) {
					throw new Error(`HTTP ${message.get_status()}`);
				};

				const html = decoder.decode(bytes.get_data());

				const byDate = new Map();
				const tdRegex = /<td([^>]+)>/g;
				let match;
				const idToDate = new Map();
				while ((match = tdRegex.exec(html)) !== null) {
					const attr = match[1];
					const idM = attr.match(/id="([^"]+)"/);
					const dateM = attr.match(/data-date="([^"]+)"/);
					if (idM && dateM) {
						idToDate.set(idM[1], dateM[1]);
					};
				};

				const tooltipRegex = /<tool-tip([^>]+)>([^<]+)<\/tool-tip>/g;
				while ((match = tooltipRegex.exec(html)) !== null) {
					const attr = match[1];
					const text = match[2].trim();
					const forM = attr.match(/for="([^"]+)"/);
					if (!forM) {
						continue;
					};

					const countMatch = text.match(/^([\d,]+|No)\s+contribution/);
					if (!countMatch) {
						continue;
					};

					const count = countMatch[1] === "No" ? 0 : parseInt(countMatch[1].replace(/,/g, ''), 10);
					const dateStr = idToDate.get(forM[1]);
					if (dateStr) {
						byDate.set(dateStr, count);
					};
				};

				if (byDate.size === 0) {
					throw new Error('parse failed');
				};

				const h2Regex = /<h2[^>]*js-contribution-activity-description[^>]*>\s*([\d,]+)\s+contributions/i;
				const h2Match = html.match(h2Regex);
				const sumAll = [...byDate.values()].reduce((a, b) => a + b, 0);
				const yearTotal = h2Match ? parseInt(h2Match[1].replace(/,/g, ''), 10) : sumAll;

				badgeLabel.text = _('%s commits').format(formatCount(yearTotal));
				lastSyncTime = GLib.DateTime.new_now_local();
				setStatus(isMini
					? lastSyncTime.format('%H:%M')
					: _('Synced %s').format(lastSyncTime.format('%H:%M')));
				latestByDate = byDate;
				renderMatrix(byDate);

				saveJsonToFile(dataFilePath, {
					username: requestedUsername,
					total: { "parsed": yearTotal },
					contributions: [...byDate.entries()].map(([date, count]) => ({ date, count })),
				});

				if (isLarge) {
					computeStats(byDate);
					renderStats();
				};
			} catch (err) {
				const cancelled = err instanceof GLib.Error && err.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
				if (!state.cancellable.is_cancelled() && requestGeneration === state.requestGeneration && !cancelled) {
					const cached = latestByDate.size > 0;
					setStatus(isMini
						? (cached ? _('Cached') : _('Error'))
						: (cached ? _('Offline — cached') : _('Error loading')));
				};
			};
		});
	};

	function loadAvatar() {
		if (state.cancellable.is_cancelled()) return;
		if (!isValidUsername(username)) {
			avatarInitialsLabel.text = '?';
			avatarInitialsLabel.show();
			avatarWidget.set_style(`background-color: ${textRgba(0.15)}; width: ${avatarSize}px; height: ${avatarSize}px;`);
			return;
		};

		const requestedUsername = username;
		const avatarPath = GLib.build_filenamev([getDataDir('github'), `avatar-${requestedUsername}.png`]);
		const avatarFile = Gio.File.new_for_path(avatarPath);

		const applyAvatar = () => {
			avatarInitialsLabel.hide();
			const uri = avatarFile.get_uri();
			avatarWidget.set_style(`background-image: url("${uri}"); width: ${avatarSize}px; height: ${avatarSize}px;`);
		};

		if (avatarFile.query_exists(null)) {
			applyAvatar();
		} else {
			avatarInitialsLabel.text = requestedUsername.slice(0, 2).toUpperCase();
			avatarInitialsLabel.show();
			avatarWidget.set_style(`background-color: ${textRgba(0.15)}; width: ${avatarSize}px; height: ${avatarSize}px;`);
		};

		const url = `https://github.com/${encodeURIComponent(requestedUsername)}.png`;
		const message = Soup.Message.new('GET', url);
		session.send_and_read_async(message, GLib.PRIORITY_LOW, state.cancellable, (s, res) => {
			try {
				const bytes = s.send_and_read_finish(res);

				if (state.cancellable.is_cancelled() || requestedUsername !== username) return;
				if (message.get_status() === HTTP_OK) {
					avatarFile.replace_contents_bytes_async(
						bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, state.cancellable,
						(f, res2) => {
							try {
								f.replace_contents_finish(res2);

								if (state.cancellable.is_cancelled() || requestedUsername !== username) return;
								applyAvatar();
							} catch (error) {
								if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
									console.warn(`Could not save GitHub avatar: ${error.message}`);
								};
							};
						}
					);
				};
			} catch (error) {
				if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
					console.debug(`Could not load GitHub avatar: ${error.message}`);
				};
			};
		});
	};

	function updateHeader() {
		usernameLabel.text = username || _('Click to set username');
		loadAvatar();
	};

	const startEdit = () => {
		if (state.editing) return;
		state.editing = true;
		usernameEntry.text = username;
		usernameLabel.hide();
		usernameEntry.show();
		global.stage.set_key_focus(usernameEntry);
	};

	const endEdit = (commit) => {
		if (!state.editing) return;
		state.editing = false;
		const submitted = normalizeUsername(usernameEntry.get_text());
		usernameEntry.hide();
		usernameLabel.show();
		if (global.stage.get_key_focus() === usernameEntry) {
			global.stage.set_key_focus(null);
		};
		if (!commit || submitted === username) return;
		if (!isValidUsername(submitted)) {
			setStatus(_('Invalid GitHub username'));
			return;
		};
		if (settings) {
			settings.set_string('github-username', submitted);
			return;
		};
		username = submitted;
		state.requestGeneration++;
		latestByDate = new Map();
		badgeLabel.text = '';
		lastSyncTime = null;
		if (isLarge) {
			currentStreak = 0;
			longestStreak = 0;
			todayCount = 0;
		};
		saveJsonToFile(dataFilePath, { username });
		updateHeader();
		renderMatrix(new Map());
		if (isLarge) {
			renderStats();
		};
		fetchContributions();
	};

	usernameLabel.connectObject('button-press-event', (_actor, event) => {
		if (event.get_button() !== 1) {
			return Clutter.EVENT_PROPAGATE;
		};
		startEdit();
		return Clutter.EVENT_STOP;
	}, mainBox);

	avatarWidget.connectObject('button-release-event', (_actor, event) => {
		if (event.get_button() !== 1 || !isValidUsername(username)) {
			return Clutter.EVENT_PROPAGATE;
		};

		const url = profileUrlFor(username);
		Gio.AppInfo.launch_default_for_uri_async(url, null, null, (_source, result) => {
			try {
				Gio.AppInfo.launch_default_for_uri_finish(result);
			} catch (error) {
				console.warn(`Could not open GitHub profile: ${error.message}`);
			};
		});
		return Clutter.EVENT_STOP;
	}, mainBox);

	usernameEntry.clutter_text.connectObject('key-press-event', (_actor, event) => {
		const sym = event.get_key_symbol();
		if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
			endEdit(true);
			return Clutter.EVENT_STOP;
		};
		if (sym === Clutter.KEY_Escape) {
			endEdit(false);
			return Clutter.EVENT_STOP;
		};
		return Clutter.EVENT_PROPAGATE;
	}, mainBox);
	usernameEntry.clutter_text.connectObject('key-focus-out', () => endEdit(false), mainBox);

	if (state.timerId) {
    GLib.Source.remove(state.timerId);
    state.timerId = 0
  };

	state.timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL, () => {
		if (state.cancellable.is_cancelled() || mainBox.get_parent() !== body) {
			state.timerId = null;
			return GLib.SOURCE_REMOVE;
		};
		fetchContributions();
		return GLib.SOURCE_CONTINUE;
	});

	mainBox.connectObject('destroy', () => {
		if (state.cancellable.is_cancelled()) return;
		state.requestGeneration++;
		if (state.timerId) {
			GLib.source_remove(state.timerId);
			state.timerId = null;
		};
		gridCanvas.disconnectObject(mainBox);
		usernameLabel.disconnectObject(mainBox);
		avatarWidget.disconnectObject(mainBox);
		usernameEntry.clutter_text.disconnectObject(mainBox);
		state.cancellable.cancel();
		session.abort();
		session = null;
		latestByDate.clear();
		matrixGeometry.cells = [];
		if (global.stage.get_key_focus() === usernameEntry) {
			global.stage.set_key_focus(null);
		};
	}, mainBox);

	const loadContributionsCache = (data) => {
		if (!data || !Array.isArray(data.contributions) || data.username !== username) return;
		const cached = new Map();
		data.contributions.forEach(d => {
			if (d && typeof d.date === 'string') {
				cached.set(d.date, Number(d.count) || 0);
			};
		});
		if (cached.size === 0) return;
		latestByDate = cached;
		renderMatrix(cached);

		const yearKeys = Object.keys(data.total || {});
		const latestYear = yearKeys.length ? yearKeys[yearKeys.length - 1] : null;
		const sumAll = [...cached.values()].reduce((a, b) => a + b, 0);
		const yearTotal = latestYear !== null ? (data.total[latestYear] ?? sumAll) : sumAll;
		badgeLabel.text = _('%s commits').format(formatCount(yearTotal));
		lastSyncTime = null;
		setStatus(isMini ? _('Cached') : _('Cached offline'));

		if (isLarge) {
			computeStats(cached);
			renderStats();
		};
	};

	renderMatrix();
	updateHeader();

	loadJsonFromFileAsync(dataFilePath, (savedData, loadError) => {
		if (state.cancellable.is_cancelled() || mainBox.get_parent() !== body) return;

		if (!settingsUsername && savedData && typeof savedData.username === 'string') {
			const savedUsername = normalizeUsername(savedData.username);

			if (isValidUsername(savedUsername)) {
				username = savedUsername;
				updateHeader();
			};
		};

		if (username) {
			loadContributionsCache(savedData);
			fetchContributions();
		} else if (!loadError) {
			saveJsonToFile(dataFilePath, { username });
		};
	}, state.cancellable);
};
