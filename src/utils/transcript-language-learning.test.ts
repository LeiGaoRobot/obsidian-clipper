// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./i18n', () => ({
	getMessage: (key: string) => key
}));

import { wireTranscriptLanguageLearning } from './transcript-language-learning';

function createTranscript() {
	document.body.innerHTML = `
		<div class="player-toggle-group"></div>
		<div class="youtube transcript">
			<div class="transcript-segment">
				<div class="transcript-segment-text">Hello world.</div>
			</div>
		</div>
	`;
	return {
		controls: document.querySelector('.player-toggle-group') as HTMLElement,
		transcript: document.querySelector('.youtube.transcript') as HTMLElement,
		segments: Array.from(document.querySelectorAll('.transcript-segment')) as HTMLElement[]
	};
}

describe('Transcript language learning controls', () => {
	beforeEach(() => {
		document.body.textContent = '';
		window.getSelection()?.removeAllRanges();
	});

	test('adds aligned translations only after the bilingual button is clicked', async () => {
		const { controls, transcript, segments } = createTranscript();
		const translateTranscript = vi.fn().mockResolvedValue(['你好，世界。']);
		wireTranscriptLanguageLearning({
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
		(controls.querySelector('.player-learning-action') as HTMLButtonElement).click();

		await vi.waitFor(() => {
			expect(segments[0].querySelector('.transcript-segment-translation')?.textContent)
				.toBe('你好，世界。');
		});
		expect(translateTranscript).toHaveBeenCalledWith(['Hello world.']);
		expect(transcript.classList.contains('show-bilingual-transcript')).toBe(true);
	});

	test('double-clicking a word asks AI for a contextual word explanation', async () => {
		const { controls, transcript, segments } = createTranscript();
		const explainSelection = vi.fn().mockResolvedValue('hello: a greeting');
		const cancelPendingSeek = vi.fn();
		wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection
			},
			cancelPendingSeek
		});

		const textNode = segments[0].querySelector('.transcript-segment-text')?.firstChild;
		if (!textNode) throw new Error('Missing transcript text');
		const range = document.createRange();
		range.setStart(textNode, 0);
		range.setEnd(textNode, 5);
		window.getSelection()?.addRange(range);
		transcript.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

		await vi.waitFor(() => {
			expect(explainSelection).toHaveBeenCalledWith({
				kind: 'word',
				text: 'Hello',
				context: 'Hello world.'
			});
		});
		expect(cancelPendingSeek).toHaveBeenCalledOnce();
	});
});
