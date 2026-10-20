import type { TranscriptLayoutMode } from '../types/types';

export const TRANSCRIPT_LAYOUT_MODES: readonly TranscriptLayoutMode[] = ['reading', 'notebook', 'focus'];
const TRANSCRIPT_LAYOUT_CLASSES = TRANSCRIPT_LAYOUT_MODES.map(mode => `transcript-layout-${mode}`);

export function clearTranscriptLayoutMode(doc: Document): void {
	doc.documentElement.classList.remove(...TRANSCRIPT_LAYOUT_CLASSES);
	doc.documentElement.style.removeProperty('--transcript-scrollbar-width');
}

/**
 * Publishes the width of the page's vertical scrollbar, which `100vw` includes, so the Study tools
 * and Split view widths (transcripts.scss) fit the viewport without a horizontal scrollbar.
 */
export function updateTranscriptScrollbarWidth(doc: Document): void {
	const view = doc.defaultView;
	if (!view) return;
	const width = Math.max(0, view.innerWidth - doc.documentElement.clientWidth);
	doc.documentElement.style.setProperty('--transcript-scrollbar-width', `${width}px`);
}

export function normalizeTranscriptLayoutMode(value: unknown): TranscriptLayoutMode {
	return typeof value === 'string' && TRANSCRIPT_LAYOUT_MODES.includes(value as TranscriptLayoutMode)
		? value as TranscriptLayoutMode
		: 'reading';
}

/**
 * Publishes the player's height and, when given, the controls' height on `root`, so sticky offsets
 * and the segments' `scroll-margin-top` clear what is pinned above the transcript.
 */
export function updateTranscriptPlayerHeight(root: HTMLElement, player: HTMLElement, controls?: HTMLElement): void {
	root.style.setProperty(
		'--transcript-player-height',
		`${Math.ceil(player.getBoundingClientRect().height)}px`
	);
	if (controls) {
		root.style.setProperty(
			'--transcript-controls-height',
			`${Math.ceil(controls.getBoundingClientRect().height)}px`
		);
	}
}

/** The toolbar's fallbacks, from the roomiest to the tightest (transcripts.scss). */
const TOOLBAR_LAYOUT_CLASSES = [
	'is-short-labels',
	'is-task-compact',
	'is-task-minimal',
	'is-task-tight',
	'is-task-row',
	'is-controls-stacked'
] as const;
type ToolbarLayoutClass = typeof TOOLBAR_LAYOUT_CLASSES[number];

/** Distinct rows among `rects`: a rect starts a row when it lies below the current one. */
function countRows(rects: DOMRect[]): number {
	let rows = 0;
	let rowBottom = -Infinity;
	[...rects].sort((a, b) => a.top - b.top).forEach(rect => {
		if (rect.top >= rowBottom - 1) {
			rows++;
			rowBottom = rect.bottom;
		} else {
			rowBottom = Math.max(rowBottom, rect.bottom);
		}
	});
	return rows;
}

/**
 * Fits the transcript toolbar into one row: the layout switcher, the feature toggles, the progress
 * pill while a task runs, and More. When they do not fit, it steps through the fallbacks until they
 * do: short labels, then the pill without its engine, then without its progress bar, then with
 * only the segment count and Cancel, then the pill on a row of its own, and last two rows of controls (the switcher and More, then the toggles) with
 * the pill below. Measured on the real labels, so it holds in every language and never leaves More
 * alone on a line. A toolbar laid out as a column (the Study tools rail) gets no fallback, and one
 * that is not laid out (hidden, or a test document) keeps what it had.
 */
export function syncTranscriptToolbarLayout(toolbar: HTMLElement): void {
	const view = toolbar.ownerDocument.defaultView;
	if (!view) return;
	const previous = TOOLBAR_LAYOUT_CLASSES.filter(name => toolbar.classList.contains(name));
	const apply = (classes: readonly ToolbarLayoutClass[]) => {
		TOOLBAR_LAYOUT_CLASSES.forEach(name => toolbar.classList.toggle(name, classes.includes(name)));
	};
	apply([]);
	const toolbarRect = toolbar.getBoundingClientRect();
	if (toolbarRect.width === 0 || toolbarRect.height === 0) {
		apply(previous);
		return;
	}
	if (view.getComputedStyle(toolbar).flexDirection.startsWith('column')) return;

	const switcher = toolbar.querySelector<HTMLElement>(':scope > .transcript-layout-switcher');
	const pill = toolbar.querySelector<HTMLElement>(':scope > .player-learning-task');
	const running = Boolean(pill && !pill.hidden);
	const rowItems = Array.from(toolbar.querySelectorAll<HTMLElement>([
		':scope > .transcript-layout-switcher',
		':scope > .player-controls-divider',
		':scope > .player-primary-actions',
		':scope > .player-learning-task',
		':scope > .player-controls-more > summary'
	].join(', ')));
	const innerItems = Array.from(toolbar.querySelectorAll<HTMLElement>(
		':scope > .player-primary-actions > *, :scope > .player-learning-task > *'
	));
	const fits = (expectedRows: number) => {
		const style = view.getComputedStyle(toolbar);
		const bounds = toolbar.getBoundingClientRect();
		const left = bounds.left + (parseFloat(style.paddingLeft) || 0) - 1;
		const right = bounds.right - (parseFloat(style.paddingRight) || 0) + 1;
		const laidOut = (rect: DOMRect) => rect.width > 0 && rect.height > 0;
		const rows = rowItems.map(item => item.getBoundingClientRect()).filter(laidOut);
		if (!switcher || countRows(rows) > expectedRows) return false;
		return [...rows, ...innerItems.map(item => item.getBoundingClientRect()).filter(laidOut)]
			.every(rect => rect.left >= left && rect.right <= right);
	};

	const steps: Array<[readonly ToolbarLayoutClass[], number]> = running
		? [
			[[], 1],
			[['is-short-labels'], 1],
			[['is-short-labels', 'is-task-compact'], 1],
			[['is-short-labels', 'is-task-minimal'], 1],
			[['is-short-labels', 'is-task-tight'], 1],
			[['is-short-labels', 'is-task-row'], 2],
			[['is-short-labels', 'is-controls-stacked'], 3]
		]
		: [
			[[], 1],
			[['is-short-labels'], 1],
			[['is-short-labels', 'is-controls-stacked'], 2]
		];
	for (const [classes, expectedRows] of steps) {
		apply(classes);
		if (fits(expectedRows)) return;
	}
}

