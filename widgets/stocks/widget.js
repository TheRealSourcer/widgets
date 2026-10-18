import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';
import {surfaceStyle, watchSettings} from '../../utils/widget.js';
import {VERTICAL, HORIZONTAL} from '../../compatibility.js';

import {
	getDataDir,
	loadJsonFromFileAsync,
	safeStorageId,
	saveJsonToFile,
} from '../../utils/storage.js';
import {parseCssColor} from '../../utils/colors.js';

export const type = 'stocks';
export const label = 'Stocks';
export const stylesheet = 'widgets/stocks/stylesheet.css';
export const defaultSize = 'medium';
export const supportedSizes = ['small', 'medium', 'large'];

const DEFAULT_SYMBOLS = ['^GSPC', '^IXIC', 'AAPL'];
const REFRESH_SECONDS = 15 * 60;
const REFRESH_MS = REFRESH_SECONDS * 1000;
const HTTP_OK = 200;
const MAX_SYMBOLS = 8;
const decoder = new TextDecoder('utf-8');

function clamp(value, minimum, maximum) {
	return Math.max(minimum, Math.min(maximum, value));
};

function configuredSymbols(settings) {
	let values = DEFAULT_SYMBOLS;

	try {
		const configured = settings?.get_strv('stocks-symbols') ?? [];

		if (configured.length > 0) {
			values = configured;
		};
	} catch (_error) {
	};

	const unique = [];
	const seen = new Set();

	for (const value of values) {
		const symbol = String(value ?? '').trim().toUpperCase();

		if (!symbol || symbol.length > 32 || seen.has(symbol)) {
			continue;
		};

		seen.add(symbol);
		unique.push(symbol);
		if (unique.length === MAX_SYMBOLS) {
			break;
		};
	};

	return unique.length > 0 ? unique : [...DEFAULT_SYMBOLS];
};

function numberOrNull(value) {
	if (value === null || value === undefined || value === '') {
		return null;
	};
	const number = Number(value);

	return Number.isFinite(number) ? number : null;
};

function parseQuote(payload, requestedSymbol) {
	const result = payload?.chart?.result?.[0];
	const meta = result?.meta;
	const rawCloses = result?.indicators?.quote?.[0]?.close;

	if (!meta || !Array.isArray(rawCloses)) {
		throw new Error('Yahoo response did not contain chart data');
	};

	const closes = rawCloses
		.map(numberOrNull)
		.filter(value => value !== null);
	const value = numberOrNull(meta.regularMarketPrice) ?? closes.at(-1) ?? null;
	const previousClose = numberOrNull(meta.chartPreviousClose) ??
		numberOrNull(meta.previousClose) ??
		(closes.length > 1 ? closes.at(-2) : null);

	if (value === null) {
		throw new Error('Yahoo response did not contain a current value');
	};

	if (closes.length === 0 || closes.at(-1) !== value) {
		closes.push(value);
	};

	const change = previousClose === null ? null : value - previousClose;
	const changePercent = previousClose === null || previousClose === 0
		? null
		: change / previousClose * 100;

	return {
		symbol: String(meta.symbol || requestedSymbol),
		name: String(meta.shortName || meta.longName || meta.symbol || requestedSymbol),
		value,
		change,
		changePercent,
		closes: closes.slice(-30),
	};
};

function validCachedQuote(value) {
	return value && typeof value.symbol === 'string' && typeof value.name === 'string' &&
		Number.isFinite(value.value) && Array.isArray(value.closes);
};

function formatValue(value) {
	if (!Number.isFinite(value)) {
		return '—';
	};

	const magnitude = Math.abs(value);
	const maximumFractionDigits = magnitude >= 100 ? 2 : magnitude >= 1 ? 2 : 4;

	return new Intl.NumberFormat(undefined, {
		maximumFractionDigits,
		minimumFractionDigits: magnitude >= 1000 ? 0 : 2,
	}).format(value);
};

