// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from 'vitest';
import { getOriginalSegmentText, getTranscriptLearningSelection } from './selection';
import { createTranscript, selectText } from './test-support';

describe('Transcript learning selection', () => {
	beforeEach(() => {
		document.body.textContent = '';
		window.getSelection()?.removeAllRanges();
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

		const japaneseTexts = ['日本語を勉強します'];
		const japaneseTranscript = createTranscript(japaneseTexts);
		const japaneseText = japaneseTranscript.segments[0]
			.querySelector('.transcript-segment-text')?.firstChild;
		if (!japaneseText) throw new Error('Missing Japanese transcript text');

		selectText(japaneseText, 0, japaneseText, 3);
		expect(getTranscriptLearningSelection(
			document,
			japaneseTranscript.transcript,
			japaneseTranscript.segments,
			japaneseTexts
		)?.kind).toBe('word');

		selectText(japaneseText, 0, japaneseText, japaneseText.textContent?.length || 0);
		expect(getTranscriptLearningSelection(
			document,
			japaneseTranscript.transcript,
			japaneseTranscript.segments,
			japaneseTexts
		)?.kind).toBe('sentence');
	});

	test('reads the stored original text of a segment that shows readings', () => {
		const { segments } = createTranscript(['東京です。']);
		const textElement = segments[0].querySelector('.transcript-segment-text') as HTMLElement;
		textElement.innerHTML = '<span class="transcript-segment-original" data-original-text="東京です。"><ruby><span>東京</span><rt>とうきょう</rt></ruby>です。</span>';
		expect(getOriginalSegmentText(segments[0])).toBe('東京です。');
	});

	test('ignores a selection outside the transcript', () => {
		const { segments, transcript } = createTranscript(['Hello world.']);
		const outside = document.createElement('p');
		outside.textContent = 'Elsewhere';
		document.body.appendChild(outside);
		const textNode = outside.firstChild as Node;
		selectText(textNode, 0, textNode, 4);
		expect(getTranscriptLearningSelection(document, transcript, segments, ['Hello world.'])).toBeNull();
	});
});
