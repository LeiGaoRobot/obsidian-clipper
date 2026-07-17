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

		const progress: Array<{ completed: number; total: number }> = [];
		const output = await configuredLanguageLearning.annotateJapaneseTranscript(
			['日本語'],
			next => progress.push(next)
		);

		expect(output).toEqual([[{ text: '日本語', reading: 'にほんご' }]]);
		expect(progress).toEqual([
			{ completed: 0, total: 1 },
			{ completed: 1, total: 1 }
		]);
		expect(mocks.sendMessage).toHaveBeenCalledWith({
			action: 'languageLearningRequest',
			requestId: expect.any(String),
			request: expect.objectContaining({
				context: 'Annotate Japanese transcript segments with aligned ruby readings.'
			})
		});
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