function formatChange(change, percent) {
	if (!Number.isFinite(change) || !Number.isFinite(percent)) {
		return '—';
	};

	const sign = change > 0 ? '+' : change < 0 ? '−' : '';
	const absolute = formatValue(Math.abs(change));

	return `${sign}${absolute}  ${sign}${Math.abs(percent).toFixed(2)}%`;
};

function setEllipsize(label) {
	label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
	label.clutter_text.single_line_mode = true;
};

function colorComponents(cssColor) {
	const parsed = parseCssColor(cssColor);

	return [parsed.r, parsed.g, parsed.b, parsed.a ?? 1];
};

function createSparkline(width, height, color) {
	const drawingArea = new St.DrawingArea({
		style_class: 'widget-stocks-sparkline',
		x_expand: false,
		y_align: Clutter.ActorAlign.CENTER,
	});

	drawingArea.set_size(width, height);
	drawingArea._stockValues = [];
	drawingArea._stockColor = colorComponents(color);
	drawingArea.connectObject('repaint', area => {
		const context = area.get_context();
		const [surfaceWidth, surfaceHeight] = area.get_surface_size();
		const values = area._stockValues.filter(Number.isFinite);

		if (values.length > 1 && surfaceWidth > 2 && surfaceHeight > 2) {
			const minimum = Math.min(...values);
			const maximum = Math.max(...values);
			const range = maximum - minimum || 1;
			const inset = 1.5;

			context.setSourceRGBA(...area._stockColor);
			context.setLineWidth(2);
			context.setLineJoin(1);
			context.setLineCap(1);

			values.forEach((value, index) => {
				const x = inset + index / (values.length - 1) * (surfaceWidth - inset * 2);
				const y = inset + (maximum - value) / range * (surfaceHeight - inset * 2);

				if (index === 0) {
					context.moveTo(x, y);
				} else {
					context.lineTo(x, y);
				};
			});
			context.stroke();
		};

		context.$dispose();
	}, drawingArea);

	return drawingArea;
};

function layoutForDimensions(width, height, symbolCount) {
	const contentWidth = Math.max(120, width - 32);
	const contentHeight = Math.max(64, height - 32);
	const headerHeight = clamp(Math.round(contentHeight * 0.14), 18, 28);
	const statusHeight = clamp(Math.round(contentHeight * 0.09), 12, 18);
	const availableRowsHeight = Math.max(32, contentHeight - headerHeight - statusHeight - 10);
	const targetRowHeight = width < 250 ? 34 : 36;
	const visibleRows = clamp(Math.floor(availableRowsHeight / targetRowHeight), 1, symbolCount);
	const rowHeight = Math.max(32, Math.floor(availableRowsHeight / visibleRows));
	const compact = contentWidth < 230;
	const sparkWidth = clamp(Math.round(contentWidth * (compact ? 0.22 : 0.27)), 32, 112);
	const sparkHeight = clamp(Math.round(rowHeight * 0.45), 14, 30);

	return {
		visibleRows,
		rowHeight,
		sparkWidth,
		sparkHeight,
		titleFont: clamp(Math.round(headerHeight * 0.64), 12, 17),
		statusFont: clamp(Math.round(statusHeight * 0.72), 9, 12),
		symbolFont: clamp(Math.round(rowHeight * 0.28), 11, 16),
		nameFont: clamp(Math.round(rowHeight * 0.22), 9, 12),
		valueFont: clamp(Math.round(rowHeight * 0.28), 11, 17),
		changeFont: clamp(Math.round(rowHeight * 0.21), 9, 12),
	};
};

export function style(theme) {
	return surfaceStyle(theme);
};

