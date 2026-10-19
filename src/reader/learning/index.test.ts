// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../utils/i18n', () => ({
	getMessage: (key: string, substitutions?: string | string[]) => substitutions
		? `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
		: key
}));

import {
	cleanupTranscriptLanguageLearning,
	clearTranscriptLanguageLearningCache,
	wireTranscriptLanguageLearning
} from './index';
import { RequestCancelledError } from '../../utils/request-cancellation';
import { AiError } from '../../ai/errors';
import { createTranscript, selectText } from './test-support';

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

	test('restores saved bilingual subtitles without starting a model request', async () => {
		const { controls, transcript, segments } = createTranscript();
		const translateTranscript = vi.fn();
		const onPreferenceChange = vi.fn();
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript,
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn(),
				loadTranscriptTranslations: vi.fn().mockResolvedValue(['你好，世界。'])
			},
			restoreBilingualSubtitles: true,
			onPreferenceChange,
			cancelPendingSeek: vi.fn()
		});

		await controller.ready;

		expect(segments[0].querySelector('.transcript-segment-translation')?.textContent)
			.toBe('你好，世界。');
		expect(transcript.classList.contains('show-bilingual-transcript')).toBe(true);
		expect(translateTranscript).not.toHaveBeenCalled();
		expect(onPreferenceChange).not.toHaveBeenCalled();

		await controller.toggleBilingual();
		expect(onPreferenceChange).toHaveBeenLastCalledWith('bilingualSubtitles', false);
	});

	test('waits for a pending bilingual restore before handling an immediate user action', async () => {
		const { controls, transcript, segments } = createTranscript();
		const translateTranscript = vi.fn();
		let resolveTranslations!: (translations: string[]) => void;
		const loadTranscriptTranslations = vi.fn(() => new Promise<string[]>(resolve => {
			resolveTranslations = resolve;
		}));
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript,
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn(),
				loadTranscriptTranslations
			},
			restoreBilingualSubtitles: true,
			cancelPendingSeek: vi.fn()
		});

		const toggle = controller.toggleBilingual();
		expect(translateTranscript).not.toHaveBeenCalled();
		resolveTranslations(['你好，世界。']);
		await toggle;

		expect(transcript.classList.contains('show-bilingual-transcript')).toBe(true);
		expect(segments[0].querySelector('.transcript-segment-translation')?.textContent)
			.toBe('你好，世界。');
		expect(translateTranscript).not.toHaveBeenCalled();
	});

	test('adds Japanese readings only after an explicit reading action', async () => {
		const { controls, transcript, segments } = createTranscript(['私は日本語を勉強します。']);
		const translateTranscriptToJapanese = vi.fn();
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
				translateTranscriptToJapanese,
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
		expect(translateTranscriptToJapanese).not.toHaveBeenCalled();
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

	test('keeps source and bilingual translation while adding annotated Japanese for non-Japanese text', async () => {
		const { controls, transcript, segments } = createTranscript(['Hello world.']);
		const translateTranscript = vi.fn().mockResolvedValue(['你好，世界。']);
		const translateTranscriptToJapanese = vi.fn().mockResolvedValue(['こんにちは、世界。']);
		const annotateJapaneseTranscript = vi.fn().mockResolvedValue([[
			{ text: 'こんにちは、', reading: '' },
			{ text: '世界', reading: 'せかい' },
			{ text: '。', reading: '' }
		]]);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript,
				translateTranscriptToJapanese,
				explainSelection: vi.fn(),
				annotateJapaneseTranscript
			},
			cancelPendingSeek: vi.fn()
		});

		expect(translateTranscriptToJapanese).not.toHaveBeenCalled();
		expect(annotateJapaneseTranscript).not.toHaveBeenCalled();
		await controller.toggleBilingual();
		await controller.toggleJapaneseReadings();

		expect(translateTranscriptToJapanese).toHaveBeenCalledWith(
			['Hello world.'],
			expect.any(Function),
			expect.any(AbortSignal)
		);
		expect(annotateJapaneseTranscript).toHaveBeenCalledWith(
			['こんにちは、世界。'],
			expect.any(Function),
			expect.any(AbortSignal)
		);
		expect(translateTranscriptToJapanese.mock.invocationCallOrder[0])
			.toBeLessThan(annotateJapaneseTranscript.mock.invocationCallOrder[0]);
		const textElement = segments[0].querySelector('.transcript-segment-text') as HTMLElement;
		expect(textElement.firstChild?.textContent).toContain('Hello world.');
		expect(textElement.querySelector('.transcript-segment-translation')?.textContent)
			.toBe('你好，世界。');
		const japanese = textElement.querySelector('.transcript-segment-japanese') as HTMLElement;
		expect(japanese.textContent).toBe('こんにちは、世界せかい。');
		expect(japanese.querySelector('ruby rt')?.textContent).toBe('せかい');
		expect(Array.from(textElement.children).map(element => element.className)).toEqual([
			'transcript-segment-translation',
			'transcript-segment-japanese'
		]);

		await controller.toggleJapaneseReadings();
		expect(japanese.hidden).toBe(true);
		expect(textElement.querySelector('.transcript-segment-translation')?.textContent)
			.toBe('你好，世界。');
		expect(transcript.classList.contains('show-bilingual-transcript')).toBe(true);
		await controller.toggleJapaneseReadings();
		expect(japanese.hidden).toBe(false);
		expect(translateTranscriptToJapanese).toHaveBeenCalledOnce();
		expect(annotateJapaneseTranscript).toHaveBeenCalledOnce();
	});

	test('reuses completed Japanese translation when reading annotation is retried', async () => {
		const { controls, transcript, segments } = createTranscript(['Hello world.']);
		const translateTranscriptToJapanese = vi.fn().mockResolvedValue(['日本語です。']);
		const annotateJapaneseTranscript = vi.fn()
			.mockRejectedValueOnce(new Error('reading failed'))
			.mockResolvedValueOnce([[
				{ text: '日本語', reading: 'にほんご' },
				{ text: 'です。', reading: '' }
			]]);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				translateTranscriptToJapanese,
				explainSelection: vi.fn(),
				annotateJapaneseTranscript
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleJapaneseReadings();
		await controller.toggleJapaneseReadings();

		expect(translateTranscriptToJapanese).toHaveBeenCalledOnce();
		expect(annotateJapaneseTranscript).toHaveBeenCalledTimes(2);
		expect(transcript.querySelector('.transcript-segment-japanese rt')?.textContent)
			.toBe('にほんご');
	});

	test('stops before reading annotation when Japanese translation is incomplete', async () => {
		const { controls, transcript, segments } = createTranscript(['Hello world.']);
		const annotateJapaneseTranscript = vi.fn();
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				translateTranscriptToJapanese: vi.fn().mockResolvedValue(['']),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleJapaneseReadings();

		expect(annotateJapaneseTranscript).not.toHaveBeenCalled();
		expect(document.querySelector('.language-learning-card-body')?.textContent)
			.toBe('readerTranslationIncomplete');
		expect(transcript.querySelector('.transcript-segment-japanese')).toBeNull();
	});

	test('restores complete translated Japanese readings without model work', async () => {
		const { controls, transcript, segments } = createTranscript(['Hello world.']);
		const translateTranscriptToJapanese = vi.fn();
		const annotateJapaneseTranscript = vi.fn();
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				translateTranscriptToJapanese,
				loadJapaneseTranscriptTranslations: vi.fn().mockResolvedValue(['日本語です。']),
				loadJapaneseReadings: vi.fn().mockResolvedValue([[
					{ text: '日本語', reading: 'にほんご' },
					{ text: 'です。', reading: '' }
				]]),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript
			},
			restoreJapaneseReadings: true,
			cancelPendingSeek: vi.fn()
		});

		await controller.ready;

		expect(transcript.querySelector('.transcript-segment-japanese ruby rt')?.textContent)
			.toBe('にほんご');
		expect(translateTranscriptToJapanese).not.toHaveBeenCalled();
		expect(annotateJapaneseTranscript).not.toHaveBeenCalled();
	});

	test('applies the selected transcript range to Japanese translation and readings', async () => {
		const { controls, transcript, segments } = createTranscript(['First line.', 'Second line.']);
		segments[1].classList.add('is-active');
		const translateTranscriptToJapanese = vi.fn().mockResolvedValue(['二行目です。']);
		const annotateJapaneseTranscript = vi.fn().mockResolvedValue([[
			{ text: '二行目', reading: 'にぎょうめ' },
			{ text: 'です。', reading: '' }
		]]);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				translateTranscriptToJapanese,
				explainSelection: vi.fn(),
				annotateJapaneseTranscript
			},
			cancelPendingSeek: vi.fn()
		});
		controller.setTaskRange('current');

		await controller.toggleJapaneseReadings();

		expect(translateTranscriptToJapanese).toHaveBeenCalledWith(
			['Second line.'],
			expect.any(Function),
			expect.any(AbortSignal)
		);
		expect(annotateJapaneseTranscript).toHaveBeenCalledWith(
			['二行目です。'],
			expect.any(Function),
			expect.any(AbortSignal)
		);
		expect(segments[0].querySelector('.transcript-segment-japanese')).toBeNull();
		expect(segments[1].querySelector('.transcript-segment-japanese rt')?.textContent)
			.toBe('にぎょうめ');
	});

	test('generates a newly selected non-Japanese range instead of treating empty translated text as complete', async () => {
		const { controls, transcript, segments } = createTranscript(['First line.', 'Second line.']);
		segments[0].classList.add('is-active');
		const translateTranscriptToJapanese = vi.fn()
			.mockResolvedValueOnce(['一行目です。'])
			.mockResolvedValueOnce(['二行目です。']);
		const annotateJapaneseTranscript = vi.fn()
			.mockResolvedValueOnce([[
				{ text: '一行目', reading: 'いちぎょうめ' },
				{ text: 'です。', reading: '' }
			]])
			.mockResolvedValueOnce([[
				{ text: '二行目', reading: 'にぎょうめ' },
				{ text: 'です。', reading: '' }
			]]);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				translateTranscriptToJapanese,
				explainSelection: vi.fn(),
				annotateJapaneseTranscript
			},
			cancelPendingSeek: vi.fn()
		});
		controller.setTaskRange('current');
		await controller.toggleJapaneseReadings();
		segments[0].classList.remove('is-active');
		segments[1].classList.add('is-active');

		await controller.toggleJapaneseReadings();

		expect(translateTranscriptToJapanese).toHaveBeenCalledTimes(2);
		expect(translateTranscriptToJapanese).toHaveBeenLastCalledWith(
			['Second line.'],
			expect.any(Function),
			expect.any(AbortSignal)
		);
		expect(segments[1].querySelector('.transcript-segment-japanese rt')?.textContent)
			.toBe('にぎょうめ');
	});

	test('cancels during Japanese translation without starting reading annotation', async () => {
		const { controls, transcript, segments } = createTranscript(['Hello world.']);
		const annotateJapaneseTranscript = vi.fn();
		const translateTranscriptToJapanese = vi.fn((
			_segments: string[],
			_onProgress?: unknown,
			signal?: AbortSignal
		) => new Promise<string[]>((_, reject) => {
			signal?.addEventListener('abort', () => reject(new RequestCancelledError()), { once: true });
		}));
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				translateTranscriptToJapanese,
				explainSelection: vi.fn(),
				annotateJapaneseTranscript
			},
			cancelPendingSeek: vi.fn()
		});

		const request = controller.toggleJapaneseReadings();
		controller.cancelActiveRequest();
		await request;

		expect(annotateJapaneseTranscript).not.toHaveBeenCalled();
		expect(controls.querySelector('.player-learning-progress')?.textContent)
			.toBe('readerAiCancelled');
	});

	test('regenerates only readings for a non-Japanese source', async () => {
		const { controls, transcript, segments } = createTranscript(['Hello world.']);
		const translateTranscriptToJapanese = vi.fn().mockResolvedValue(['日本語です。']);
		const annotateJapaneseTranscript = vi.fn().mockResolvedValue([[
			{ text: '日本語', reading: 'にほんご' },
			{ text: 'です。', reading: '' }
		]]);
		const clearJapaneseReadings = vi.fn().mockResolvedValue(undefined);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				translateTranscriptToJapanese,
				explainSelection: vi.fn(),
				annotateJapaneseTranscript,
				clearJapaneseReadings
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleJapaneseReadings();
		await controller.regenerateJapaneseReadings();

		expect(translateTranscriptToJapanese).toHaveBeenCalledOnce();
		expect(clearJapaneseReadings).toHaveBeenCalledWith(['日本語です。']);
		expect(annotateJapaneseTranscript).toHaveBeenCalledTimes(2);
	});

	test('persists edited readings against the translated Japanese text', async () => {
		const { controls, transcript, segments } = createTranscript(['Hello world.']);
		const saveJapaneseReadings = vi.fn().mockResolvedValue(undefined);
		const saveJapaneseReadingOverride = vi.fn().mockResolvedValue(undefined);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				translateTranscriptToJapanese: vi.fn().mockResolvedValue(['日本語です。']),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn().mockResolvedValue([[
					{ text: '日本語', reading: 'にほんご' },
					{ text: 'です。', reading: '' }
				]]),
				saveJapaneseReadings,
				saveJapaneseReadingOverride
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleJapaneseReadings();
		const editButton = controls.querySelector('.player-learning-readings-edit') as HTMLButtonElement;
		editButton.click();
		const reading = transcript.querySelector('.transcript-segment-japanese rt') as HTMLElement;
		reading.textContent = 'にっぽんご';
		reading.dispatchEvent(new Event('input', { bubbles: true }));

		expect(saveJapaneseReadingOverride).toHaveBeenCalledWith('日本語', 'にっぽんご');
		expect(saveJapaneseReadings).toHaveBeenCalledWith(
			['日本語です。'],
			[[
				{ text: '日本語', reading: 'にっぽんご' },
				{ text: 'です。', reading: '' }
			]]
		);
	});

	test('restores saved Japanese readings without starting a model request', async () => {
		const { controls, transcript, segments } = createTranscript(['日本語を勉強します。']);
		const annotateJapaneseTranscript = vi.fn();
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript,
				loadJapaneseReadings: vi.fn().mockResolvedValue([[
					{ text: '日本語', reading: 'にほんご' },
					{ text: 'を', reading: '' },
					{ text: '勉強', reading: 'べんきょう' },
					{ text: 'します。', reading: '' }
				]])
			},
			restoreJapaneseReadings: true,
			cancelPendingSeek: vi.fn()
		});

		await controller.ready;

		expect(transcript.classList.contains('show-japanese-readings')).toBe(true);
		expect(transcript.querySelector('ruby rt')?.textContent).toBe('にほんご');
		expect(annotateJapaneseTranscript).not.toHaveBeenCalled();
	});

	test('waits for a pending reading restore before handling an immediate user action', async () => {
		const { controls, transcript, segments } = createTranscript(['日本語を勉強します。']);
		const annotateJapaneseTranscript = vi.fn();
		let resolveReadings!: (readings: Array<Array<{ text: string; reading: string }>>) => void;
		const loadJapaneseReadings = vi.fn(() => new Promise<Array<Array<{ text: string; reading: string }>>>(resolve => {
			resolveReadings = resolve;
		}));
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript,
				loadJapaneseReadings
			},
			restoreJapaneseReadings: true,
			cancelPendingSeek: vi.fn()
		});

		const toggle = controller.toggleJapaneseReadings();
		expect(annotateJapaneseTranscript).not.toHaveBeenCalled();
		resolveReadings([[
			{ text: '日本語', reading: 'にほんご' },
			{ text: 'を', reading: '' },
			{ text: '勉強', reading: 'べんきょう' },
			{ text: 'します。', reading: '' }
		]]);
		await toggle;

		expect(transcript.classList.contains('show-japanese-readings')).toBe(true);
		expect(transcript.querySelector('ruby rt')?.textContent).toBe('にほんご');
		expect(annotateJapaneseTranscript).not.toHaveBeenCalled();
	});

	test('lets a partial reading range be edited and regenerated in place', async () => {
		const { controls, transcript, segments } = createTranscript(['日本語', '漢字']);
		transcript.dataset.transcriptLanguage = 'ja';
		segments[0].classList.add('is-active');
		const annotateJapaneseTranscript = vi.fn()
			.mockResolvedValueOnce([[{ text: '日本語', reading: 'にほんご' }]])
			.mockResolvedValueOnce([[{ text: '日本語', reading: 'にっぽんご' }]]);
		const saveJapaneseReadings = vi.fn().mockResolvedValue(undefined);
		const clearJapaneseReadings = vi.fn().mockResolvedValue(undefined);
		const saveJapaneseReadingOverride = vi.fn().mockResolvedValue(undefined);
		const removeJapaneseReadingOverride = vi.fn().mockResolvedValue(undefined);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript,
				saveJapaneseReadings,
				clearJapaneseReadings,
				saveJapaneseReadingOverride,
				removeJapaneseReadingOverride
			},
			cancelPendingSeek: vi.fn()
		});
		controller.setTaskRange('current');

		await controller.toggleJapaneseReadings();
		const editButton = controls.querySelector('.player-learning-readings-edit') as HTMLButtonElement;
		const regenerateButton = controls.querySelector('.player-learning-readings-regenerate') as HTMLButtonElement;
		expect(editButton.hidden).toBe(false);
		expect(regenerateButton.hidden).toBe(false);

		editButton.click();
		const reading = segments[0].querySelector('rt') as HTMLElement;
		expect(reading.getAttribute('contenteditable')).toBe('true');
		reading.textContent = 'にほんごう';
		reading.dispatchEvent(new Event('input', { bubbles: true }));
		expect(saveJapaneseReadings).toHaveBeenCalledWith(
			['日本語'],
			[[{ text: '日本語', reading: 'にほんごう' }]]
		);
		expect(saveJapaneseReadingOverride).toHaveBeenCalledWith('日本語', 'にほんごう');

		reading.textContent = '';
		reading.dispatchEvent(new Event('input', { bubbles: true }));
		expect(removeJapaneseReadingOverride).toHaveBeenCalledWith('日本語');

		await controller.regenerateJapaneseReadings();
		expect(clearJapaneseReadings).toHaveBeenCalledWith(['日本語']);
		// A saved record of the whole transcript would otherwise restore the old reading of the range.
		expect(clearJapaneseReadings).toHaveBeenCalledWith(['日本語', '漢字']);
		expect(segments[0].querySelector('rt')?.textContent).toBe('にっぽんご');
		expect(segments[1].querySelector('rt')).toBeNull();
	});

	test('shows progress while generating readings in multiple batches', async () => {
		const { controls, transcript, segments } = createTranscript(['私は日本語を勉強します。']);
		let readingButton: HTMLButtonElement;
		const progressStates: Array<{ button: string; status: string }> = [];
		const annotateJapaneseTranscript = vi.fn(async (
			_segments: string[],
			onProgress?: (progress: {
				completed: number;
				total: number;
				completedSegments: number;
				totalSegments: number;
				readings: Array<Array<{ text: string; reading: string }>>;
			}) => void
		) => {
			onProgress?.({ completed: 0, total: 2, completedSegments: 0, totalSegments: 3, readings: [[]] });
			progressStates.push({
				button: readingButton.textContent || '',
				status: controls.querySelector('.player-learning-progress')?.textContent || ''
			});
			onProgress?.({ completed: 1, total: 2, completedSegments: 2, totalSegments: 3, readings: [[]] });
			progressStates.push({
				button: readingButton.textContent || '',
				status: controls.querySelector('.player-learning-progress')?.textContent || ''
			});
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

		expect(progressStates).toEqual([
			{ button: 'thinking', status: 'readerJapaneseReadingsProgress:0,3' },
			{ button: 'thinking', status: 'readerJapaneseReadingsProgress:2,3' }
		]);
	});

	test('renders completed Japanese reading segments before the full task finishes', async () => {
		const { controls, transcript, segments } = createTranscript(['日本語', '勉強']);
		transcript.dataset.transcriptLanguage = 'ja';
		const partialState: boolean[] = [];
		const firstReading = [{ text: '日本語', reading: 'にほんご' }];
		const secondReading = [{ text: '勉強', reading: 'べんきょう' }];
		const annotateJapaneseTranscript = vi.fn(async (
			_segments: string[],
			onProgress?: (progress: {
				completed: number;
				total: number;
				completedSegments: number;
				totalSegments: number;
				readings: Array<Array<{ text: string; reading: string }>>;
			}) => void
		) => {
			onProgress?.({
				completed: 1,
				total: 2,
				completedSegments: 1,
				totalSegments: 2,
				readings: [firstReading, []]
			});
			partialState.push(
				Boolean(segments[0].querySelector('ruby')),
				Boolean(segments[1].querySelector('ruby'))
			);
			return [firstReading, secondReading];
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

		await controller.toggleJapaneseReadings();

		expect(partialState).toEqual([true, false]);
		expect(segments[1].querySelector('rt')?.textContent).toBe('べんきょう');
	});

	test('renders completed translations before the full task finishes', async () => {
		const { controls, transcript, segments } = createTranscript(['First.', 'Second.']);
		const partialState: Array<string | undefined> = [];
		const translateTranscript = vi.fn(async (
			_segments: string[],
			onProgress?: (progress: { completed: number; total: number; translations: string[] }) => void
		) => {
			onProgress?.({ completed: 1, total: 2, translations: ['第一段', ''] });
			partialState.push(
				segments[0].querySelector('.transcript-segment-translation')?.textContent || undefined,
				segments[1].querySelector('.transcript-segment-translation')?.textContent || undefined
			);
			return ['第一段', '第二段'];
		});
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

		expect(partialState).toEqual(['第一段', undefined]);
		expect(segments[1].querySelector('.transcript-segment-translation')?.textContent).toBe('第二段');
	});

	test('shows a provider retry countdown while a group backs off and clears it on the next progress', async () => {
		const { controls, transcript, segments } = createTranscript(['First.', 'Second.']);
		const statuses: string[] = [];
		const status = () => controls.querySelector('.player-learning-progress')?.textContent || '';
		const translateTranscript = vi.fn(async (
			_segments: string[],
			onProgress?: (progress: {
				completed: number;
				total: number;
				translations: string[];
				retry?: { delayMs: number; attempt: number };
			}) => void
		) => {
			onProgress?.({ completed: 1, total: 2, translations: ['第一段', ''] });
			statuses.push(status());
			onProgress?.({ completed: 1, total: 2, translations: ['第一段', ''], retry: { delayMs: 2200, attempt: 1 } });
			statuses.push(status());
			onProgress?.({ completed: 2, total: 2, translations: ['第一段', '第二段'] });
			statuses.push(status());
			return ['第一段', '第二段'];
		});
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

		expect(statuses).toEqual([
			'readerTranslationProgress:1,2',
			'readerTranscriptRetrying:3',
			'readerTranslationProgress:2,2'
		]);
		expect(segments[1].querySelector('.transcript-segment-translation')?.textContent).toBe('第二段');
	});

	test('shows the retry countdown during reading generation', async () => {
		const { controls, transcript, segments } = createTranscript(['日本語']);
		transcript.dataset.transcriptLanguage = 'ja';
		const statuses: string[] = [];
		const tokens = [{ text: '日本語', reading: 'にほんご' }];
		const annotateJapaneseTranscript = vi.fn(async (
			_segments: string[],
			onProgress?: (progress: {
				completed: number;
				total: number;
				completedSegments: number;
				totalSegments: number;
				readings: Array<Array<{ text: string; reading: string }>>;
				retry?: { delayMs: number; attempt: number };
			}) => void
		) => {
			onProgress?.({ completed: 0, total: 1, completedSegments: 0, totalSegments: 1, readings: [[]], retry: { delayMs: 400, attempt: 2 } });
			statuses.push(controls.querySelector('.player-learning-progress')?.textContent || '');
			return [tokens];
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

		await controller.toggleJapaneseReadings();

		expect(statuses).toEqual(['readerTranscriptRetrying:1']);
		expect(segments[0].querySelector('rt')?.textContent).toBe('にほんご');
	});

	test('a blank source segment needs no translation to be complete', async () => {
		const { controls, transcript, segments } = createTranscript(['Hello.', '']);
		const translateTranscript = vi.fn().mockResolvedValue(['你好。', '']);
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

		expect(document.querySelector('.language-learning-card.is-error')).toBeNull();
		expect(transcript.classList.contains('show-bilingual-transcript')).toBe(true);
		expect(transcript.classList.contains('has-partial-bilingual-transcript')).toBe(false);
		expect(segments[0].querySelector('.transcript-segment-translation')?.textContent).toBe('你好。');

		// Hiding and showing again reuses the loaded translations without another request.
		await controller.toggleBilingual();
		await controller.toggleBilingual();
		expect(translateTranscript).toHaveBeenCalledOnce();
	});

	test('lets the learner correct generated translations and persists the correction', async () => {
		const { controls, transcript, segments } = createTranscript(['Hello world.']);
		const saveTranscriptTranslations = vi.fn().mockResolvedValue(undefined);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn().mockResolvedValue(['你好，世界。']),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn(),
				saveTranscriptTranslations
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleBilingual();
		const editButton = controls.querySelector('.player-learning-translations-edit') as HTMLButtonElement;
		expect(editButton.hidden).toBe(false);
		editButton.click();
		const translation = segments[0].querySelector('.transcript-segment-translation') as HTMLElement;
		expect(translation.getAttribute('contenteditable')).toBe('true');
		expect(translation.getAttribute('role')).toBe('textbox');
		translation.textContent = '你好，世界！';
		translation.dispatchEvent(new Event('input', { bubbles: true }));
		editButton.click();

		expect(saveTranscriptTranslations).toHaveBeenLastCalledWith(
			['Hello world.'],
			['你好，世界！']
		);
		expect(translation.getAttribute('contenteditable')).toBe('false');
	});

	test('lets the learner hide and reveal an individual Japanese reading', async () => {
		const { controls, transcript, segments } = createTranscript(['日本語']);
		transcript.dataset.transcriptLanguage = 'ja';
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn().mockResolvedValue([[
					{ text: '日本語', reading: 'にほんご' }
				]])
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleJapaneseReadings();
		const ruby = transcript.querySelector('ruby') as HTMLElement;
		expect(ruby.getAttribute('role')).toBe('button');
		expect(ruby.getAttribute('tabindex')).toBe('0');
		ruby.click();
		expect(ruby.classList.contains('is-reading-hidden')).toBe(true);
		ruby.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(ruby.classList.contains('is-reading-hidden')).toBe(false);
	});

	test('offers favorite, copy, and Obsidian actions for an explanation', async () => {
		const { controls, transcript, segments } = createTranscript();
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn().mockResolvedValue('A concise explanation.'),
				annotateJapaneseTranscript: vi.fn(),
				isVocabularyFavorite: vi.fn().mockResolvedValue(false),
				toggleVocabularyFavorite: vi.fn().mockResolvedValue(true),
				copyLearningText: vi.fn().mockResolvedValue(true),
				saveVocabularyToObsidian: vi.fn().mockResolvedValue(undefined)
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.explain({ kind: 'word', text: 'Hello', context: 'Hello world.' });

		expect(document.querySelector('.language-learning-card-favorite')?.textContent)
			.toBe('readerFavorite');
		expect(document.querySelector('.language-learning-card-copy')?.textContent)
			.toBe('copyToClipboard');
		expect(document.querySelector('.language-learning-card-save')?.textContent)
			.toBe('addToObsidian');
	});

	test('shows saved vocabulary without making another model request', async () => {
		const { controls, transcript, segments } = createTranscript();
		const explainSelection = vi.fn();
		const removeVocabulary = vi.fn().mockResolvedValue(undefined);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection,
				annotateJapaneseTranscript: vi.fn(),
				listVocabulary: vi.fn().mockResolvedValue([{
					id: 'word-1',
					kind: 'word',
					text: 'encounter',
					context: 'An encounter.',
					explanation: '相遇；一次偶遇。',
					responseLanguage: 'Simplified Chinese',
					createdAt: 1
				}]),
				removeVocabulary,
				copyLearningText: vi.fn().mockResolvedValue(true),
				saveVocabularyToObsidian: vi.fn().mockResolvedValue(undefined)
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.showVocabulary();

		expect(document.querySelector('.language-learning-vocabulary-entry strong')?.textContent)
			.toBe('encounter');
		expect(document.querySelector('.language-learning-vocabulary-entry p')?.textContent)
			.toBe('相遇；一次偶遇。');
		expect(document.querySelector('.language-learning-vocabulary-remove')?.textContent)
			.toBe('remove');
		expect(explainSelection).not.toHaveBeenCalled();
	});

	test('does not reopen or re-inert the page when cleanup interrupts Learning Center loading', async () => {
		const { controls, transcript, segments } = createTranscript();
		let resolveVocabulary!: (entries: []) => void;
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn(),
				listVocabulary: vi.fn(() => new Promise<[]>(resolve => {
					resolveVocabulary = resolve;
				}))
			},
			cancelPendingSeek: vi.fn()
		});

		const loading = controller.showVocabulary();
		cleanupTranscriptLanguageLearning(document);
		resolveVocabulary([]);
		await loading;

		expect(document.querySelector('.language-learning-card')).toBeNull();
		expect(transcript.hasAttribute('inert')).toBe(false);
	});

	const PROFILES = [
		{ id: 'model-b', label: 'OpenAI · B', kind: 'openai-compatible' as const },
		{ id: 'legacy-cli-grok-default', label: 'interpreterExecutionModeGrok', kind: 'cli-grok' as const },
		{ id: 'legacy-cli-codex-default', label: 'interpreterExecutionModeCodex', kind: 'cli-codex' as const }
	];

	// Page-DOM controls reject synthetic events, so a test invokes the button's own listener with a
	// trusted-looking event, the only way a user click can reach it.
	function captureTrustedClick(className: string) {
		const listeners: EventListener[] = [];
		const original = HTMLElement.prototype.addEventListener;
		const spy = vi.spyOn(HTMLElement.prototype, 'addEventListener').mockImplementation(function (
			this: HTMLElement,
			type: string,
			listener: EventListenerOrEventListenerObject,
			options?: boolean | AddEventListenerOptions
		) {
			if (type === 'click' && this.classList.contains(className) && typeof listener === 'function') {
				listeners.push(listener);
			}
			return original.call(this, type, listener, options);
		});
		return {
			restore: () => spy.mockRestore(),
			click: async () => {
				const event = { isTrusted: true, preventDefault() {}, stopPropagation() {} } as unknown as Event;
				await Promise.all(listeners.map(listener => listener(event)));
			}
		};
	}

	async function flushPromises() {
		for (let index = 0; index < 5; index++) await Promise.resolve();
	}

	test('estimates batches from the task budget and lists profiles in the recovery switch', async () => {
		const { controls, transcript, segments } = createTranscript(['First.', 'Second.']);
		const timeout = Object.assign(new Error('grok failed'), {
			code: 'timeout',
			details: { mode: 'grok', task: 'translate', profileId: 'legacy-cli-grok-default', timeoutSeconds: 120 }
		});
		const getExecutionInfo = vi.fn().mockResolvedValue({
			profileId: 'legacy-cli-grok-default',
			kind: 'cli-grok',
			label: 'Grok CLI',
			promptCharLimit: 8
		});
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn().mockRejectedValue(timeout),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn(),
				getExecutionInfo,
				listProfiles: vi.fn().mockResolvedValue(PROFILES),
				setTaskProfile: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleBilingual();
		await flushPromises();

		expect(getExecutionInfo).toHaveBeenCalledWith('translate');
		expect(controls.querySelector('.player-learning-task-engine')?.textContent).toBe('Grok CLI');
		expect(controls.querySelector('.player-learning-task-estimate')?.textContent)
			.toBe('readerTaskEstimate:2,2');
		const select = document.querySelector('.language-learning-card-engine-select') as HTMLSelectElement;
		expect(Array.from(select.options, option => [option.value, option.textContent])).toEqual(
			PROFILES.map(profile => [profile.id, profile.label])
		);
		expect(select.value).toBe('legacy-cli-grok-default');
		expect((document.querySelector('.language-learning-card-engine-recovery') as HTMLElement).hidden).toBe(false);
		expect(document.querySelector('.language-learning-card-engine-apply')?.textContent)
			.toBe('readerSwitchAndRetry');
		expect(document.querySelector('.language-learning-card-body')?.textContent)
			.toBe('readerCliTimeout:grok,120');
	});

	test('the readings budget comes from getExecutionInfo for the reading task', async () => {
		const { controls, transcript, segments } = createTranscript(['東京です。', '大阪です。']);
		const getExecutionInfo = vi.fn().mockResolvedValue({ label: 'Codex CLI', kind: 'cli-codex', promptCharLimit: 5 });
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn().mockResolvedValue([[], []]),
				getExecutionInfo
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleJapaneseReadings();

		expect(getExecutionInfo).toHaveBeenCalledWith('reading');
		expect(controls.querySelector('.player-learning-task-estimate')?.textContent)
			.toBe('readerTaskEstimate:2,2');
	});

	test('Switch and retry routes the failed task to the chosen profile, then retries', async () => {
		const { controls, transcript, segments } = createTranscript(['First.']);
		const failure = Object.assign(new Error('Codex failed'), {
			code: 'cli-failed',
			details: { mode: 'codex', task: 'translate', profileId: 'legacy-cli-codex-default' }
		});
		const translateTranscript = vi.fn()
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce(['第一']);
		const setTaskProfile = vi.fn().mockResolvedValue(undefined);
		const apply = captureTrustedClick('language-learning-card-engine-apply');
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript,
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn(),
				listProfiles: vi.fn().mockResolvedValue(PROFILES),
				setTaskProfile
			},
			cancelPendingSeek: vi.fn()
		});
		apply.restore();

		await controller.toggleBilingual();
		await flushPromises();
		const select = document.querySelector('.language-learning-card-engine-select') as HTMLSelectElement;
		expect(select.value).toBe('legacy-cli-codex-default');
		expect(document.querySelector('.language-learning-card-body')?.textContent).toBe('readerCliFailed:codex');

		// A synthetic click from the host page does nothing.
		(document.querySelector('.language-learning-card-engine-apply') as HTMLButtonElement).click();
		await flushPromises();
		expect(setTaskProfile).not.toHaveBeenCalled();

		select.value = 'model-b';
		await apply.click();
		await flushPromises();

		expect(setTaskProfile).toHaveBeenCalledWith('translate', 'model-b');
		expect(translateTranscript).toHaveBeenCalledTimes(2);
		expect(transcript.classList.contains('show-bilingual-transcript')).toBe(true);
		expect((document.querySelector('.language-learning-card') as HTMLElement).style.display).toBe('none');
	});

	test('an AiError shows its described body and detail and preselects the profile it names', async () => {
		const { controls, transcript, segments } = createTranscript(['First.', 'Second.']);
		const failure = new AiError('timeout', {
			nativeCode: 'timeout',
			detail: 'codex CLI timed out after 300 seconds.',
			recovery: 'continue-remaining',
			task: 'translate',
			profileId: 'legacy-cli-codex-default'
		});
		const translateTranscript = vi.fn(async (
			_texts: string[],
			onProgress?: (progress: { completed: number; total: number; translations: string[] }) => void
		) => {
			onProgress?.({ completed: 1, total: 2, translations: ['第一段', ''] });
			throw failure;
		});
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript,
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn(),
				listProfiles: vi.fn().mockResolvedValue(PROFILES),
				setTaskProfile: vi.fn().mockResolvedValue(undefined)
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleBilingual();
		await flushPromises();

		expect(document.querySelector('.language-learning-card-body')?.textContent).toBe('readerTranscriptTranslationBatchFailed');
		expect(document.querySelector('.language-learning-card-error-detail')?.textContent).toBe('codex CLI timed out after 300 seconds.');
		expect(document.querySelector('.language-learning-card-retry')?.textContent).toBe('readerContinueRemaining:1,2');
		expect((document.querySelector('.language-learning-card-engine-select') as HTMLSelectElement).value)
			.toBe('legacy-cli-codex-default');
	});

	test('an AiError cancellation closes quietly without an error card', async () => {
		const { controls, transcript, segments } = createTranscript(['First.']);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn().mockRejectedValue(new AiError('cancelled', { task: 'translate' })),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleBilingual();
		await flushPromises();

		const card = document.querySelector('.language-learning-card') as HTMLElement;
		expect(card.classList.contains('is-error')).toBe(false);
		expect(card.style.display).toBe('none');
	});

	test('a readings run that fails in its translate step re-routes translate, not reading', async () => {
		const { controls, transcript, segments } = createTranscript(['Hello world.']);
		const failure = Object.assign(new Error('failed'), {
			code: 'failed',
			details: { mode: 'api', task: 'translate', profileId: 'model-b' }
		});
		const setTaskProfile = vi.fn().mockResolvedValue(undefined);
		const apply = captureTrustedClick('language-learning-card-engine-apply');
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				translateTranscriptToJapanese: vi.fn().mockRejectedValue(failure),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn(),
				listProfiles: vi.fn().mockResolvedValue(PROFILES),
				setTaskProfile
			},
			cancelPendingSeek: vi.fn()
		});
		apply.restore();

		await controller.toggleJapaneseReadings();
		await flushPromises();
		(document.querySelector('.language-learning-card-engine-select') as HTMLSelectElement).value = 'legacy-cli-grok-default';
		await apply.click();

		expect(setTaskProfile).toHaveBeenCalledWith('translate', 'legacy-cli-grok-default');
	});

	test('an error without a task falls back to the task of the failed flow', async () => {
		const { controls, transcript, segments } = createTranscript(['First.']);
		const setTaskProfile = vi.fn().mockResolvedValue(undefined);
		const explainSelection = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('failed'), { code: 'failed', details: { mode: 'api' } }))
			.mockResolvedValueOnce('Explanation');
		const apply = captureTrustedClick('language-learning-card-engine-apply');
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection,
				annotateJapaneseTranscript: vi.fn(),
				listProfiles: vi.fn().mockResolvedValue(PROFILES),
				setTaskProfile
			},
			cancelPendingSeek: vi.fn()
		});
		apply.restore();

		await controller.explain({ kind: 'word', text: 'First', context: 'First.' });
		await flushPromises();
		const select = document.querySelector('.language-learning-card-engine-select') as HTMLSelectElement;
		expect(select.value).toBe('model-b');
		await apply.click();
		await flushPromises();

		expect(setTaskProfile).toHaveBeenCalledWith('explain', 'model-b');
		expect(explainSelection).toHaveBeenCalledTimes(2);
		expect(document.querySelector('.language-learning-card-body')?.textContent).toBe('Explanation');
	});

	test('hides the switch without profiles, without the tools, or for a cancellation', async () => {
		const failure = Object.assign(new Error('failed'), { code: 'failed', details: { mode: 'api', task: 'translate' } });
		const recoveryHidden = async (tools: Record<string, unknown>) => {
			cleanupTranscriptLanguageLearning(document);
			const { controls, transcript, segments } = createTranscript(['First.']);
			const controller = wireTranscriptLanguageLearning({
				doc: document,
				transcript,
				segments,
				controls,
				tools: {
					translateTranscript: vi.fn().mockRejectedValue(failure),
					explainSelection: vi.fn(),
					annotateJapaneseTranscript: vi.fn(),
					...tools
				},
				cancelPendingSeek: vi.fn()
			});
			await controller.toggleBilingual();
			await flushPromises();
			return (document.querySelector('.language-learning-card-engine-recovery') as HTMLElement).hidden;
		};

		await expect(recoveryHidden({ listProfiles: vi.fn().mockResolvedValue([]), setTaskProfile: vi.fn() })).resolves.toBe(true);
		await expect(recoveryHidden({ listProfiles: vi.fn().mockRejectedValue(new Error('x')), setTaskProfile: vi.fn() })).resolves.toBe(true);
		await expect(recoveryHidden({ listProfiles: vi.fn().mockResolvedValue(PROFILES) })).resolves.toBe(true);
		await expect(recoveryHidden({ listProfiles: vi.fn().mockResolvedValue(PROFILES), setTaskProfile: vi.fn() })).resolves.toBe(false);
	});

	test('a profile listing that resolves after cleanup changes nothing', async () => {
		const { controls, transcript, segments } = createTranscript(['First.']);
		let resolveProfiles!: (profiles: typeof PROFILES) => void;
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn().mockRejectedValue(Object.assign(new Error('failed'), {
					code: 'failed',
					details: { mode: 'api', task: 'translate' }
				})),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn(),
				listProfiles: vi.fn(() => new Promise<typeof PROFILES>(resolve => { resolveProfiles = resolve; })),
				setTaskProfile: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleBilingual();
		const select = document.querySelector('.language-learning-card-engine-select') as HTMLSelectElement;
		cleanupTranscriptLanguageLearning(document);
		resolveProfiles(PROFILES);
		await flushPromises();

		expect(select.options.length).toBe(0);
		expect(document.querySelector('.language-learning-card')).toBeNull();
	});

	test('keeps elapsed task status busy until the model request finishes', async () => {
		const { controls, transcript, segments } = createTranscript();
		let finishTranslation!: (translations: string[]) => void;
		const translateTranscript = vi.fn(() => new Promise<string[]>(resolve => {
			finishTranslation = resolve;
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
		await Promise.resolve();
		await Promise.resolve();

		const taskBar = controls.querySelector('.player-learning-task') as HTMLElement;
		expect(taskBar.getAttribute('aria-busy')).toBe('true');
		expect(controls.querySelector('.player-learning-task-elapsed')?.textContent)
			.toBe('readerTaskElapsed:0');

		finishTranslation(['你好，世界。']);
		await request;
		expect(taskBar.getAttribute('aria-busy')).toBe('false');
	});

	test('can limit an explicit AI task to the current or next five minutes', async () => {
		const { controls, transcript, segments } = createTranscript(['Zero.', 'Current.', 'Next.', 'Later.']);
		segments[1].classList.add('is-active');
		const translateTranscript = vi.fn(async (texts: string[]) => texts.map(text => `译：${text}`));
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript,
				explainSelection: vi.fn(),
				annotateJapaneseTranscript: vi.fn(),
				getExecutionInfo: vi.fn().mockResolvedValue({
					kind: 'cli-grok',
					label: 'Grok CLI',
					promptCharLimit: 1600
				})
			},
			cancelPendingSeek: vi.fn()
		});

		controller.setTaskRange('current');
		await controller.toggleBilingual();
		await controller.toggleBilingual();
		controller.setTaskRange('next-five-minutes');
		await controller.toggleBilingual();

		expect(translateTranscript.mock.calls.map(call => call[0])).toEqual([
			['Current.'],
			['Current.', 'Next.']
		]);
		expect(controls.querySelector('.player-learning-task-engine')?.textContent).toBe('Grok CLI');
	});

	test('shows a localized recoverable timeout with completed progress and technical details', async () => {
		const { controls, transcript, segments } = createTranscript(['First.', 'Second.']);
		const timeout = Object.assign(new Error('grok CLI timed out after 120 seconds.'), {
			name: 'LanguageLearningRequestError',
			code: 'timeout',
			details: { mode: 'grok', timeoutSeconds: 120 }
		});
		const translateTranscript = vi.fn(async (
			_texts: string[],
			onProgress?: (progress: { completed: number; total: number; translations: string[] }) => void
		) => {
			onProgress?.({ completed: 1, total: 2, translations: ['第一段', ''] });
			throw timeout;
		});
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

		expect(document.querySelector('.language-learning-card-body')?.textContent)
			.toBe('readerCliTimeout:grok,120');
		expect(document.querySelector('.language-learning-card-retry')?.textContent)
			.toBe('readerContinueRemaining:1,2');
		expect(document.querySelector('.language-learning-card-error-detail')?.textContent)
			.toBe('grok CLI timed out after 120 seconds.');
	});

	test('replaces stale technical details when a later explanation also fails', async () => {
		const { controls, transcript, segments } = createTranscript();
		const explainSelection = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('first failure'), {
				code: 'cli-failed',
				details: { mode: 'grok' }
			}))
			.mockRejectedValueOnce(Object.assign(new Error('second failure'), {
				code: 'cli-failed',
				details: { mode: 'grok' }
			}));
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

		await controller.explain({ kind: 'word', text: 'First', context: 'First context.' });
		await controller.explain({ kind: 'word', text: 'Second', context: 'Second context.' });

		expect(document.querySelectorAll('.language-learning-card-error-detail')).toHaveLength(1);
		expect(document.querySelector('.language-learning-card-error-detail')?.textContent)
			.toBe('second failure');
	});

	test('closes the explanation card with Escape and restores focus', async () => {
		const { controls, transcript, segments } = createTranscript();
		const trigger = document.createElement('button');
		document.body.appendChild(trigger);
		trigger.focus();
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn().mockResolvedValue('Explanation'),
				annotateJapaneseTranscript: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.explain({ kind: 'word', text: 'Hello', context: 'Hello world.' });
		expect(trigger.hasAttribute('inert')).toBe(true);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

		expect((document.querySelector('.language-learning-card') as HTMLElement).style.display).toBe('none');
		expect(trigger.hasAttribute('inert')).toBe(false);
		expect(document.activeElement).toBe(trigger);
	});

	test('keeps keyboard focus inside the explanation dialog', async () => {
		const { controls, transcript, segments } = createTranscript();
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn().mockResolvedValue('Explanation'),
				annotateJapaneseTranscript: vi.fn(),
				copyLearningText: vi.fn().mockResolvedValue(true)
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.explain({ kind: 'word', text: 'Hello', context: 'Hello world.' });

		const card = document.querySelector('.language-learning-card') as HTMLElement;
		const close = card.querySelector('.language-learning-card-close') as HTMLButtonElement;
		const copy = card.querySelector('.language-learning-card-copy') as HTMLButtonElement;
		expect(card.getAttribute('aria-modal')).toBe('true');
		expect(transcript.hasAttribute('inert')).toBe(true);
		expect(document.activeElement).toBe(close);

		copy.focus();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
		expect(document.activeElement).toBe(close);

		document.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'Tab',
			shiftKey: true,
			bubbles: true
		}));
		expect(document.activeElement).toBe(copy);
	});

	test('restores selection explanations to their transcript source after the transient trigger hides', async () => {
		const { controls, transcript, segments } = createTranscript();
		const source = segments[0];
		source.setAttribute('tabindex', '-1');
		const transientTrigger = document.createElement('button');
		document.body.appendChild(transientTrigger);
		transientTrigger.focus();
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn().mockResolvedValue('Explanation'),
				annotateJapaneseTranscript: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});

		const explanation = controller.explain(
			{ kind: 'word', text: 'Hello', context: 'Hello world.' },
			source
		);
		transientTrigger.hidden = true;
		await explanation;
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

		expect(document.activeElement).toBe(source);
	});

	test('caches completed translations across Reader rewiring and reports progress', async () => {
		const first = createTranscript(['Hello world.']);
		const progressLabels: string[] = [];
		const translateTranscript = vi.fn(async (
			_segments: string[],
			onProgress?: (progress: { completed: number; total: number; translations: string[] }) => void
		) => {
			onProgress?.({ completed: 0, total: 1, translations: [''] });
			progressLabels.push(first.controls.querySelector('.player-learning-progress')?.textContent || '');
			onProgress?.({ completed: 1, total: 1, translations: ['你好，世界。'] });
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
		const clearJapaneseReadings = vi.fn().mockResolvedValue(undefined);
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn(),
				annotateJapaneseTranscript,
				clearJapaneseReadings
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleJapaneseReadings();
		await controller.regenerateJapaneseReadings();

		expect(annotateJapaneseTranscript).toHaveBeenCalledTimes(2);
		expect(clearJapaneseReadings).toHaveBeenCalledWith(['日本語を勉強します。']);
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

	test('does not reuse an explanation cached for another response language', async () => {
		const { controls, transcript, segments } = createTranscript();
		const selection = { kind: 'word' as const, text: 'Hello', context: 'Hello world.' };
		const explainInEnglish = vi.fn().mockResolvedValue('hello: a greeting');
		const englishController = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			responseLanguage: 'English',
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: explainInEnglish,
				annotateJapaneseTranscript: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});
		await englishController.explain(selection);

		const explainInChinese = vi.fn().mockResolvedValue('你好：问候语');
		const chineseController = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			responseLanguage: 'Simplified Chinese',
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: explainInChinese,
				annotateJapaneseTranscript: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});

		await chineseController.explain(selection);

		expect(explainInEnglish).toHaveBeenCalledOnce();
		expect(explainInChinese).toHaveBeenCalledOnce();
		expect(document.querySelector('.language-learning-card-body')?.textContent)
			.toBe('你好：问候语');
	});

	test('ignores synthetic page events that could trigger paid AI requests', async () => {
		const { controls, transcript, segments } = createTranscript();
		const translateTranscript = vi.fn();
		const translateTranscriptToJapanese = vi.fn();
		const annotateJapaneseTranscript = vi.fn();
		const explainSelection = vi.fn();
		wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript,
				translateTranscriptToJapanese,
				explainSelection,
				annotateJapaneseTranscript
			},
			cancelPendingSeek: vi.fn()
		});
		const textNode = segments[0].querySelector('.transcript-segment-text')?.firstChild;
		if (!textNode) throw new Error('Missing transcript text');
		selectText(textNode, 0, textNode, 5);

		(controls.querySelector('.player-learning-action') as HTMLButtonElement).click();
		(controls.querySelector('.player-learning-readings') as HTMLButtonElement).click();
		transcript.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await new Promise(resolve => window.setTimeout(resolve, 0));

		expect(translateTranscript).not.toHaveBeenCalled();
		expect(translateTranscriptToJapanese).not.toHaveBeenCalled();
		expect(annotateJapaneseTranscript).not.toHaveBeenCalled();
		expect(explainSelection).not.toHaveBeenCalled();
	});

	test('cleanup removes learning UI and restores the modal background', async () => {
		const { controls, transcript, segments } = createTranscript();
		const controller = wireTranscriptLanguageLearning({
			doc: document,
			transcript,
			segments,
			controls,
			tools: {
				translateTranscript: vi.fn(),
				explainSelection: vi.fn().mockResolvedValue('Explanation'),
				annotateJapaneseTranscript: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});
		await controller.explain({ kind: 'word', text: 'Hello', context: 'Hello world.' });
		expect(transcript.hasAttribute('inert')).toBe(true);

		cleanupTranscriptLanguageLearning(document);

		expect(transcript.hasAttribute('inert')).toBe(false);
		expect(document.querySelector('.language-learning-card')).toBeNull();
		expect(document.querySelector('.language-learning-selection-action')).toBeNull();
		expect(document.querySelector('.player-learning-readings')).toBeNull();
	});
});
