import type { TranscriptLayoutMode } from '../types/types';

export const TRANSCRIPT_LAYOUT_MODES: readonly TranscriptLayoutMode[] = ['reading', 'notebook', 'focus'];
const TRANSCRIPT_LAYOUT_CLASSES = TRANSCRIPT_LAYOUT_MODES.map(mode => `transcript-layout-${mode}`);

export function clearTranscriptLayoutMode(doc: Document): void {
	doc.documentElement.classList.remove(...TRANSCRIPT_LAYOUT_CLASSES);
}

export function normalizeTranscriptLayoutMode(value: unknown): TranscriptLayoutMode {
	return typeof value === 'string' && TRANSCRIPT_LAYOUT_MODES.includes(value as TranscriptLayoutMode)
		? value as TranscriptLayoutMode
		: 'reading';
}

export function updateTranscriptPlayerHeight(root: HTMLElement, player: HTMLElement): void {
	root.style.setProperty(
		'--transcript-player-height',
		`${Math.ceil(player.getBoundingClientRect().height)}px`
	);
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
	if (details.open && isMobile) root.appendChild(panel);
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
