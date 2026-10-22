import Clutter from 'gi://Clutter';

export function nextCardIndex(cards, rows, card, symbol) {
	const current = cards.indexOf(card);
	if (symbol === Clutter.KEY_Left) {
		return current - 1;
	};
	if (symbol === Clutter.KEY_Right) {
		return current + 1;
	};
	if (symbol !== Clutter.KEY_Up && symbol !== Clutter.KEY_Down) {
		return null;
	};
	const rowIndex = rows.findIndex(row => row.includes(card));
	if (rowIndex < 0) {
		return -1;
	};
	const column = rows[rowIndex].indexOf(card);
	const row = rows[rowIndex + (symbol === Clutter.KEY_Up ? -1 : 1)];
	return row ? cards.indexOf(row[Math.min(column, row.length - 1)]) : -1;
};

export function ensureVisible(scrollView, content, actor) {
	const [actorX, actorY] = actor.get_transformed_position();
	const [width, height] = actor.get_transformed_size();
	const [contentX, contentY] = content.get_transformed_position();
	const [contentWidth, contentHeight] = content.get_transformed_size();
	const scaleX = contentWidth / content.width;
	const scaleY = contentHeight / content.height;
	if (scaleX <= 0 || scaleY <= 0 || !Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return;

	const reveal = (adjustment, start, end) => {
		const {value, lower, upper, page_size: pageSize} = adjustment;
		let target = value;
		if (start < value) {
			target = start;
		} else if (end > value + pageSize) {
			target = Math.min(start, end - pageSize);
		};
		adjustment.value = Math.max(lower, Math.min(target, Math.max(lower, upper - pageSize)));
	};

	const horizontal = 'get_hadjustment' in scrollView
		? scrollView.get_hadjustment()
		: scrollView.get_hscroll_bar().get_adjustment();
	const vertical = 'get_vadjustment' in scrollView
		? scrollView.get_vadjustment()
		: scrollView.get_vscroll_bar().get_adjustment();
	reveal(horizontal, (actorX - contentX) / scaleX, (actorX + width - contentX) / scaleX);
	reveal(vertical, (actorY - contentY) / scaleY, (actorY + height - contentY) / scaleY);
};
