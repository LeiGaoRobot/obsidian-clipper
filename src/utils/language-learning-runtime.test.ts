import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Settings } from '../types/types';

const mocks = vi.hoisted(() => ({
	loadSettings: vi.fn(),
	sendMessage: vi.fn(),
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
		runtime: { sendMessage: mocks.sendMessage },
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

describe('Configured language learning runtime', () => {
	beforeEach(() => {
		mocks.loadSettings.mockReset();
		mocks.sendMessage.mockReset();
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
		expect(mocks.sendMessage).not.toHaveBeenCalled();
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
		expect(mocks.sendMessage).not.toHaveBeenCalled();
	});

	test('clears a saved Japanese reading before explicit regeneration', async () => {
		const segments = ['日本語'];
		await configuredLanguageLearning.saveJapaneseReadings(segments, [[
			{ text: '日本語', reading: 'にほんご' }
		]]);
		await configuredLanguageLearning.clearJapaneseReadings(segments);
		mocks.sendMessage.mockResolvedValue({
			success: true,
			promptResponses: [{
				key: 'prompt_1',
				prompt: 'annotate',
				user_response: '0|||[["日本語","にっぽんご"]]'
			}]
		});

		await expect(configuredLanguageLearning.annotateJapaneseTranscript(segments)).resolves.toEqual([[
			{ text: '日本語', reading: 'にっぽんご' }
		]]);
		expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			action: 'languageLearningRequest'
		}));
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

	test('sends model work through the extension background', async () => {
		mocks.sendMessage.mockResolvedValue({
			success: true,
			promptResponses: [{
				key: 'prompt_1',
				prompt: 'explain',
				user_response: 'encounter: 遇到'
			}]
		});

		const output = await configuredLanguageLearning.explainSelection({
			kind: 'word',
			text: 'encountered',
			context: 'I encountered an unfamiliar word.'
		});

		expect(output).toBe('encounter: 遇到');
		expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			action: 'languageLearningRequest',
			request: {
				context: 'Selected word: encountered\nContext: I encountered an unfamiliar word.',
				prompts: [{
					key: 'prompt_1',
					prompt: 'Explain the selected word for a language learner in Simplified Chinese. Use only Simplified Chinese for all explanation text, labels, and translations. Include its lemma, pronunciation, meaning in this context, one concise usage note, and one example sentence. Return concise plain text.'
				}]
			}
		}));
	});

		test('sends Japanese reading work through the extension background', async () => {
		mocks.sendMessage.mockResolvedValue({
			success: true,
			promptResponses: [{
				key: 'prompt_1',
				prompt: 'annotate',
				user_response: '0|||[{"text":"日本語","reading":"にほんご"}]'
			}]
		});

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
		expect(mocks.sendMessage).toHaveBeenCalledWith({
			action: 'languageLearningRequest',
			requestId: expect.any(String),
			request: expect.objectContaining({
				context: 'Annotate Japanese transcript segments with aligned ruby readings.'
			})
		});
	});

	test('uses smaller Japanese reading batches for local CLI execution', async () => {
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterExecutionMode: 'grok'
		});
		const segmentA = '日'.repeat(800);
		const segmentB = '本'.repeat(800);
		mocks.sendMessage.mockImplementation((message: {
			action: string;
			request?: { prompts: Array<{ prompt: string }> };
		}) => {
			if (message.action !== 'languageLearningRequest' || !message.request) {
				return Promise.resolve({ success: true });
			}
			const prompt = message.request.prompts[0].prompt;
			const segmentId = prompt.includes('0|||') ? 0 : 1;
			const text = segmentId === 0 ? segmentA : segmentB;
			return Promise.resolve({
				success: true,
				promptResponses: [{
					key: 'prompt_1',
					prompt,
					user_response: `${segmentId}|||[{"text":"${text}","reading":"ひ"}]`
				}]
			});
		});
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
		expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
	});

	test('keeps the larger Japanese reading batch for Codex CLI', async () => {
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterExecutionMode: 'codex'
		});
		const segments = ['日'.repeat(800), '本'.repeat(800)];
		mocks.sendMessage.mockImplementation((message: {
			action: string;
			request?: { prompts: Array<{ prompt: string }> };
		}) => {
			if (message.action !== 'languageLearningRequest' || !message.request) {
				return Promise.resolve({ success: true });
			}
			const prompt = message.request.prompts[0].prompt;
			return Promise.resolve({
				success: true,
				promptResponses: [{
					key: 'prompt_1',
					prompt,
					user_response: segments.map((segment, index) => (
						`${index}|||[["${segment}","ひ"]]`
					)).join('\n')
				}]
			});
		});

		const output = await configuredLanguageLearning.annotateJapaneseTranscript(segments);

		expect(output.map(tokens => tokens[0]?.text.length ?? 0)).toEqual([800, 800]);
		expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
		expect(mocks.sendMessage.mock.calls[0][0].request.prompts[0].prompt)
			.toContain('0|||');
		expect(mocks.sendMessage.mock.calls[0][0].request.prompts[0].prompt)
			.toContain('1|||');
	});

	test('reduces Japanese reading batch size on explicit retry after a Grok timeout', async () => {
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterExecutionMode: 'grok'
		});
		const segments = ['日'.repeat(500), '本'.repeat(500)];
		const requestedPrompts: string[] = [];
		mocks.sendMessage.mockImplementation((message: {
			action: string;
			request?: { prompts: Array<{ prompt: string }> };
		}) => {
			if (message.action !== 'languageLearningRequest' || !message.request) {
				return Promise.resolve({ success: true });
			}
			const prompt = message.request.prompts[0].prompt;
			requestedPrompts.push(prompt);
			if (prompt.includes('0|||') && prompt.includes('1|||')) {
				return Promise.reject(new Error('grok CLI timed out after 120 seconds.'));
			}
			const index = prompt.includes('0|||') ? 0 : 1;
			return Promise.resolve({
				success: true,
				promptResponses: [{
					key: 'prompt_1',
					prompt,
					user_response: `${index}|||[["${segments[index]}","ひ"]]`
				}]
			});
		});

		await expect(configuredLanguageLearning.annotateJapaneseTranscript(segments))
			.rejects.toThrow(/grok CLI timed out after 120 seconds.*readerJapaneseReadingsTimeoutRetry/);
		const readings = await configuredLanguageLearning.annotateJapaneseTranscript(segments);

		expect(readings.map(tokens => tokens[0]?.text.length ?? 0)).toEqual([500, 500]);
		expect(requestedPrompts).toHaveLength(3);
		expect(requestedPrompts[1]).toContain('0|||');
		expect(requestedPrompts[1]).not.toContain('1|||');
		expect(requestedPrompts[2]).toContain('1|||');
		expect(requestedPrompts[2]).not.toContain('0|||');
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
		const requestedPrompts: string[] = [];
		mocks.sendMessage.mockImplementation((message: {
			action: string;
			request?: { prompts: Array<{ prompt: string }> };
		}) => {
			if (message.action !== 'languageLearningRequest' || !message.request) {
				return Promise.resolve({ success: true });
			}
			const prompt = message.request.prompts[0].prompt;
			requestedPrompts.push(prompt);
			if (requestedPrompts.length === 2) {
				return Promise.reject(new Error('grok CLI timed out'));
			}
			const ids = requestedPrompts.length === 3
				? [0, 2]
				: prompt.includes('0|||') ? [0, 1] : [2];
			return Promise.resolve({
				success: true,
				promptResponses: [{
					key: 'prompt_1',
					prompt,
					user_response: ids.map(index => (
						`${index}|||[["${segments[index]}","${index === 0 && requestedPrompts.length === 3 ? 'にゅー' : 'ひ'}"]]`
					)).join('\n')
				}]
			});
		});

		await expect(configuredLanguageLearning.annotateJapaneseTranscript(segments))
			.rejects.toThrow('grok CLI timed out');
		const retryProgress: TranscriptReadingProgress[] = [];
		const readings = await configuredLanguageLearning.annotateJapaneseTranscript(
			segments,
			next => retryProgress.push(next)
		);

		expect(readings.map(tokens => tokens[0]?.text.length ?? 0)).toEqual([500, 500, 500]);
		expect(requestedPrompts).toHaveLength(3);
		expect(requestedPrompts[0]).toContain('0|||');
		expect(requestedPrompts[1]).toContain('2|||');
		expect(requestedPrompts[2]).toContain('2|||');
		expect(requestedPrompts[2]).not.toContain('0|||');
		expect(readings[0][0].reading).toBe('ひ');
		expect(retryProgress.map(({ readings: _readings, ...item }) => item)).toEqual([
			{ completed: 0, total: 1, completedSegments: 2, totalSegments: 3 },
			{ completed: 1, total: 1, completedSegments: 3, totalSegments: 3 }
		]);
	});

	test('persists completed translation batches and retries only missing segments', async () => {
		const segments = ['A'.repeat(3500), 'B'.repeat(3500)];
		const requestedPrompts: string[] = [];
		mocks.sendMessage.mockImplementation((message: {
			action: string;
			request?: { prompts: Array<{ prompt: string }> };
		}) => {
			if (message.action !== 'languageLearningRequest' || !message.request) {
				return Promise.resolve({ success: true });
			}
			const prompt = message.request.prompts[0].prompt;
			requestedPrompts.push(prompt);
			if (requestedPrompts.length === 2) {
				return Promise.reject(new Error('provider timed out'));
			}
			const index = prompt.includes('0|||') ? 0 : 1;
			return Promise.resolve({
				success: true,
				promptResponses: [{
					key: 'prompt_1',
					prompt,
					user_response: `${index}|||${index === 0 ? '第一段' : '第二段'}`
				}]
			});
		});

		await expect(configuredLanguageLearning.translateTranscript(segments))
			.rejects.toThrow('provider timed out');
		const translations = await configuredLanguageLearning.translateTranscript(segments);

		expect(translations).toEqual(['第一段', '第二段']);
		expect(requestedPrompts).toHaveLength(3);
		expect(requestedPrompts[2]).not.toContain('0|||');
		expect(requestedPrompts[2]).toContain('1|||');
		expect(mocks.storageSessionSet).toHaveBeenCalled();
	});

	test('sends a cancellation message when an active request is aborted', async () => {
		const abortController = new AbortController();
		let resolveRequest: ((response: unknown) => void) | undefined;
		mocks.sendMessage.mockImplementation((message: { action: string }) => {
			if (message.action === 'languageLearningCancel') return Promise.resolve({ success: true });
			return new Promise(resolve => { resolveRequest = resolve; });
		});

		const request = configuredLanguageLearning.explainSelection({
			kind: 'word',
			text: 'encountered',
			context: 'I encountered an unfamiliar word.'
		}, abortController.signal);
		await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			action: 'languageLearningRequest'
		})));
		abortController.abort();

		await expect(request).rejects.toThrow('cancelled');
		expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			action: 'languageLearningCancel',
			requestId: expect.any(String)
		}));
		resolveRequest?.({ success: false });
	});

	test('preserves structured CLI errors for localized Reader recovery', async () => {
		mocks.loadSettings.mockResolvedValue({
			...settings,
			interpreterExecutionMode: 'grok'
		});
		mocks.sendMessage.mockResolvedValue({
			success: false,
			error: 'grok CLI timed out after 120 seconds.',
			errorCode: 'timeout',
			errorDetails: { mode: 'grok', timeoutSeconds: 120 }
		});

		await expect(configuredLanguageLearning.explainSelection({
			kind: 'word',
			text: '日本語',
			context: '日本語を勉強します。'
		})).rejects.toMatchObject({
			name: 'LanguageLearningRequestError',
			code: 'timeout',
			details: { mode: 'grok', timeoutSeconds: 120 }
		});
	});
});