interface TranscriptControlsPanelOptions {
	doc: Document;
	root: HTMLElement;
	details: HTMLDetailsElement;
	panel: HTMLElement;
	controls: HTMLElement;
	isMobile: boolean;
}

export function syncTranscriptControlsPanel({
	doc,
	root,
	details,
	panel,
	controls,
	isMobile
}: TranscriptControlsPanelOptions): void {
	// Open on a phone, the panel is a sheet over the page; open elsewhere, it is the toolbar's last
	// row, so More stays where it is; closed, it goes back into More.
	if (details.open && isMobile) root.appendChild(panel);
	else if (details.open && details.parentElement === controls) controls.appendChild(panel);
	else details.appendChild(panel);
	root.classList.toggle('is-controls-open', details.open);
	details.querySelector('summary')?.setAttribute('aria-expanded', String(details.open));
	if (!details.open || !isMobile) return;

	const activeSegment = root.querySelector<HTMLElement>('.transcript-segment.is-active');
	if (!activeSegment) return;

	activeSegment.scrollIntoView({ block: 'center' });
	const view = doc.defaultView;
	if (!view) return;

	const activeRect = activeSegment.getBoundingClientRect();
	const visibleTop = controls.getBoundingClientRect().bottom + 12;
	const visibleBottom = panel.getBoundingClientRect().top - 12;
	const adjustment = activeRect.top < visibleTop
		? activeRect.top - visibleTop
		: activeRect.bottom > visibleBottom
			? activeRect.bottom - visibleBottom
			: 0;
	if (adjustment !== 0) {
		view.scrollBy({ behavior: 'auto', top: Math.round(adjustment) });
	}
}

interface TranscriptLayoutSwitcherOptions {
	doc: Document;
	root: HTMLElement;
	initialMode: TranscriptLayoutMode;
	groupLabel: string;
	labels: Record<TranscriptLayoutMode, string>;
	/** Shown instead of `labels` when the toolbar is short of space (`is-short-labels`). */
	shortLabels?: Partial<Record<TranscriptLayoutMode, string>>;
	onChange?: (mode: TranscriptLayoutMode) => void;
}

export interface TranscriptLayoutSwitcher {
	element: HTMLElement;
	getMode: () => TranscriptLayoutMode;
	setMode: (mode: TranscriptLayoutMode) => void;
}

export function createTranscriptLayoutSwitcher({
	doc,
	root,
	initialMode,
	groupLabel,
	labels,
	shortLabels,
	onChange
}: TranscriptLayoutSwitcherOptions): TranscriptLayoutSwitcher {
	const element = doc.createElement('div');
	element.className = 'transcript-layout-switcher';
	element.setAttribute('role', 'group');
	element.setAttribute('aria-label', groupLabel);

	let currentMode = normalizeTranscriptLayoutMode(initialMode);
	const buttons = new Map<TranscriptLayoutMode, HTMLButtonElement>();

	const applyMode = (mode: TranscriptLayoutMode) => {
		root.classList.remove(...TRANSCRIPT_LAYOUT_CLASSES);
		root.classList.add(`transcript-layout-${mode}`);
		root.dataset.transcriptLayout = mode;
		clearTranscriptLayoutMode(doc);
		doc.documentElement.classList.add(`transcript-layout-${mode}`);
		buttons.forEach((button, buttonMode) => {
			button.setAttribute('aria-pressed', String(buttonMode === mode));
		});
		currentMode = mode;
	};

	TRANSCRIPT_LAYOUT_MODES.forEach(mode => {
		const button = doc.createElement('button');
		button.type = 'button';
		button.className = 'transcript-layout-option';
		button.dataset.transcriptLayout = mode;
		button.textContent = labels[mode];
		button.title = labels[mode];
		const shortLabel = shortLabels?.[mode];
		if (shortLabel && shortLabel !== labels[mode]) button.dataset.shortLabel = shortLabel;
		button.addEventListener('click', () => {
			if (mode === currentMode) return;
			applyMode(mode);
			onChange?.(mode);
		});
		buttons.set(mode, button);
		element.appendChild(button);
	});

	applyMode(currentMode);

	return {
		element,
		getMode: () => currentMode,
		setMode: applyMode
	};
}
