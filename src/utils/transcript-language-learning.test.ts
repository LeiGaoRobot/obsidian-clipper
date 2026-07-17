// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./i18n', () => ({
	getMessage: (key: string, substitutions?: string | string[]) => substitutions
		? `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
		: key
}));

import {
	cleanupTranscriptLanguageLearning,
	clearTranscriptLanguageLearningCache,
	getTranscriptLearningSelection,
	wireTranscriptLanguageLearning
} from './transcript-language-learning';
import { RequestCancelledError } from './request-cancellation';

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
		clearTranscriptLanguageLearningCache();
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
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});

		expect(translateTranscript).not.toHaveBeenCalled();
		await controller.toggleBilingual();

		expect(segments[0].querySelector('.transcript-segment-translation')?.textContent)
			.toBe('你好，世界。');
		expect(translateTranscript).toHaveBeenCalledWith(
			['Hello world.'],
			expect.any(Function),
			expect.any(AbortSignal)
		);
		expect(transcript.classList.contains('show-bilingual-transcript')).toBe(true);
	});

	test('adds Japanese readings only after an explicit reading action', async () => {
		const { controls, transcript, segments } = createTranscript(['私は日本語を勉強します。']);
		const annotateJapaneseTranscript = vi.fn().mockResolvedValue([[
			{ text: '私', reading: 'わたし' },
			{ text: 'は', reading: '' },
			{ text: '日本語', reading: 'にほんご' },
			{ text: 'を', reading: '' },
			{ text: '勉強', reading: 'べんきょう' },
			{ text: 'します。', reading: '' }
		]]);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript
			},
			cancelPendingSeek: vi.fn()
		});

		const readingButton = controls.querySelector('.player-learning-readings') as HTMLButtonElement;
		expect(readingButton.hidden).toBe(false);
		expect(annotateJapaneseTranscript).not.toHaveBeenCalled();

		await controller.toggleJapaneseReadings();

		expect(annotateJapaneseTranscript).toHaveBeenCalledWith(
			['私は日本語を勉強します。'],
			expect.any(Function),
			expect.any(AbortSignal)
		);
		expect(transcript.classList.contains('show-japanese-readings')).toBe(true);
		expect(transcript.querySelector('ruby rt')?.textContent).toBe('わたし');
		expect(transcript.querySelectorAll('ruby')).toHaveLength(3);

		await controller.toggleJapaneseReadings();
		expect(transcript.classList.contains('show-japanese-readings')).toBe(false);

		const secondAnnotateJapaneseTranscript = vi.fn().mockResolvedValue([[
			{ text: '私', reading: 'わたし' },
			{ text: 'は', reading: '' },
			{ text: '日本語', reading: 'にほんご' },
			{ text: 'を', reading: '' },
			{ text: '勉強', reading: 'べんきょう' },
			{ text: 'します。', reading: '' }
		]]);
		const secondController = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: secondAnnotateJapaneseTranscript
			},
			cancelPendingSeek: vi.fn()
		});
		await secondController.toggleJapaneseReadings();
		expect(secondAnnotateJapaneseTranscript).not.toHaveBeenCalled();
		expect(transcript.querySelector('ruby rt')?.textContent).toBe('わたし');
	});

	test('shows progress while generating readings in multiple batches', async () => {
		const { controls, transcript, segments } = createTranscript(['私は日本語を勉強します。']);
		let readingButton: HTMLButtonElement;
		const progressLabels: string[] = [];
		const annotateJapaneseTranscript = vi.fn(async (
			_segments: string[],
			onProgress?: (progress: { completed: number; total: number }) => void
		) => {
			onProgress?.({ completed: 0, total: 2 });
			progressLabels.push(readingButton.textContent || '');
			onProgress?.({ completed: 1, total: 2 });
			progressLabels.push(readingButton.textContent || '');
			return [[
				{ text: '私', reading: 'わたし' },
				{ text: 'は', reading: '' },
				{ text: '日本語', reading: 'にほんご' },
				{ text: 'を', reading: '' },
				{ text: '勉強', reading: 'べんきょう' },
				{ text: 'します。', reading: '' }
			]];
		});
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript
			},
			cancelPendingSeek: vi.fn()
		});
		readingButton = controls.querySelector('.player-learning-readings') as HTMLButtonElement;

		await controller.toggleJapaneseReadings();

		expect(progressLabels).toEqual([
			'readerJapaneseReadingsProgress:0,2',
			'readerJapaneseReadingsProgress:1,2'
		]);
	});

	test('caches completed translations across Reader rewiring and reports progress', async () => {
		const first = createTranscript(['Hello world.']);
		const progressLabels: string[] = [];
		const translateTranscript = vi.fn(async (
			_segments: string[],
			onProgress?: (progress: { completed: number; total: number }) => void
		) => {
			onProgress?.({ completed: 0, total: 1 });
			progressLabels.push(first.controls.querySelector('.player-learning-progress')?.textContent || '');
			onProgress?.({ completed: 1, total: 1 });
			return ['你好，世界。'];
		});
		const firstController = wireTranscriptLanguageLearning({
			doc: document,
			transcript: first.transcript,
			segments: first.segments,
			controls: first.controls,
			responseLanguage: 'Simplified Chinese',
			tools: {
				translateTranscript,
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});
		await firstController.toggleBilingual();
		expect(progressLabels).toEqual(['readerTranslationProgress:0,1']);

		const second = createTranscript(['Hello world.']);
		const secondTranslate = vi.fn();
		const secondController = wireTranscriptLanguageLearning({
			doc: document,
			transcript: second.transcript,
			segments: second.segments,
			controls: second.controls,
			responseLanguage: 'Simplified Chinese',
			tools: {
				translateTranscript: secondTranslate,
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});
		await secondController.toggleBilingual();

		expect(secondTranslate).not.toHaveBeenCalled();
		expect(second.segments[0].querySelector('.transcript-segment-translation')?.textContent)
			.toBe('你好，世界。');
	});

	test('cancels an in-flight translation without showing an error card', async () => {
		const { controls, transcript, segments } = createTranscript();
		const translateTranscript = vi.fn((_segments: string[], _onProgress?: unknown, signal?: AbortSignal) => new Promise<string[]>((_, reject) => {
			signal?.addEventListener('abort', () => reject(new RequestCancelledError()), { once: true });
		}));
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript,
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});

		const request = controller.toggleBilingual();
		controller.cancelActiveRequest();
		await request;

		expect((document.querySelector('.language-learning-card') as HTMLElement).style.display).toBe('none');
		expect(controls.querySelector('.player-learning-progress')?.textContent)
			.toBe('readerAiCancelled');
	});

	test('allows reading corrections and reuses them after Reader rewiring', async () => {
		const { controls, transcript, segments } = createTranscript(['私は日本語を勉強します。']);
		const readings = [[
			{ text: '私', reading: 'わたし' },
			{ text: 'は', reading: '' },
			{ text: '日本語', reading: 'にほんご' },
			{ text: 'を', reading: '' },
			{ text: '勉強', reading: 'べんきょう' },
			{ text: 'します。', reading: '' }
		]];
		const annotateJapaneseTranscript = vi.fn().mockResolvedValue(readings);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleJapaneseReadings();
		const editButton = controls.querySelector('.player-learning-readings-edit') as HTMLButtonElement;
		expect(editButton.hidden).toBe(false);
		editButton.click();
		const firstReading = transcript.querySelector('ruby rt') as HTMLElement;
		expect(firstReading.getAttribute('contenteditable')).toBe('true');
		expect(firstReading.getAttribute('role')).toBe('textbox');
		expect(firstReading.getAttribute('aria-label')).toBe('readerReadingEditLabel:私');
		expect(firstReading.getAttribute('tabindex')).toBe('0');
		firstReading.textContent = 'ワタシ';
		firstReading.dispatchEvent(new Event('input', { bubbles: true }));
		editButton.click();
		expect(transcript.querySelector('ruby rt')?.getAttribute('contenteditable')).toBe('false');
		expect(transcript.querySelector('ruby rt')?.textContent).toBe('ワタシ');

		const secondAnnotateJapaneseTranscript = vi.fn();
		const secondController = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: secondAnnotateJapaneseTranscript
			},
			cancelPendingSeek: vi.fn()
		});
		await secondController.toggleJapaneseReadings();

		expect(secondAnnotateJapaneseTranscript).not.toHaveBeenCalled();
		expect(transcript.querySelector('ruby rt')?.textContent).toBe('ワタシ');
	});

	test('regenerates readings only after an explicit controller action', async () => {
		const { controls, transcript, segments } = createTranscript(['日本語を勉強します。']);
		const readings = [[
			{ text: '日本語', reading: 'にほんご' },
			{ text: 'を', reading: '' },
			{ text: '勉強', reading: 'べんきょう' },
			{ text: 'します。', reading: '' }
		]];
		const regenerated = [[
			{ text: '日本語', reading: 'にほんご' },
			{ text: 'を', reading: '' },
			{ text: '勉強', reading: 'べんきょう' },
			{ text: 'します。', reading: '' }
		]];
		const annotateJapaneseTranscript = vi.fn()
			.mockResolvedValueOnce(readings)
			.mockResolvedValueOnce(regenerated);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleJapaneseReadings();
		await controller.regenerateJapaneseReadings();

		expect(annotateJapaneseTranscript).toHaveBeenCalledTimes(2);
		expect(transcript.querySelector('ruby rt')?.textContent).toBe('にほんご');
	});

	test('rejects incomplete Japanese readings and allows a retry', async () => {
		const { controls, transcript, segments } = createTranscript(['日本語を勉強します。']);
		const annotateJapaneseTranscript = vi.fn()
			.mockResolvedValueOnce([[]])
			.mockResolvedValueOnce([[
				{ text: '日本語', reading: 'にほんご' },
				{ text: 'を', reading: '' },
				{ text: '勉強', reading: 'べんきょう' },
				{ text: 'します。', reading: '' }
			]]);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleJapaneseReadings();
		expect(document.querySelector('.language-learning-card-body')?.textContent)
			.toBe('readerReadingIncomplete');
		expect(transcript.querySelector('ruby')).toBeNull();

		await controller.toggleJapaneseReadings();
		expect(transcript.querySelector('ruby rt')?.textContent).toBe('にほんご');
		expect(annotateJapaneseTranscript).toHaveBeenCalledTimes(2);
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
			tools: {
				translateTranscript,
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleBilingual();
		expect(segments[0].querySelector('.transcript-segment-translation')).toBeNull();
		expect(document.querySelector('.language-learning-card-body')?.textContent)
			.toBe('readerTranslationIncomplete');
		expect((document.querySelector('.language-learning-card-retry') as HTMLButtonElement).hidden).toBe(false);

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
			tools: {
				translateTranscript: vi.fn(),
				explainSelection,
				annotateJapaneseTranscript: vi.fn()
			},
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
			tools: {
				translateTranscript,
				explainSelection,
				annotateJapaneseTranscript: vi.fn()
			},
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
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});

		cleanupTranscriptLanguageLearning(document);

		expect(document.querySelector('.language-learning-card')).toBeNull();
		expect(document.querySelector('.language-learning-selection-action')).toBeNull();
		expect(document.querySelector('.player-learning-readings')).toBeNull();
	});
});
