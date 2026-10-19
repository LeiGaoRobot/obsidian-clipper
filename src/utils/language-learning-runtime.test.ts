import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Settings } from '../types/types';
import { AiError } from '../ai/errors';
import { RequestCancelledError } from './request-cancellation';
import type { AiTaskInput } from '../ai/contracts';

const mocks = vi.hoisted(() => ({
	loadSettings: vi.fn(),
	runAiTask: vi.fn(),
	storageSessionGet: vi.fn(),
	storageSessionSet: vi.fn(),
	storageSessionRemove: vi.fn(),
	storageSessionState: {} as Record<string, unknown>,
	storageLocalGet: vi.fn(),
	storageLocalSet: vi.fn(),
	storageLocalState: {} as Record<string, unknown>,
	saveSettings: vi.fn(),
	copyToClipboard: vi.fn(),
	saveToObsidian: vi.fn()
}));

vi.mock('./browser-polyfill', () => ({
	default: {
		runtime: {},
		storage: {
			session: {
				get: mocks.storageSessionGet,
				set: mocks.storageSessionSet,
				remove: mocks.storageSessionRemove
			},
			local: {
				get: mocks.storageLocalGet,
				set: mocks.storageLocalSet
			}
		}
	}
}));
vi.mock('../ai/client', () => ({ runAiTask: mocks.runAiTask }));
vi.mock('./storage-utils', () => ({
	loadSettings: mocks.loadSettings,
	saveSettings: mocks.saveSettings
}));
vi.mock('./clipboard-utils', () => ({ copyToClipboard: mocks.copyToClipboard }));
vi.mock('./obsidian-note-creator', () => ({ saveToObsidian: mocks.saveToObsidian }));
vi.mock('./i18n', () => ({ getMessage: (key: string) => key }));

import { configuredLanguageLearning } from './language-learning-runtime';
import type { TranscriptReadingProgress } from './language-learning';

const settings: Settings = {
	vaults: [],
	showMoreActionsButton: false,
	betaFeatures: false,
	legacyMode: false,
	silentOpen: false,
	openBehavior: 'popup',
	highlighterEnabled: true,
	alwaysShowHighlights: true,
	highlightBehavior: 'highlight-inline',
	interpreterModel: 'model-1',
	models: [{
		id: 'model-1',
		providerId: 'provider-1',
		providerModelId: 'model',
		name: 'Model',
		enabled: true
	}],
	providers: [],
	interpreterEnabled: true,
	interpreterAutoRun: false,
	defaultPromptContext: '',
	propertyTypes: [],
	readerSettings: {
		fontSize: 16,
		lineHeight: 1.6,
		maxWidth: 38,
		lightTheme: 'default',
		darkTheme: 'same',
		appearance: 'auto',
		fonts: [],
		defaultFont: '',
		blendImages: true,
		colorLinks: false,
		followLinks: true,
		pinPlayer: true,
		autoScroll: true,
		highlightActiveLine: true,
		transcriptLayout: 'reading',
		learningResponseLanguage: 'Simplified Chinese',
		customCss: ''
	},
	stats: {
		addToObsidian: 0,
		saveFile: 0,
		copyToClipboard: 0,
		share: 0
	},
	history: [],
	ratings: [],
	saveBehavior: 'addToObsidian'
};

function aiResult(output: unknown, connectionKind = 'openai-compatible') {
	return { output, connectionKind };
}

type SegmentsInput = AiTaskInput<'translate'>;

function idsOf(input: SegmentsInput): number[] {
	return input.segments.map(segment => segment.id);
}

// Mirrors what toAiError builds from a Host NativeCliExecutionError timeout.
function cliTimeout(mode: string, seconds: number) {
	return new AiError('timeout', {
		detail: `${mode} CLI timed out after ${seconds} seconds.`,
		nativeCode: 'timeout',
		timeoutSeconds: seconds
	});
}