export function render({body, createLabel, settings, sizeForWidget, theme, widget, refresh}) {
	watchSettings(body, settings, ['stocks-symbols'], refresh);
	const symbols = configuredSymbols(settings);
	const [widgetWidth, widgetHeight] = sizeForWidget ? sizeForWidget(widget) : [394, 190];
	const layout = layoutForDimensions(widgetWidth, widgetHeight, symbols.length);
	const risingColor = '#33d17a';
	const fallingColor = '#f66151';
	const flatColor = theme.muted;
	const cachePath = GLib.build_filenamev([
		getDataDir('stocks'),
		`stocks-${safeStorageId(widget?.id)}.json`,
	]);
	const state = {
		cancellable: new Gio.Cancellable(),
		destroyed: false,
		generation: 0,
		quotes: new Map(),
		timerId: 0,
	};
	const session = new Soup.Session({
		timeout: 20,
		user_agent: 'GNOME-Shell-Stocks-Widget/1.0',
	});
	const rows = new Map();
	const content = new St.BoxLayout({
		...VERTICAL,
		style_class: 'widget-stocks-content',
		x_expand: true,
		y_expand: true,
	});
	const header = new St.BoxLayout({
		...HORIZONTAL,
		style_class: 'widget-stocks-header',
		x_expand: true,
	});
	const title = createLabel(
		label,
		'widget-stocks-title',
		`color: ${theme.text}; font-size: ${layout.titleFont}px;`);
	const status = createLabel(
		'Loading…',
		'widget-stocks-status',
		`color: ${theme.muted}; font-size: ${layout.statusFont}px;`);
	const list = new St.BoxLayout({
		...VERTICAL,
		style_class: 'widget-stocks-list',
		x_expand: true,
		y_expand: true,
	});

	body.set_clip_to_allocation(true);
	title.x_expand = false;
	header.add_child(title);
	header.add_child(new St.Widget({x_expand: true}));
	content.add_child(header);
	content.add_child(list);
	content.add_child(status);
	body.add_child(content);

	for (const symbol of symbols.slice(0, layout.visibleRows)) {
		const row = new St.BoxLayout({
			...HORIZONTAL,
			style_class: 'widget-stocks-row',
			x_expand: true,
			y_expand: true,
			y_align: Clutter.ActorAlign.CENTER,
		});
		const identity = new St.BoxLayout({
			...VERTICAL,
			style_class: 'widget-stocks-identity',
			x_expand: true,
			y_align: Clutter.ActorAlign.CENTER,
		});
		const symbolLabel = createLabel(
			symbol,
			'widget-stocks-symbol',
			`color: ${theme.text}; font-size: ${layout.symbolFont}px;`);
		const nameLabel = createLabel(
			'Waiting for quote',
			'widget-stocks-name',
			`color: ${theme.muted}; font-size: ${layout.nameFont}px;`);
		const sparkline = createSparkline(layout.sparkWidth, layout.sparkHeight, flatColor);
		const valueBox = new St.BoxLayout({
			...VERTICAL,
			style_class: 'widget-stocks-value-box',
			x_align: Clutter.ActorAlign.END,
			y_align: Clutter.ActorAlign.CENTER,
		});
		const valueLabel = createLabel(
			'—',
			'widget-stocks-value',
			`color: ${theme.text}; font-size: ${layout.valueFont}px;`);
		const changeLabel = createLabel(
			'—',
			'widget-stocks-change',
			`color: ${flatColor}; font-size: ${layout.changeFont}px;`);

		setEllipsize(symbolLabel);
		setEllipsize(nameLabel);
		identity.add_child(symbolLabel);
		identity.add_child(nameLabel);
		valueLabel.x_align = Clutter.ActorAlign.END;
		changeLabel.x_align = Clutter.ActorAlign.END;
		valueBox.add_child(valueLabel);
		valueBox.add_child(changeLabel);
		row.add_child(identity);
		row.add_child(sparkline);
		row.add_child(valueBox);
		list.add_child(row);
		rows.set(symbol, {changeLabel, nameLabel, sparkline, symbolLabel, valueLabel});
	};

	function active() {
		return !state.cancellable.is_cancelled() && content.get_parent() === body;
	};

	function trendColor(quote) {
		if (!Number.isFinite(quote?.change) || quote.change === 0) {
			return flatColor;
		};

		return quote.change > 0 ? risingColor : fallingColor;
	};

	function updateRows() {
		for (const [configuredSymbol, actors] of rows) {
			const quote = state.quotes.get(configuredSymbol);

			if (!quote) {
				continue;
			};

			const color = trendColor(quote);
			actors.symbolLabel.text = quote.symbol;
			actors.nameLabel.text = quote.name;
			actors.valueLabel.text = formatValue(quote.value);
			actors.changeLabel.text = formatChange(quote.change, quote.changePercent);
			actors.changeLabel.style = `color: ${color}; font-size: ${layout.changeFont}px;`;
			actors.sparkline._stockValues = quote.closes;
			actors.sparkline._stockColor = colorComponents(color);
			actors.sparkline.queue_repaint();
		};
	};

	function setStatus(text) {
		status.text = text;
	};

	function scheduleRefresh(delaySeconds = REFRESH_SECONDS) {
		if (state.timerId) {
			GLib.source_remove(state.timerId);
		};

		state.timerId = GLib.timeout_add_seconds(
			GLib.PRIORITY_DEFAULT,
			Math.max(1, Math.ceil(delaySeconds)),
			() => {
				state.timerId = 0;
				if (!active()) {
					return GLib.SOURCE_REMOVE;
				};
				fetchQuotes();
				return GLib.SOURCE_REMOVE;
			});
	};

	function finishFetch(generation, received, failures) {
		if (!active() || generation !== state.generation) return;

		for (const [symbol, quote] of received) {
			state.quotes.set(symbol, quote);
		};
		updateRows();

		if (received.size > 0) {
			const updatedAt = Date.now();
			saveJsonToFile(cachePath, {
				updatedAt,
				quotes: Object.fromEntries(state.quotes),
			});
			setStatus(failures > 0 ? 'Updated partially' : `Updated ${new Date(updatedAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`);
		} else {
			setStatus(state.quotes.size > 0 ? 'Offline — showing cached data' : 'Offline — quotes unavailable');
		};
		scheduleRefresh();
	};

	function fetchQuotes() {
		if (!active()) return;

		const generation = ++state.generation;
		const received = new Map();
		let remaining = symbols.length;
		let failures = 0;

		setStatus(state.quotes.size > 0 ? 'Refreshing…' : 'Loading quotes…');

		for (const symbol of symbols) {
			const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
			const message = Soup.Message.new('GET', url);

			session.send_and_read_async(
				message,
				GLib.PRIORITY_DEFAULT,
				state.cancellable,
				(source, result) => {
					try {
						const bytes = source.send_and_read_finish(result);

						if (!active() || generation !== state.generation) return;
						if (message.get_status() !== HTTP_OK) {
							throw new Error(`HTTP ${message.get_status()}`);
						};

						const payload = JSON.parse(decoder.decode(bytes.get_data()));
						received.set(symbol, parseQuote(payload, symbol));
					} catch (error) {
						const cancelled = error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

						if (!cancelled) {
							failures++;
						};
					} finally {
						remaining--;
						if (remaining === 0) {
							finishFetch(generation, received, failures);
						};
					};
        }
      );
		};
	};

	content.connectObject('destroy', () => {
		if (state.destroyed) return;

		state.destroyed = true;
		state.generation++;
		state.cancellable.cancel();
		if (state.timerId) {
			GLib.source_remove(state.timerId);
			state.timerId = 0;
		};
		session.abort();
	}, content);

	loadJsonFromFileAsync(cachePath, cached => {
		if (!active()) return;

		const cachedQuotes = cached?.quotes && typeof cached.quotes === 'object'
			? cached.quotes
			: {};

		for (const symbol of symbols) {
			if (validCachedQuote(cachedQuotes[symbol])) {
				state.quotes.set(symbol, cachedQuotes[symbol]);
			};
		};
		updateRows();

		const updatedAt = Number(cached?.updatedAt);
		const age = Number.isFinite(updatedAt) ? Date.now() - updatedAt : REFRESH_MS;

		if (state.quotes.size > 0 && age < REFRESH_MS) {
			setStatus('Cached — refresh scheduled');
			scheduleRefresh((REFRESH_MS - Math.max(0, age)) / 1000);
		} else {
			fetchQuotes();
		};
	}, state.cancellable);
};
