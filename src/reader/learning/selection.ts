import type { LearningSelection } from '../../utils/language-learning';
import { isSingleWord } from './japanese';

// Reading a learner's transcript selection: the original segment text and the selected word or
// sentence with its surrounding segments as context.

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
