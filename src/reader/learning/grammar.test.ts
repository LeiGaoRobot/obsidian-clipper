// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../utils/browser-polyfill', () => ({
	default: { runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) } }
}));

vi.mock('../../utils/i18n', () => ({
	getMessage: (key: string, substitutions?: string | string[]) => substitutions
		? `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
		: key
}));

import {
	cleanupTranscriptLanguageLearning,
	clearTranscriptLanguageLearningCache,
	wireTranscriptLanguageLearning,
	type TranscriptLanguageLearning
} from './index';
import { AiError } from '../../ai/errors';
import type { TranscriptGrammarAnalysis } from '../../utils/language-learning';
import { captureTrustedClicks, createTranscript, flushPromises } from './test-support';

const ANALYSIS: TranscriptGrammarAnalysis = {
	points: [{
		pattern: '〜っていう',
		meaning: 'quoting',
		level: 'N3',
		examples: [{ id: 1, quote: 'できないっていう' }]
	}],
	analyzedLines: 2,
	totalLines: 2
};

function wire(tools: Partial<TranscriptLanguageLearning>, seekToSegment = vi.fn()) {
	const fixture = createTranscript(['パニックにならない', 'できないっていうね']);
	wireTranscriptLanguageLearning({
		doc: document,
		...fixture,
		tools: {
			translateTranscript: vi.fn(),
			explainSelection: vi.fn(),
			annotateJapaneseTranscript: vi.fn(),
			...tools
		},
		responseLanguage: 'English',
		cancelPendingSeek: vi.fn(),
		seekToSegment
	});
	const button = fixture.controls.querySelector<HTMLButtonElement>('.player-learning-grammar');
	if (!button) throw new Error('Missing grammar button');
	return { ...fixture, button, seekToSegment };
}

describe('Reader grammar analysis', () => {
	let clicks: ReturnType<typeof captureTrustedClicks>;

	beforeEach(() => {
		cleanupTranscriptLanguageLearning(document);
		clearTranscriptLanguageLearningCache();
		document.body.textContent = '';
		clicks = captureTrustedClicks();
	});

	afterEach(() => clicks.restore());

	test('is hidden when the runtime offers no grammar analysis', () => {
		const { button } = wire({});
		expect(button.hidden).toBe(true);
	});

	test('runs only after a trusted click and lists the points with their lines', async () => {
		const analyzeTranscriptGrammar = vi.fn().mockResolvedValue(ANALYSIS);
		const { button } = wire({ analyzeTranscriptGrammar });

		button.click();
		await flushPromises();
		expect(analyzeTranscriptGrammar).not.toHaveBeenCalled();

		await clicks.click(button);
		await flushPromises();

		expect(analyzeTranscriptGrammar).toHaveBeenCalledWith(
			[
				{ id: 0, time: '0:00', text: 'パニックにならない' },
				{ id: 1, time: '1:00', text: 'できないっていうね' }
			],
			expect.any(AbortSignal)
		);
		const card = document.querySelector<HTMLElement>('.language-learning-card');
		expect(card?.style.display).toBe('block');
		expect(card?.querySelector('.language-learning-grammar-pattern')?.textContent).toBe('〜っていう N3');
		expect(card?.querySelector('.language-learning-grammar-meaning')?.textContent).toBe('quoting');
		expect(card?.querySelector('.language-learning-grammar-example')?.textContent).toBe('1:00 できないっていう');
		expect(card?.querySelector('.language-learning-grammar-note')).toBeNull();
	});

	test('an example jumps to its line and closes the card', async () => {
		const { button, segments, seekToSegment } = wire({ analyzeTranscriptGrammar: vi.fn().mockResolvedValue(ANALYSIS) });
		segments[1].scrollIntoView = vi.fn();
		await clicks.click(button);
		await flushPromises();
		const example = document.querySelector('.language-learning-grammar-example');

		example?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(seekToSegment).not.toHaveBeenCalled();

		await clicks.click(example);
		expect(seekToSegment).toHaveBeenCalledWith(1);
		expect(segments[1].scrollIntoView).toHaveBeenCalled();
		expect(document.querySelector<HTMLElement>('.language-learning-card')?.style.display).toBe('none');
	});

	test('reuses the analysis of the same lines without another request', async () => {
		const analyzeTranscriptGrammar = vi.fn().mockResolvedValue(ANALYSIS);
		const { button } = wire({ analyzeTranscriptGrammar });
		await clicks.click(button);
		await flushPromises();
		await clicks.click(document.querySelector('.language-learning-card-close'));

		await clicks.click(button);
		await flushPromises();

		expect(analyzeTranscriptGrammar).toHaveBeenCalledTimes(1);
		expect(document.querySelector<HTMLElement>('.language-learning-card')?.style.display).toBe('block');
	});

	test('says when a long range was analyzed only from its start', async () => {
		const { button } = wire({
			analyzeTranscriptGrammar: vi.fn().mockResolvedValue({ ...ANALYSIS, analyzedLines: 1, totalLines: 2 })
		});
		await clicks.click(button);
		await flushPromises();

		expect(document.querySelector('.language-learning-grammar-note')?.textContent).toBe('readerGrammarTruncated:1,2');
	});

	test('a failed analysis shows the error card, and Retry sends the same lines', async () => {
		const analyzeTranscriptGrammar = vi.fn()
			.mockRejectedValueOnce(new AiError('bad-response', { task: 'explain' }))
			.mockResolvedValueOnce(ANALYSIS);
		const { button } = wire({ analyzeTranscriptGrammar });
		await clicks.click(button);
		await flushPromises();

		const card = document.querySelector<HTMLElement>('.language-learning-card');
		expect(card?.classList.contains('is-error')).toBe(true);
		await clicks.click(card?.querySelector('.ai-error-card-action[data-action="retry"]') ?? null);
		await flushPromises();

		expect(analyzeTranscriptGrammar).toHaveBeenCalledTimes(2);
		expect(analyzeTranscriptGrammar.mock.calls[1][0]).toEqual(analyzeTranscriptGrammar.mock.calls[0][0]);
		expect(card?.querySelector('.language-learning-grammar-pattern')).not.toBeNull();
	});

	test('the task bar Cancel stops a running analysis, and its late result shows nothing', async () => {
		let resolve: (analysis: TranscriptGrammarAnalysis) => void = () => {};
		const analyzeTranscriptGrammar = vi.fn(() => new Promise<TranscriptGrammarAnalysis>(done => { resolve = done; }));
		const { button } = wire({ analyzeTranscriptGrammar });
		await clicks.click(button);
		await flushPromises();
		expect(button.getAttribute('aria-busy')).toBe('true');

		await clicks.click(document.querySelector('.player-learning-cancel'));
		resolve(ANALYSIS);
		await flushPromises();

		expect(button.hasAttribute('aria-busy')).toBe(false);
		expect(document.querySelector('.language-learning-grammar')).toBeNull();
	});
});
