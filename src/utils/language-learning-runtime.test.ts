import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Settings } from '../types/types';
import { AiError } from '../ai/errors';
import { transcriptJobId, type TranscriptJobIdentity, type TranscriptJobTask } from '../ai/job-identity';
import type { TranscriptSegment } from '../ai/contracts';
import { RequestCancelledError } from './request-cancellation';

const mocks = vi.hoisted(() => ({
	loadSettings: vi.fn(),
	runAiTask: vi.fn(),
	runTranscriptJob: vi.fn(),
	loadTranscriptCheckpoint: vi.fn(),
	saveTranscriptCheckpoint: vi.fn(),
	clearTranscriptCheckpoint: vi.fn(),
	// The model behind the fake background job: answers the ids the job still needs.
	executeJob: vi.fn(),
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
			local: {
				get: mocks.storageLocalGet,
				set: mocks.storageLocalSet
			}
		}
	}
}));
vi.mock('../ai/client', () => ({ runAiTask: mocks.runAiTask }));
vi.mock('../ai/job-client', async importOriginal => ({
	...await importOriginal<typeof import('../ai/job-client')>(),
	runTranscriptJob: mocks.runTranscriptJob,
	loadTranscriptCheckpoint: mocks.loadTranscriptCheckpoint,
	saveTranscriptCheckpoint: mocks.saveTranscriptCheckpoint,
	clearTranscriptCheckpoint: mocks.clearTranscriptCheckpoint
}));
vi.mock('./storage-utils', () => ({
	loadSettings: mocks.loadSettings,
	saveSettings: mocks.saveSettings
}));
vi.mock('./clipboard-utils', () => ({ copyToClipboard: mocks.copyToClipboard }));
vi.mock('./obsidian-note-creator', () => ({ saveToObsidian: mocks.saveToObsidian }));
vi.mock('./i18n', () => ({ getMessage: (key: string) => key }));

import { withJobAttempts } from '../ai/job-client';
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

type JobValue = string | Array<{ text: string; reading: string }>;

interface FakeJobRecord {
	task: TranscriptJobTask;
	status: 'running' | 'completed' | 'incomplete' | 'failed';
	values: JobValue[];
}

// A stand-in for the background gateway: records by job id, reuse of earlier results, and one
// executeJob call for the segments still missing, with values aligned like the real client.
const records = new Map<string, FakeJobRecord>();

function isEmptySource(task: TranscriptJobTask, text: string): boolean {
	return task === 'reading' ? text === '' : text.trim() === '';
}

function hasValue(value: JobValue | undefined): boolean {
	return Array.isArray(value) ? value.length > 0 : Boolean(value?.trim());
}

function emptyValue(task: TranscriptJobTask): JobValue {
	return task === 'translate' ? '' : [];
}

function isDone(task: TranscriptJobTask, segments: TranscriptSegment[], values: JobValue[]): boolean {
	return segments.every(({ id, text }) => isEmptySource(task, text) || hasValue(values[id]));
}

function installFakeJobGateway() {
	records.clear();
	mocks.runTranscriptJob.mockImplementation(async (
		task: TranscriptJobTask,
		input: { instruction: string; segments: TranscriptSegment[]; identity: TranscriptJobIdentity },
		options: { signal?: AbortSignal; onProgress?: (progress: unknown) => void } = {}
	) => {
		const id = transcriptJobId(task, input.identity, input.segments);
		const values = input.segments.map(({ id: index }) => records.get(id)?.values[index] ?? emptyValue(task));
		const missing = input.segments.filter(({ id: index, text }) => !isEmptySource(task, text) && !hasValue(values[index]));
		const report = (completedGroups: number) => options.onProgress?.({
			completedGroups,
			totalGroups: missing.length > 0 ? 1 : 0,
			completedSegments: input.segments.filter(({ id: index, text }) => isEmptySource(task, text) || hasValue(values[index])).length,
			totalSegments: input.segments.length,
			values: values.map(value => (Array.isArray(value) ? value.map(token => ({ ...token })) : value))
		});
		report(0);
		if (missing.length > 0) {
			let items: Array<{ id: number; text?: string; tokens?: JobValue }>;
			try {
				items = await mocks.executeJob(task, { instruction: input.instruction, segments: missing }, options);
			} catch (error) {
				records.set(id, { task, status: 'failed', values });
				throw error;
			}
			for (const item of items) {
				if (missing.some(segment => segment.id === item.id)) values[item.id] = (item.text ?? item.tokens) as JobValue;
			}
			report(1);
		}
		const status = isDone(task, input.segments, values) ? 'completed' : 'incomplete';
		records.set(id, { task, status, values });
		return { status, values, results: [], attempts: { requests: missing.length > 0 ? 1 : 0, retries: 0, splits: 0 } };
	});
	mocks.loadTranscriptCheckpoint.mockImplementation(async (
		task: TranscriptJobTask,
		identity: TranscriptJobIdentity,
		segments: TranscriptSegment[]
	) => {
		const record = records.get(transcriptJobId(task, identity, segments));
		return record ? { status: record.status, values: [...record.values], completedSegments: 0, totalSegments: segments.length } : undefined;
	});
	mocks.saveTranscriptCheckpoint.mockImplementation(async (
		task: TranscriptJobTask,
		identity: TranscriptJobIdentity,
		segments: TranscriptSegment[],
		values: JobValue[]
	) => {
		records.set(transcriptJobId(task, identity, segments), {
			task,
			status: isDone(task, segments, values) ? 'completed' : 'incomplete',
			values: [...values]
		});
		return true;
	});
	mocks.clearTranscriptCheckpoint.mockImplementation(async (
		task: TranscriptJobTask,
		identity: TranscriptJobIdentity,
		segments: TranscriptSegment[]
	) => records.delete(transcriptJobId(task, identity, segments)));
}

