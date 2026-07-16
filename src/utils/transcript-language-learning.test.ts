// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./i18n', () => ({
	getMessage: (key: string) => key
}));

import {
	cleanupTranscriptLanguageLearning,
	getTranscriptLearningSelection,
	wireTranscriptLanguageLearning
} from './transcript-language-learning';

function createTranscript(texts = ['Hello world.']) {
	document.body.innerHTML = `
		<div class="player-toggle-group"></div>
		<div class="youtube transcript">
			${texts.map(text => `
				<div class="transcript-segment">
					<div class="transcript-segment-text">${text}</div>
				</div>
			`).join('')}
		</div>
	`;
	return {
		controls: document.querySelector('.player-toggle-group') as HTMLElement,
		transcript: document.querySelector('.youtube.transcript') as HTMLElement,
		segments: Array.from(document.querySelectorAll('.transcript-segment')) as HTMLElement[]
	};
}

function selectText(startNode: Node, start: number, endNode: Node, end: number) {
	const range = document.createRange();
	range.setStart(startNode, start);
	range.setEnd(endNode, end);
	window.getSelection()?.removeAllRanges();
	window.getSelection()?.addRange(range);
}

describe('Transcript language learning controls', () => {
	beforeEach(() => {
		cleanupTranscriptLanguageLearning(document);
		document.body.textContent = '';
		window.getSelection()?.removeAllRanges();
	});

	test('adds aligned translations only after an explicit bilingual action', async () => {
		const { controls, transcript, segments } = createTranscript();
		const translateTranscript = vi.fn().mockResolvedValue(['你好，世界。']);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript,
				explainSelection: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});

		expect(translateTranscript).not.toHaveBeenCalled();
		await controller.toggleBilingual();

		expect(segments[0].querySelector('.transcript-segment-translation')?.textContent)
			.toBe('你好，世界。');
		expect(translateTranscript).toHaveBeenCalledWith(['Hello world.']);
		expect(transcript.classList.contains('show-bilingual-transcript')).toBe(true);
	});

	test('rejects incomplete translations and allows a complete retry', async () => {
		const { controls, transcript, segments } = createTranscript();
		const translateTranscript = vi.fn()
			.mockResolvedValueOnce([''])
			.mockResolvedValueOnce(['你好，世界。']);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: { translateTranscript, explainSelection: vi.fn() },
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleBilingual();
		expect(segments[0].querySelector('.transcript-segment-translation')).toBeNull();
		expect(document.querySelector('.language-learning-card-body')?.textContent)
			.toBe('readerTranslationIncomplete');

		await controller.toggleBilingual();
		expect(segments[0].querySelector('.transcript-segment-translation')?.textContent)
			.toBe('你好，世界。');
		expect(translateTranscript).toHaveBeenCalledTimes(2);
	});

	test('builds contextual word and multi-segment sentence selections', () => {
		const texts = ['Hello world.', 'How are you?'];
		const { transcript, segments } = createTranscript(texts);
		const firstText = segments[0].querySelector('.transcript-segment-text')?.firstChild;
		const secondText = segments[1].querySelector('.transcript-segment-text')?.firstChild;
		if (!firstText || !secondText) throw new Error('Missing transcript text');

		selectText(firstText, 0, firstText, 5);
		expect(getTranscriptLearningSelection(document, transcript, segments, texts)).toEqual({
			kind: 'word',
			text: 'Hello',
			context: 'Hello world.'
		});

		selectText(firstText, 0, secondText, secondText.textContent?.length || 0);
		const sentence = getTranscriptLearningSelection(document, transcript, segments, texts);
		expect(sentence?.kind).toBe('sentence');
		expect(sentence?.context).toBe('Hello world. How are you?');
	});

	test('caches repeated explanations for the same selection and context', async () => {
		const { controls, transcript, segments } = createTranscript();
		const explainSelection = vi.fn().mockResolvedValue('hello: a greeting');
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: { translateTranscript: vi.fn(), explainSelection },
			cancelPendingSeek: vi.fn()
		});
		const selection = { kind: 'word' as const, text: 'Hello', context: 'Hello world.' };

		await controller.explain(selection);
		await controller.explain(selection);

		expect(explainSelection).toHaveBeenCalledOnce();
		expect(document.querySelector('.language-learning-card-body')?.textContent)
			.toBe('hello: a greeting');
	});

	test('ignores synthetic page events that could trigger paid AI requests', async () => {
		const { controls, transcript, segments } = createTranscript();
		const translateTranscript = vi.fn();
		const explainSelection = vi.fn();
		wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: { translateTranscript, explainSelection },
			cancelPendingSeek: vi.fn()
		});
		const textNode = segments[0].querySelector('.transcript-segment-text')?.firstChild;
		if (!textNode) throw new Error('Missing transcript text');
		selectText(textNode, 0, textNode, 5);

		(controls.querySelector('.player-learning-action') as HTMLButtonElement).click();
		transcript.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await new Promise(resolve => window.setTimeout(resolve, 0));

		expect(translateTranscript).not.toHaveBeenCalled();
		expect(explainSelection).not.toHaveBeenCalled();
	});

	test('cleanup removes learning UI left by a previous transcript', () => {
		const { controls, transcript, segments } = createTranscript();
		wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: { translateTranscript: vi.fn(), explainSelection: vi.fn() },
			cancelPendingSeek: vi.fn()
		});

		cleanupTranscriptLanguageLearning(document);

		expect(document.querySelector('.language-learning-card')).toBeNull();
		expect(document.querySelector('.language-learning-selection-action')).toBeNull();
	});
});