describe('Configured language learning runtime', () => {
	beforeEach(() => {
		mocks.loadSettings.mockReset();
		mocks.runAiTask.mockReset();
		mocks.storageSessionGet.mockReset();
		mocks.storageSessionSet.mockReset();
		mocks.storageSessionRemove.mockReset();
		mocks.storageLocalGet.mockReset();
		mocks.storageLocalSet.mockReset();
		mocks.saveSettings.mockReset();
		mocks.copyToClipboard.mockReset();
		mocks.saveToObsidian.mockReset();
		Object.keys(mocks.storageSessionState).forEach(key => delete mocks.storageSessionState[key]);
		Object.keys(mocks.storageLocalState).forEach(key => delete mocks.storageLocalState[key]);
		mocks.storageSessionGet.mockImplementation(async (key?: string | string[] | null) => {
			if (key == null) return { ...mocks.storageSessionState };
			const keys = Array.isArray(key) ? key : [key];
			return Object.fromEntries(keys.map(item => [item, mocks.storageSessionState[item]]));
		});
		mocks.storageSessionSet.mockImplementation(async (values: Record<string, unknown>) => {
			Object.assign(mocks.storageSessionState, values);
		});
		mocks.storageSessionRemove.mockImplementation(async (key: string | string[]) => {
			(Array.isArray(key) ? key : [key]).forEach(item => delete mocks.storageSessionState[item]);
		});
		mocks.storageLocalGet.mockImplementation(async (key: string) => ({
			[key]: mocks.storageLocalState[key]
		}));
		mocks.storageLocalSet.mockImplementation(async (values: Record<string, unknown>) => {
			Object.assign(mocks.storageLocalState, values);
		});
		mocks.saveSettings.mockResolvedValue(undefined);
		mocks.copyToClipboard.mockResolvedValue(true);
		mocks.saveToObsidian.mockResolvedValue(undefined);
		mocks.loadSettings.mockResolvedValue(settings);
	});

	test('reports the selected engine and can switch it explicitly', async () => {
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterExecutionMode: 'grok'
		});

		await expect(configuredLanguageLearning.getExecutionInfo()).resolves.toEqual({
			mode: 'grok',
			label: 'interpreterExecutionModeGrok',
			promptCharLimit: 1600
		});
		await configuredLanguageLearning.setExecutionMode('codex');

		expect(mocks.saveSettings).toHaveBeenCalledWith({ interpreterExecutionMode: 'codex' });
	});

	test('persists learner translation corrections for the next Reader session', async () => {
		await configuredLanguageLearning.saveTranscriptTranslations(['Hello.'], ['你好。']);
		const translations = await configuredLanguageLearning.translateTranscript(['Hello.']);

		expect(translations).toEqual(['你好。']);
		expect(mocks.runAiTask).not.toHaveBeenCalled();
	});

	test('loads saved translations without requiring an enabled Interpreter', async () => {
		await configuredLanguageLearning.saveTranscriptTranslations(['Hello.'], ['你好。']);
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterEnabled: false
		});
		mocks.runAiTask.mockClear();

		await expect(configuredLanguageLearning.loadTranscriptTranslations(['Hello.']))
			.resolves.toEqual(['你好。']);
		expect(mocks.runAiTask).not.toHaveBeenCalled();
	});

	test('reuses completed transcript work after an explicit engine switch', async () => {
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterExecutionMode: 'grok'
		});
		await configuredLanguageLearning.saveTranscriptTranslations(['Hello.'], ['你好。']);
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterExecutionMode: 'codex'
		});

		await expect(configuredLanguageLearning.translateTranscript(['Hello.']))
			.resolves.toEqual(['你好。']);
		expect(mocks.runAiTask).not.toHaveBeenCalled();
	});

	test('translates transcript to fixed Japanese without colliding with the configured response language', async () => {
		mocks.runAiTask.mockResolvedValue(aiResult([{ id: 0, text: 'こんにちは、世界。' }]));

		await expect(configuredLanguageLearning.translateTranscriptToJapanese(['Hello world.']))
			.resolves.toEqual(['こんにちは、世界。']);

		expect(mocks.runAiTask).toHaveBeenCalledWith(
			'translate',
			expect.objectContaining({
				instruction: expect.stringContaining('Translate each transcript segment into Japanese.'),
				segments: [{ id: 0, text: 'Hello world.' }]
			}),
			expect.anything()
		);
		expect(await configuredLanguageLearning.loadJapaneseTranscriptTranslations(['Hello world.']))
			.toEqual(['こんにちは、世界。']);
		expect(await configuredLanguageLearning.loadTranscriptTranslations(['Hello world.']))
			.toBeUndefined();
	});

	test('keeps fixed Japanese translation separate when the configured response language is Japanese', async () => {
		mocks.loadSettings.mockResolvedValue({
			...settings,
			readerSettings: {
				...settings.readerSettings,
				learningResponseLanguage: 'Japanese'
			}
		});
		await configuredLanguageLearning.saveTranscriptTranslations(['Hello world.'], ['手動の普通訳。']);
		mocks.runAiTask.mockResolvedValue(aiResult([{ id: 0, text: '固定の日本語訳。' }]));
		mocks.runAiTask.mockClear();

		await expect(configuredLanguageLearning.translateTranscriptToJapanese(['Hello world.']))
			.resolves.toEqual(['固定の日本語訳。']);
		expect(mocks.runAiTask).toHaveBeenCalledOnce();
		await expect(configuredLanguageLearning.loadTranscriptTranslations(['Hello world.']))
			.resolves.toEqual(['手動の普通訳。']);
	});

	test('loads saved Japanese transcript translation without an enabled Interpreter', async () => {
		mocks.runAiTask.mockResolvedValue(aiResult([{ id: 0, text: '日本語です。' }]));
		await configuredLanguageLearning.translateTranscriptToJapanese(['This is Japanese.']);
		mocks.loadSettings.mockResolvedValue({ ...settings, interpreterEnabled: false });
		mocks.runAiTask.mockClear();

		await expect(configuredLanguageLearning.loadJapaneseTranscriptTranslations(['This is Japanese.']))
			.resolves.toEqual(['日本語です。']);
		expect(mocks.runAiTask).not.toHaveBeenCalled();
	});

	test('clears a saved Japanese reading before explicit regeneration', async () => {
		const segments = ['日本語'];
		await configuredLanguageLearning.saveJapaneseReadings(segments, [[
			{ text: '日本語', reading: 'にほんご' }
		]]);
		await configuredLanguageLearning.clearJapaneseReadings(segments);
		mocks.runAiTask.mockResolvedValue(aiResult([{ id: 0, tokens: [{ text: '日本語', reading: 'にっぽんご' }] }]));

		await expect(configuredLanguageLearning.annotateJapaneseTranscript(segments)).resolves.toEqual([[
			{ text: '日本語', reading: 'にっぽんご' }
		]]);
		expect(mocks.runAiTask).toHaveBeenCalledWith(
			'reading',
			expect.objectContaining({ segments: [{ id: 0, text: '日本語' }] }),
			expect.anything()
		);
	});

	test('loads saved Japanese readings without requiring an enabled Interpreter', async () => {
		const segments = ['日本語'];
		const readings = [[{ text: '日本語', reading: 'にほんご' }]];
		await configuredLanguageLearning.saveJapaneseReadings(segments, readings);
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterEnabled: false
		});
		mocks.runAiTask.mockClear();

		await expect(configuredLanguageLearning.loadJapaneseReadings(segments))
			.resolves.toEqual(readings);
		expect(mocks.runAiTask).not.toHaveBeenCalled();
	});

	test('reuses personal Japanese readings without sending an AI request', async () => {
		await configuredLanguageLearning.saveJapaneseReadingOverride('日本語', 'にほんご');

		const readings = await configuredLanguageLearning.annotateJapaneseTranscript(['日本語です。']);

		expect(readings).toEqual([[
			{ text: '日本語', reading: 'にほんご' },
			{ text: 'です。', reading: '' }
		]]);
		expect(mocks.runAiTask).not.toHaveBeenCalled();
		expect(await configuredLanguageLearning.listJapaneseReadingDictionary()).toEqual([
			expect.objectContaining({ surface: '日本語', reading: 'にほんご' })
		]);
	});

	test('stores vocabulary locally and supports copy and Obsidian note actions', async () => {
		const selection = { kind: 'word' as const, text: 'encounter', context: 'An encounter.' };
		mocks.loadSettings.mockResolvedValue({ ...settings, vaults: ['Study'] });

		await expect(configuredLanguageLearning.isVocabularyFavorite(selection)).resolves.toBe(false);
		await expect(configuredLanguageLearning.toggleVocabularyFavorite(selection, '相遇；一次偶遇。'))
			.resolves.toBe(true);
		await expect(configuredLanguageLearning.isVocabularyFavorite(selection)).resolves.toBe(true);
		const entries = await configuredLanguageLearning.listVocabulary();
		expect(entries).toEqual([
			expect.objectContaining({ text: 'encounter', explanation: '相遇；一次偶遇。' })
		]);
		await configuredLanguageLearning.copyLearningText('encounter\n\n相遇');
		await configuredLanguageLearning.saveVocabularyToObsidian(selection, '相遇；一次偶遇。');

		expect(mocks.copyToClipboard).toHaveBeenCalledWith('encounter\n\n相遇');
		expect(mocks.saveToObsidian).toHaveBeenCalledWith(
			expect.stringContaining('相遇；一次偶遇。'),
			'encounter',
			'Language Learning',
			'Study',
			'create'
		);
		await configuredLanguageLearning.removeVocabulary(entries[0].id);
		await expect(configuredLanguageLearning.listVocabulary()).resolves.toEqual([]);
	});

	test('exports, clears, and imports saved vocabulary', async () => {
		const selection = { kind: 'word' as const, text: 'encounter', context: 'An encounter.' };
		await configuredLanguageLearning.toggleVocabularyFavorite(selection, '相遇');

		const exported = await configuredLanguageLearning.exportVocabulary();
		await configuredLanguageLearning.clearVocabulary();
		expect(await configuredLanguageLearning.listVocabulary()).toEqual([]);
		await expect(configuredLanguageLearning.importVocabulary(exported)).resolves.toBe(1);
		expect(await configuredLanguageLearning.listVocabulary()).toEqual([
			expect.objectContaining({ text: 'encounter', explanation: '相遇' })
		]);
	});

	test('sends model work through the extension background', async () => {
		mocks.runAiTask.mockResolvedValue(aiResult('encounter: 遇到'));

		const output = await configuredLanguageLearning.explainSelection({
			kind: 'word',
			text: 'encountered',
			context: 'I encountered an unfamiliar word.'
		});

		expect(output).toBe('encounter: 遇到');
		expect(mocks.runAiTask).toHaveBeenCalledWith(
			'explain',
			{
				instruction: 'Explain the selected word for a language learner in Simplified Chinese. Use only Simplified Chinese for all explanation text, labels, and translations. Include its lemma, pronunciation, meaning in this context, one concise usage note, and one example sentence. Return concise plain text.',
				content: 'Selected word: encountered\nContext: I encountered an unfamiliar word.'
			},
			expect.objectContaining({ signal: undefined })
		);
	});

	test('sends Japanese reading work through the extension background', async () => {
		mocks.runAiTask.mockResolvedValue(aiResult([{ id: 0, tokens: [{ text: '日本語', reading: 'にほんご' }] }]));

		const progress: TranscriptReadingProgress[] = [];
		const output = await configuredLanguageLearning.annotateJapaneseTranscript(
			['日本語'],
			next => progress.push(next)
		);

		expect(output).toEqual([[{ text: '日本語', reading: 'にほんご' }]]);
		expect(progress.map(({ readings: _readings, ...item }) => item)).toEqual([
			{ completed: 0, total: 1, completedSegments: 0, totalSegments: 1 },
			{ completed: 1, total: 1, completedSegments: 1, totalSegments: 1 }
		]);
		expect(progress[1].readings).toEqual([[{ text: '日本語', reading: 'にほんご' }]]);
		expect(mocks.storageSessionSet).toHaveBeenCalled();
		expect(mocks.runAiTask).toHaveBeenCalledWith(
			'reading',
			expect.objectContaining({
				instruction: expect.stringContaining('Annotate each Japanese transcript segment'),
				segments: [{ id: 0, text: '日本語' }]
			}),
			expect.anything()
		);
	});

	test('uses smaller Japanese reading batches for local CLI execution', async () => {
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterExecutionMode: 'grok'
		});
		const segmentA = '日'.repeat(800);
		const segmentB = '本'.repeat(800);
		mocks.runAiTask.mockImplementation((_task: string, input: SegmentsInput) => Promise.resolve(aiResult(
			input.segments.map(({ id, text }) => ({ id, tokens: [{ text, reading: 'ひ' }] }))
		)));
		const progress: TranscriptReadingProgress[] = [];

		const output = await configuredLanguageLearning.annotateJapaneseTranscript(
			[segmentA, segmentB],
			next => progress.push(next)
		);

		expect(output.map(tokens => tokens[0]?.text.length ?? 0)).toEqual([800, 800]);
		expect(output.map(tokens => tokens[0]?.reading ?? '')).toEqual(['ひ', 'ひ']);
		expect(progress.map(({ readings: _readings, ...item }) => item)).toEqual([
			{ completed: 0, total: 2, completedSegments: 0, totalSegments: 2 },
			{ completed: 1, total: 2, completedSegments: 1, totalSegments: 2 },
			{ completed: 2, total: 2, completedSegments: 2, totalSegments: 2 }
		]);
		expect(mocks.runAiTask).toHaveBeenCalledTimes(2);
		expect(mocks.runAiTask.mock.calls.map(call => idsOf(call[1]))).toEqual([[0], [1]]);
	});

	test('keeps the larger Japanese reading batch for Codex CLI', async () => {
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterExecutionMode: 'codex'
		});
		const segments = ['日'.repeat(800), '本'.repeat(800)];
		mocks.runAiTask.mockImplementation((_task: string, input: SegmentsInput) => Promise.resolve(aiResult(
			input.segments.map(({ id, text }) => ({ id, tokens: [{ text, reading: 'ひ' }] }))
		)));

		const output = await configuredLanguageLearning.annotateJapaneseTranscript(segments);

		expect(output.map(tokens => tokens[0]?.text.length ?? 0)).toEqual([800, 800]);
		expect(mocks.runAiTask).toHaveBeenCalledTimes(1);
		expect(mocks.runAiTask).toHaveBeenCalledWith(
			'reading',
			expect.objectContaining({
				segments: [{ id: 0, text: segments[0] }, { id: 1, text: segments[1] }]
			}),
			expect.anything()
		);
	});

	test('automatically reduces Codex translation batches after a timeout', async () => {
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterExecutionMode: 'codex'
		});
		const segments = ['A'.repeat(2500), 'B'.repeat(2500)];
		const requestedIds: number[][] = [];
		let timedOut = false;
		mocks.runAiTask.mockImplementation((_task: string, input: SegmentsInput) => {
			const ids = idsOf(input);
			requestedIds.push(ids);
			if (!timedOut && ids.length === 2) {
				timedOut = true;
				return Promise.reject(cliTimeout('codex', 300));
			}
			return Promise.resolve(aiResult(input.segments.map(({ id }) => ({
				id,
				text: id === 0 ? '第一段' : '第二段'
			}))));
		});

		const translations = await configuredLanguageLearning.translateTranscript(segments);

		expect(translations).toEqual(['第一段', '第二段']);
		expect(requestedIds).toEqual([[0, 1], [0], [1]]);
	});

	test('hides an exhausted local translation timeout behind a retryable error', async () => {
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterExecutionMode: 'codex'
		});
		mocks.runAiTask.mockRejectedValue(cliTimeout('codex', 300));

		await expect(configuredLanguageLearning.translateTranscript(['always fails']))
			.rejects.toMatchObject({
				code: 'failed',
				message: 'readerTranscriptTranslationBatchFailed'
			});
		expect(mocks.runAiTask).toHaveBeenCalledTimes(4);
		expect(mocks.runAiTask.mock.calls[3][0]).toBe('translate');
	});

	test('reduces Japanese reading batch size on explicit retry after a Grok timeout', async () => {
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterExecutionMode: 'grok'
		});
		const segments = ['日'.repeat(500), '本'.repeat(500)];
		const requestedIds: number[][] = [];
		mocks.runAiTask.mockImplementation((_task: string, input: SegmentsInput) => {
			const ids = idsOf(input);
			requestedIds.push(ids);
			if (ids.length === 2) {
				return Promise.reject(cliTimeout('grok', 300));
			}
			return Promise.resolve(aiResult(input.segments.map(({ id, text }) => ({
				id,
				tokens: [{ text, reading: 'ひ' }]
			}))));
		});

		await expect(configuredLanguageLearning.annotateJapaneseTranscript(segments))
			.rejects.toThrow(/aiErrorTimeoutBody.*readerJapaneseReadingsTimeoutRetry/);
		const readings = await configuredLanguageLearning.annotateJapaneseTranscript(segments);

		expect(readings.map(tokens => tokens[0]?.text.length ?? 0)).toEqual([500, 500]);
		expect(requestedIds).toEqual([[0, 1], [0], [1]]);
	});

	test('retries only Japanese reading segments missing after a failed batch', async () => {
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterExecutionMode: 'grok'
		});
		const segments = [
			'日'.repeat(500),
			'本'.repeat(500),
			'語'.repeat(500)
		];
		const requestedIds: number[][] = [];
		mocks.runAiTask.mockImplementation((_task: string, input: SegmentsInput) => {
			requestedIds.push(idsOf(input));
			if (requestedIds.length === 2) {
				return Promise.reject(cliTimeout('grok', 300));
			}
			// The gateway contract returns only requested ids.
			return Promise.resolve(aiResult(input.segments.map(({ id, text }) => ({
				id,
				tokens: [{ text, reading: requestedIds.length === 3 ? 'にゅー' : 'ひ' }]
			}))));
		});

		await expect(configuredLanguageLearning.annotateJapaneseTranscript(segments))
			.rejects.toThrow('aiErrorTimeoutBody');
		const retryProgress: TranscriptReadingProgress[] = [];
		const readings = await configuredLanguageLearning.annotateJapaneseTranscript(
			segments,
			next => retryProgress.push(next)
		);

		expect(readings.map(tokens => tokens[0]?.text.length ?? 0)).toEqual([500, 500, 500]);
		expect(requestedIds).toEqual([[0, 1], [2], [2]]);
		expect(readings.map(tokens => tokens[0].reading)).toEqual(['ひ', 'ひ', 'にゅー']);
		expect(retryProgress.map(({ readings: _readings, ...item }) => item)).toEqual([
			{ completed: 0, total: 1, completedSegments: 2, totalSegments: 3 },
			{ completed: 1, total: 1, completedSegments: 3, totalSegments: 3 }
		]);
	});

	test('persists completed translation batches and retries only missing segments', async () => {
		const segments = ['A'.repeat(3500), 'B'.repeat(3500)];
		const requestedIds: number[][] = [];
		mocks.runAiTask.mockImplementation((_task: string, input: SegmentsInput) => {
			requestedIds.push(idsOf(input));
			if (requestedIds.length === 2) {
				return Promise.reject(new AiError('timeout', { detail: 'provider timed out' }));
			}
			return Promise.resolve(aiResult(input.segments.map(({ id }) => ({
				id,
				text: id === 0 ? '第一段' : '第二段'
			}))));
		});

		await expect(configuredLanguageLearning.translateTranscript(segments))
			.rejects.toMatchObject({ code: 'failed', message: 'aiErrorTimeoutBody' });
		const translations = await configuredLanguageLearning.translateTranscript(segments);

		expect(translations).toEqual(['第一段', '第二段']);
		expect(requestedIds).toEqual([[0], [1], [1]]);
		expect(mocks.storageSessionSet).toHaveBeenCalled();
	});

	test('passes the abort signal to the AI gateway and surfaces cancellation', async () => {
		const abortController = new AbortController();
		mocks.runAiTask.mockImplementation((
			_task: string,
			_input: unknown,
			options?: { signal?: AbortSignal }
		) => new Promise((_resolve, reject) => {
			options?.signal?.addEventListener('abort', () => reject(new AiError('cancelled')));
		}));

		const request = configuredLanguageLearning.explainSelection({
			kind: 'word',
			text: 'encountered',
			context: 'I encountered an unfamiliar word.'
		}, abortController.signal);
		await vi.waitFor(() => expect(mocks.runAiTask).toHaveBeenCalledWith(
			'explain',
			expect.anything(),
			expect.objectContaining({ signal: abortController.signal })
		));
		abortController.abort();

		await expect(request).rejects.toBeInstanceOf(RequestCancelledError);
	});

	test('surfaces a gateway cancellation as RequestCancelledError', async () => {
		mocks.runAiTask.mockRejectedValue(new AiError('cancelled'));

		await expect(configuredLanguageLearning.explainSelection({
			kind: 'word',
			text: 'encountered',
			context: 'I encountered an unfamiliar word.'
		})).rejects.toBeInstanceOf(RequestCancelledError);
	});

	test('maps non-timeout gateway errors to a failed request with localized text', async () => {
		mocks.runAiTask.mockRejectedValue(new AiError('auth', { status: 401, detail: 'invalid key' }));

		const error = await configuredLanguageLearning.explainSelection({
			kind: 'word',
			text: 'encountered',
			context: 'I encountered an unfamiliar word.'
		}).catch(caught => caught);

		expect(error).toMatchObject({
			name: 'LanguageLearningRequestError',
			code: 'failed',
			message: 'aiErrorAuthBody',
			details: expect.objectContaining({ aiCode: 'auth', technicalDetail: 'invalid key' })
		});
	});

	test('preserves structured CLI errors for localized Reader recovery', async () => {
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterExecutionMode: 'grok'
		});
		mocks.runAiTask.mockRejectedValue(cliTimeout('grok', 120));

		await expect(configuredLanguageLearning.explainSelection({
			kind: 'word',
			text: '日本語',
			context: '日本語を勉強します。'
		})).rejects.toMatchObject({
			name: 'LanguageLearningRequestError',
			code: 'timeout',
			details: expect.objectContaining({ mode: 'grok', timeoutSeconds: 120 })
		});
	});

	test.each([
		['cli-failed', 'provider-error'],
		['config', 'cli-missing'],
		['response-too-large', 'bad-response'],
		['invalid', 'provider-error'],
		['protocol-mismatch', 'host-outdated']
	])('keeps the Host %s code for the Reader card', async (nativeCode, aiCode) => {
		mocks.loadSettings.mockResolvedValue({ ...settings, interpreterExecutionMode: 'codex' });
		mocks.runAiTask.mockRejectedValue(new AiError(aiCode as never, { nativeCode, detail: 'Host said no' }));

		await expect(configuredLanguageLearning.explainSelection({
			kind: 'word',
			text: '日本語',
			context: '日本語を勉強します。'
		})).rejects.toMatchObject({
			name: 'LanguageLearningRequestError',
			code: nativeCode,
			details: expect.objectContaining({ mode: 'codex', aiCode, technicalDetail: 'Host said no' })
		});
	});

	test('reports API timeouts with gateway copy instead of the CLI timeout card', async () => {
		mocks.runAiTask.mockRejectedValue(new AiError('timeout', {
			detail: 'No response from the provider for 60 seconds.',
			timeoutSeconds: 60
		}));

		await expect(configuredLanguageLearning.explainSelection({
			kind: 'word',
			text: '日本語',
			context: '日本語を勉強します。'
		})).rejects.toMatchObject({
			code: 'failed',
			message: 'aiErrorTimeoutBody',
			details: expect.objectContaining({ mode: 'api', aiCode: 'timeout', timeoutSeconds: 60 })
		});
	});
});
