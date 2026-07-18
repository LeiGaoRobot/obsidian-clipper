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
			${texts.map((text, index) => `
				<div class="transcript-segment">
					<strong class="timestamp" data-timestamp="${index * 200}">${index}:00</strong>
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

	test('lets a partial reading range be edited and regenerated in place', async () => {
		const { controls, transcript, segments } = createTranscript(['日本語', '漢字']);
		segments[0].classList.add('is-active');
		const annotateJapaneseTranscript = vi.fn()
			.mockResolvedValueOnce([[{ text: '日本語', reading: 'にほんご' }]])
			.mockResolvedValueOnce([[{ text: '日本語', reading: 'にっぽんご' }]]);
		const saveJapaneseReadings = vi.fn().mockResolvedValue(undefined);
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
				saveJapaneseReadings,
				clearJapaneseReadings
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

		await controller.regenerateJapaneseReadings();
		expect(clearJapaneseReadings).toHaveBeenCalledWith(['日本語']);
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

	test('shows an engine-aware task estimate and recovery switch', async () => {
		const { controls, transcript, segments } = createTranscript(['First.', 'Second.']);
		const timeout = Object.assign(new Error('grok failed'), {
			code: 'timeout',
			details: { mode: 'grok', timeoutSeconds: 120 }
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
				getExecutionInfo: vi.fn().mockResolvedValue({
					mode: 'grok',
					label: 'Grok CLI',
					promptCharLimit: 8
				}),
				setExecutionMode: vi.fn()
			},
			cancelPendingSeek: vi.fn()
		});

		await controller.toggleBilingual();

		expect(controls.querySelector('.player-learning-task-estimate')?.textContent)
			.toBe('readerTaskEstimate:2,2');
		expect((document.querySelector('.language-learning-card-engine-select') as HTMLSelectElement).value)
			.toBe('grok');
		expect(document.querySelector('.language-learning-card-engine-apply')?.textContent)
			.toBe('readerSwitchAndRetry');
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
					mode: 'grok',
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
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

		expect((document.querySelector('.language-learning-card') as HTMLElement).style.display).toBe('none');
		expect(document.activeElement).toBe(trigger);
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
