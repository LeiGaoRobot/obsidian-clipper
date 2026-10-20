import { getMessage } from '../../utils/i18n';
import type { LearningSelection } from '../../utils/language-learning';
import { isSingleWord } from './japanese';

// Reading a learner's transcript selection (the original segment text, and the selected word or
// sentence with its surrounding segments as context) and the trigger that explains it.

export function getOriginalSegmentText(segment: HTMLElement): string {
	const textElement = segment.querySelector('.transcript-segment-text');
	const originalElement = textElement?.querySelector('.transcript-segment-original');
	const storedOriginalText = originalElement?.getAttribute('data-original-text');
	if (storedOriginalText != null) return storedOriginalText;
	if (originalElement) return originalElement.textContent?.trim() || '';
	return (textElement?.firstChild?.textContent || textElement?.textContent || '').trim();
}

export function getTranscriptLearningSelection(
	doc: Document,
	transcript: HTMLElement,
	segments: HTMLElement[],
	originalTexts: string[]
): LearningSelection | null {
	const selection = doc.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
	const text = selection.toString().trim();
	if (!text) return null;
	const range = selection.getRangeAt(0);
	const findSegment = (node: Node): HTMLElement | null => {
		const element = node.nodeType === Node.ELEMENT_NODE
			? node as Element
			: node.parentElement;
		const textElement = element?.closest('.transcript-segment-text');
		const segment = textElement?.closest('.transcript-segment') as HTMLElement | null;
		return segment && transcript.contains(segment) ? segment : null;
	};
	const startSegment = findSegment(range.startContainer);
	const endSegment = findSegment(range.endContainer);
	if (!startSegment || !endSegment) return null;
	const startIndex = segments.indexOf(startSegment);
	const endIndex = segments.indexOf(endSegment);
	if (startIndex < 0 || endIndex < 0) return null;
	const firstIndex = Math.min(startIndex, endIndex);
	const lastIndex = Math.max(startIndex, endIndex);
	return {
		kind: isSingleWord(text) ? 'word' : 'sentence',
		text,
		context: originalTexts.slice(firstIndex, lastIndex + 1).join(' ').trim() || text
	};
}

export interface SelectionTriggerOptions {
	doc: Document;
	transcript: HTMLElement;
	segments: HTMLElement[];
	originalTexts: string[];
	/** Aborted on cleanup; removes the listeners and drops pending timers. */
	signal: AbortSignal;
	cancelPendingSeek: () => void;
	explain: (selection: LearningSelection, returnFocus?: HTMLElement) => unknown;
}

/**
 * The floating Explain with AI button next to a transcript selection, and the double-click shortcut
 * for a word. Both act only on trusted user events.
 */
export function wireSelectionTrigger({
	doc,
	transcript,
	segments,
	originalTexts,
	signal,
	cancelPendingSeek,
	explain
}: SelectionTriggerOptions): HTMLButtonElement {
	const view = doc.defaultView ?? window;
	const button = doc.createElement('button');
	button.type = 'button';
	button.className = 'obsidian-selection-action language-learning-selection-action';
	button.textContent = getMessage('readerExplainWithAi');
	button.style.display = 'none';
	doc.body.appendChild(button);

	let pendingSelection: LearningSelection | null = null;
	let pressedSelection: LearningSelection | null = null;
	button.addEventListener('pointerdown', () => {
		pressedSelection = pendingSelection;
	});
	button.addEventListener('mousedown', event => event.preventDefault());
	const hideButton = () => {
		button.style.display = 'none';
		pendingSelection = null;
	};

	const readSelection = () => getTranscriptLearningSelection(doc, transcript, segments, originalTexts);
	const getSelectionFocusTarget = (): HTMLElement | null => {
		const selectionNode = doc.getSelection()?.anchorNode;
		const selectionElement = selectionNode?.nodeType === 1
			? selectionNode as Element
			: selectionNode?.parentElement;
		const sourceSegment = selectionElement?.closest('.transcript-segment') as HTMLElement | null;
		if (sourceSegment && !sourceSegment.hasAttribute('tabindex')) {
			sourceSegment.setAttribute('tabindex', '-1');
		}
		return sourceSegment;
	};

	const updateButton = () => {
		if (signal.aborted) return;
		const selection = readSelection();
		const browserSelection = doc.getSelection();
		if (!selection || !browserSelection || browserSelection.rangeCount === 0) {
			hideButton();
			return;
		}
		const rects = browserSelection.getRangeAt(0).getClientRects();
		if (rects.length === 0) {
			hideButton();
			return;
		}
		pendingSelection = selection;
		const lastRect = rects[rects.length - 1];
		button.style.display = 'flex';
		const buttonWidth = button.offsetWidth || 110;
		const left = Math.min(lastRect.right + 2, view.innerWidth - buttonWidth - 4);
		button.style.left = `${Math.max(4, left) + view.scrollX}px`;
		button.style.top = `${lastRect.bottom + view.scrollY - 6}px`;
	};

	button.addEventListener('click', async event => {
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		const selection = pendingSelection || pressedSelection;
		pressedSelection = null;
		if (!selection) return;
		const returnFocus = getSelectionFocusTarget();
		hideButton();
		await explain(selection, returnFocus || undefined);
	});

	transcript.addEventListener('dblclick', event => {
		if (!event.isTrusted) return;
		cancelPendingSeek();
		event.stopPropagation();
		view.setTimeout(() => {
			if (signal.aborted) return;
			const selection = readSelection();
			if (!selection || selection.kind !== 'word') return;
			const returnFocus = getSelectionFocusTarget();
			hideButton();
			void explain(selection, returnFocus || undefined);
		}, 0);
	}, { signal });

	transcript.addEventListener('pointerup', () => {
		view.setTimeout(updateButton, 0);
	}, { signal });

	let selectionChangeTimer: number | undefined;
	doc.addEventListener('selectionchange', () => {
		if (selectionChangeTimer) view.clearTimeout(selectionChangeTimer);
		const selection = doc.getSelection();
		if (!selection || selection.isCollapsed) {
			hideButton();
			return;
		}
		selectionChangeTimer = view.setTimeout(updateButton, 200);
	}, { signal });
	signal.addEventListener('abort', () => {
		if (selectionChangeTimer) view.clearTimeout(selectionChangeTimer);
	}, { once: true });

	return button;
}