function segmentsOf(texts: string[]): TranscriptSegment[] {
	return texts.map((text, id) => ({ id, text }));
}

function requestedIds(): number[][] {
	return mocks.executeJob.mock.calls.map(call => (call[1] as { segments: TranscriptSegment[] }).segments.map(segment => segment.id));
}

// Mirrors what toAiError builds from a Host NativeCliExecutionError timeout.
function cliTimeout(mode: string, seconds: number) {
	return new AiError('timeout', {
		detail: `${mode} CLI timed out after ${seconds} seconds.`,
		nativeCode: 'timeout',
		timeoutSeconds: seconds
	});
}

const READINGS = { namespace: 'japanese-readings', scope: 'shared' };

describe('Configured language learning runtime', () => {
	beforeEach(() => {
		mocks.loadSettings.mockReset();
		mocks.runAiTask.mockReset();
		mocks.runTranscriptJob.mockReset();
		mocks.loadTranscriptCheckpoint.mockReset();
		mocks.saveTranscriptCheckpoint.mockReset();
		mocks.clearTranscriptCheckpoint.mockReset();
		mocks.executeJob.mockReset();
		mocks.storageLocalGet.mockReset();
		mocks.storageLocalSet.mockReset();
		mocks.saveSettings.mockReset();
		mocks.copyToClipboard.mockReset();
		mocks.saveToObsidian.mockReset();
		Object.keys(mocks.storageLocalState).forEach(key => delete mocks.storageLocalState[key]);
		installFakeJobGateway();
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
		expect(mocks.saveTranscriptCheckpoint).toHaveBeenCalledWith(
			'translate',
			{ namespace: 'translations', scope: 'shared:Simplified Chinese' },
			[{ id: 0, text: 'Hello.' }],
			['你好。']
		);
		expect(mocks.executeJob).not.toHaveBeenCalled();
		expect(mocks.runAiTask).not.toHaveBeenCalled();
	});

	test('loads saved translations without requiring an enabled Interpreter', async () => {
		await configuredLanguageLearning.saveTranscriptTranslations(['Hello.'], ['你好。']);
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterEnabled: false
		});

		await expect(configuredLanguageLearning.loadTranscriptTranslations(['Hello.']))
			.resolves.toEqual(['你好。']);
		expect(mocks.runTranscriptJob).not.toHaveBeenCalled();
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
		expect(mocks.executeJob).not.toHaveBeenCalled();
	});

	test('translates a transcript as one background job under the response-language scope', async () => {
		mocks.executeJob.mockImplementation(async (_task: string, input: { segments: TranscriptSegment[] }) => (
			input.segments.map(({ id }) => ({ id, text: `T${id}` }))
		));
		const progress: unknown[] = [];

		await expect(configuredLanguageLearning.translateTranscript(['A', 'B'], next => progress.push(next)))
			.resolves.toEqual(['T0', 'T1']);

		expect(mocks.runTranscriptJob).toHaveBeenCalledOnce();
		expect(mocks.runTranscriptJob).toHaveBeenCalledWith(
			'translate',
			{
				instruction: expect.stringContaining('Translate each transcript segment into Simplified Chinese.'),
				segments: [{ id: 0, text: 'A' }, { id: 1, text: 'B' }],
				identity: { namespace: 'translations', scope: 'shared:Simplified Chinese' }
			},
			expect.objectContaining({ onProgress: expect.any(Function), onRetry: expect.any(Function) })
		);
		expect(progress).toEqual([
			{ completed: 0, total: 1, translations: ['', ''] },
			{ completed: 1, total: 1, translations: ['T0', 'T1'] }
		]);
		expect(mocks.runAiTask).not.toHaveBeenCalled();
	});

	test('translates transcript to fixed Japanese without colliding with the configured response language', async () => {
		mocks.executeJob.mockResolvedValue([{ id: 0, text: 'こんにちは、世界。' }]);

		await expect(configuredLanguageLearning.translateTranscriptToJapanese(['Hello world.']))
			.resolves.toEqual(['こんにちは、世界。']);

		expect(mocks.runTranscriptJob).toHaveBeenCalledWith(
			'translate',
			expect.objectContaining({
				instruction: expect.stringContaining('Translate each transcript segment into Japanese.'),
				segments: [{ id: 0, text: 'Hello world.' }],
				identity: { namespace: 'translations', scope: 'japanese-readings:Japanese' }
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
		mocks.executeJob.mockResolvedValue([{ id: 0, text: '固定の日本語訳。' }]);

		await expect(configuredLanguageLearning.translateTranscriptToJapanese(['Hello world.']))
			.resolves.toEqual(['固定の日本語訳。']);
		expect(mocks.executeJob).toHaveBeenCalledOnce();
		await expect(configuredLanguageLearning.loadTranscriptTranslations(['Hello world.']))
			.resolves.toEqual(['手動の普通訳。']);
	});

	test('loads saved Japanese transcript translation without an enabled Interpreter', async () => {
		mocks.executeJob.mockResolvedValue([{ id: 0, text: '日本語です。' }]);
		await configuredLanguageLearning.translateTranscriptToJapanese(['This is Japanese.']);
		mocks.loadSettings.mockResolvedValue({ ...settings, interpreterEnabled: false });
		mocks.runTranscriptJob.mockClear();

		await expect(configuredLanguageLearning.loadJapaneseTranscriptTranslations(['This is Japanese.']))
			.resolves.toEqual(['日本語です。']);
		expect(mocks.runTranscriptJob).not.toHaveBeenCalled();
	});

	test('restores only completed records and never starts or resumes a job', async () => {
		const segments = ['Hello.', 'Bye.'];
		const id = transcriptJobId('translate', { namespace: 'translations', scope: 'shared:Simplified Chinese' }, segmentsOf(segments));
		for (const status of ['running', 'incomplete', 'failed'] as const) {
			records.set(id, { task: 'translate', status, values: ['你好。', '再见。'] });
			await expect(configuredLanguageLearning.loadTranscriptTranslations(segments)).resolves.toBeUndefined();
		}
		records.set(id, { task: 'translate', status: 'completed', values: ['你好。', '再见。'] });
		await expect(configuredLanguageLearning.loadTranscriptTranslations(segments)).resolves.toEqual(['你好。', '再见。']);

		mocks.loadTranscriptCheckpoint.mockRejectedValue(new AiError('network'));
		await expect(configuredLanguageLearning.loadTranscriptTranslations(segments)).resolves.toBeUndefined();
		await expect(configuredLanguageLearning.loadJapaneseTranscriptTranslations(segments)).resolves.toBeUndefined();
		await expect(configuredLanguageLearning.loadJapaneseReadings(['日本語'])).resolves.toBeUndefined();
		expect(mocks.runTranscriptJob).not.toHaveBeenCalled();
		expect(mocks.executeJob).not.toHaveBeenCalled();
	});

	test('a completed translation counts blank source segments as complete', async () => {
		await configuredLanguageLearning.saveTranscriptTranslations(['Hello.', ''], ['你好。', '']);

		await expect(configuredLanguageLearning.loadTranscriptTranslations(['Hello.', '']))
			.resolves.toEqual(['你好。', '']);
	});

	test('clears a saved Japanese reading before explicit regeneration', async () => {
		const segments = ['日本語'];
		await configuredLanguageLearning.saveJapaneseReadings(segments, [[
			{ text: '日本語', reading: 'にほんご' }
		]]);
		await configuredLanguageLearning.clearJapaneseReadings(segments);
		mocks.executeJob.mockResolvedValue([{ id: 0, tokens: [{ text: '日本語', reading: 'にっぽんご' }] }]);

		await expect(configuredLanguageLearning.annotateJapaneseTranscript(segments)).resolves.toEqual([[
			{ text: '日本語', reading: 'にっぽんご' }
		]]);
		expect(mocks.clearTranscriptCheckpoint).toHaveBeenCalledWith('reading', READINGS, [{ id: 0, text: '日本語' }]);
		expect(requestedIds()).toEqual([[0]]);
	});

	test('regeneration also clears the job of the subset the personal dictionary leaves unresolved', async () => {
		await configuredLanguageLearning.saveJapaneseReadingOverride('日本語', 'にほんご');

		await configuredLanguageLearning.clearJapaneseReadings(['日本語です。', '漢字']);

		expect(mocks.clearTranscriptCheckpoint.mock.calls).toEqual([
			['reading', READINGS, [{ id: 0, text: '日本語です。' }, { id: 1, text: '漢字' }]],
			['reading', READINGS, [{ id: 0, text: '漢字' }]]
		]);
	});

	test('loads saved Japanese readings without requiring an enabled Interpreter', async () => {
		const segments = ['日本語'];
		const readings = [[{ text: '日本語', reading: 'にほんご' }]];
		await configuredLanguageLearning.saveJapaneseReadings(segments, readings);
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterEnabled: false
		});

		await expect(configuredLanguageLearning.loadJapaneseReadings(segments))
			.resolves.toEqual(readings);
		expect(mocks.runTranscriptJob).not.toHaveBeenCalled();
	});

	test('saving readings is a checkpoint of the full set under the shared readings identity', async () => {
		const segments = ['日本語', ''];
		const readings = [[{ text: '日本語', reading: 'にほんご' }], []];

		await configuredLanguageLearning.saveJapaneseReadings(segments, readings);

		expect(mocks.saveTranscriptCheckpoint).toHaveBeenCalledWith(
			'reading',
			READINGS,
			[{ id: 0, text: '日本語' }, { id: 1, text: '' }],
			readings
		);
		await expect(configuredLanguageLearning.loadJapaneseReadings(segments)).resolves.toEqual(readings);
	});

	test('a refused or failed save stays silent', async () => {
		mocks.saveTranscriptCheckpoint.mockRejectedValue(new AiError('network'));

		await expect(configuredLanguageLearning.saveJapaneseReadings(['日本'], [[{ text: '日本', reading: 'にほん' }]]))
			.resolves.toBeUndefined();
		await expect(configuredLanguageLearning.saveTranscriptTranslations(['Hello.'], ['你好。']))
			.resolves.toBeUndefined();
	});

	test('reuses personal Japanese readings without sending an AI request', async () => {
		await configuredLanguageLearning.saveJapaneseReadingOverride('日本語', 'にほんご');

		const readings = await configuredLanguageLearning.annotateJapaneseTranscript(['日本語です。']);

		expect(readings).toEqual([[
			{ text: '日本語', reading: 'にほんご' },
			{ text: 'です。', reading: '' }
		]]);
		expect(mocks.runTranscriptJob).not.toHaveBeenCalled();
		expect(mocks.runAiTask).not.toHaveBeenCalled();
		expect(await configuredLanguageLearning.listJapaneseReadingDictionary()).toEqual([
			expect.objectContaining({ surface: '日本語', reading: 'にほんご' })
		]);
	});

	test('runs the reading job only on segments the dictionary leaves unresolved and merges them back', async () => {
		await configuredLanguageLearning.saveJapaneseReadingOverride('日本語', 'にほんご');
		mocks.executeJob.mockResolvedValue([{ id: 0, tokens: [{ text: '漢字', reading: 'かんじ' }] }]);
		const progress: TranscriptReadingProgress[] = [];

		const readings = await configuredLanguageLearning.annotateJapaneseTranscript(
			['日本語です。', '漢字'],
			next => progress.push(next)
		);

		expect(mocks.runTranscriptJob).toHaveBeenCalledWith(
			'reading',
			expect.objectContaining({ segments: [{ id: 0, text: '漢字' }], identity: READINGS }),
			expect.anything()
		);
		expect(readings).toEqual([
			[{ text: '日本語', reading: 'にほんご' }, { text: 'です。', reading: '' }],
			[{ text: '漢字', reading: 'かんじ' }]
		]);
		expect(progress.map(({ readings: _readings, ...item }) => item)).toEqual([
			{ completed: 0, total: 1, completedSegments: 1, totalSegments: 2 },
			{ completed: 1, total: 1, completedSegments: 2, totalSegments: 2 }
		]);
		expect(progress[1].readings).toEqual(readings);
	});

	test('passes a retry backoff through the merged reading progress', async () => {
		mocks.runTranscriptJob.mockImplementation(async (_task, input: { segments: TranscriptSegment[] }, options: {
			onProgress?: (progress: unknown) => void;
			onRetry?: (retry: unknown) => void;
		}) => {
			options.onProgress?.({ completedGroups: 0, totalGroups: 1, completedSegments: 0, totalSegments: 1, values: [[]] });
			options.onRetry?.({ code: 'rate-limited', status: 429, delayMs: 4000, attempt: 1 });
			return { status: 'completed', values: [[{ text: input.segments[0].text, reading: 'かんじ' }]] };
		});
		const progress: TranscriptReadingProgress[] = [];

		await configuredLanguageLearning.annotateJapaneseTranscript(['漢字'], next => progress.push(next));

		expect(progress[1]).toMatchObject({ completed: 0, total: 1, retry: { delayMs: 4000, attempt: 1 } });
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

	test('sends Japanese reading work through the background job', async () => {
		mocks.executeJob.mockResolvedValue([{ id: 0, tokens: [{ text: '日本語', reading: 'にほんご' }] }]);

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
		expect(mocks.runTranscriptJob).toHaveBeenCalledWith(
			'reading',
			{
				instruction: expect.stringContaining('Annotate each Japanese transcript segment'),
				segments: [{ id: 0, text: '日本語' }],
				identity: READINGS
			},
			expect.anything()
		);
		expect(mocks.runAiTask).not.toHaveBeenCalled();
	});

	test('a CLI timeout after automatic splits asks the learner to continue the remaining batches', async () => {
		mocks.loadSettings.mockResolvedValue({ ...settings, interpreterExecutionMode: 'codex' });
		mocks.executeJob.mockRejectedValue(withJobAttempts(cliTimeout('codex', 300), { requests: 4, retries: 0, splits: 3 }));

		await expect(configuredLanguageLearning.translateTranscript(['always fails']))
			.rejects.toMatchObject({
				code: 'failed',
				message: 'readerTranscriptTranslationBatchFailed',
				details: expect.objectContaining({ mode: 'codex', automaticBatchRetry: true, aiCode: 'timeout' })
			});
		await expect(configuredLanguageLearning.annotateJapaneseTranscript(['漢字']))
			.rejects.toMatchObject({
				code: 'failed',
				message: 'readerTranscriptTranslationBatchFailed',
				details: expect.objectContaining({ automaticBatchRetry: true })
			});
	});

	test('a CLI timeout without splits keeps the localized CLI timeout card', async () => {
		mocks.loadSettings.mockResolvedValue({ ...settings, interpreterExecutionMode: 'grok' });
		mocks.executeJob.mockRejectedValue(withJobAttempts(cliTimeout('grok', 120), { requests: 1, retries: 0, splits: 0 }));

		const error = await configuredLanguageLearning.annotateJapaneseTranscript(['漢字']).catch(caught => caught);

		expect(error).toMatchObject({
			name: 'LanguageLearningRequestError',
			code: 'timeout',
			details: expect.objectContaining({ mode: 'grok', timeoutSeconds: 120 })
		});
		expect(error.details.automaticBatchRetry).toBeUndefined();
		expect(error.message).not.toContain('readerJapaneseReadingsTimeoutRetry');
	});

	test('an API timeout of a transcript job is not mapped to a batch failure', async () => {
		mocks.executeJob.mockRejectedValue(withJobAttempts(
			new AiError('timeout', { detail: 'provider timed out' }),
			{ requests: 1, retries: 0, splits: 0 }
		));

		await expect(configuredLanguageLearning.translateTranscript(['A']))
			.rejects.toMatchObject({ code: 'failed', message: 'aiErrorTimeoutBody' });
	});

	test('a cancelled transcript job surfaces as RequestCancelledError', async () => {
		mocks.executeJob.mockRejectedValue(new AiError('cancelled'));

		await expect(configuredLanguageLearning.translateTranscript(['A'])).rejects.toBeInstanceOf(RequestCancelledError);
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
