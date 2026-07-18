import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Settings } from '../types/types';

const mocks = vi.hoisted(() => ({
	loadSettings: vi.fn(),
	sendMessage: vi.fn()
}));

vi.mock('./browser-polyfill', () => ({
	default: { runtime: { sendMessage: mocks.sendMessage } }
}));
vi.mock('./storage-utils', () => ({ loadSettings: mocks.loadSettings }));
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
		mocks.loadSettings.mockResolvedValue(settings);
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
		expect(progress).toEqual([
			{ completed: 0, total: 1, completedSegments: 0, totalSegments: 1 },
			{ completed: 1, total: 1, completedSegments: 1, totalSegments: 1 }
		]);
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
		expect(progress).toEqual([
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
		expect(retryProgress).toEqual([
			{ completed: 0, total: 1, completedSegments: 2, totalSegments: 3 },
			{ completed: 1, total: 1, completedSegments: 3, totalSegments: 3 }
		]);
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
});
