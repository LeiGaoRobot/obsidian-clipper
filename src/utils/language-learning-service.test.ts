import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	loadSettings: vi.fn(),
	executeNativeCliForPrompts: vi.fn(),
	sendToLLM: vi.fn()
}));

vi.mock('./storage-utils', () => ({ loadSettings: mocks.loadSettings }));
vi.mock('./native-cli-service', () => ({
	executeNativeCliForPrompts: mocks.executeNativeCliForPrompts
}));
vi.mock('./llm-client', () => ({ sendToLLM: mocks.sendToLLM }));

import { runLanguageLearningRequest } from './language-learning-service';

describe('Language learning service', () => {
	beforeEach(() => {
		mocks.loadSettings.mockReset();
		mocks.executeNativeCliForPrompts.mockReset().mockResolvedValue({ prompt_1: 'Done' });
		mocks.sendToLLM.mockReset();
	});

	test('forwards stored Codex model and effort to requests', async () => {
		mocks.loadSettings.mockResolvedValue({
			interpreterEnabled: true,
			interpreterExecutionMode: 'codex',
			interpreterCodexModel: 'gpt-5.6-terra',
			interpreterCodexReasoningEffort: 'max'
		});
		const controller = new AbortController();

		await runLanguageLearningRequest({
			context: 'Context',
			prompts: [{ key: 'prompt_1', prompt: 'Translate' }]
		}, controller.signal);

		expect(mocks.executeNativeCliForPrompts).toHaveBeenCalledWith(
			'codex',
			'Context',
			[{ key: 'prompt_1', prompt: 'Translate' }],
			{ model: 'gpt-5.6-terra', effort: 'max', signal: controller.signal }
		);
	});

	test('does not forward stored Codex model or effort to Grok requests', async () => {
		mocks.loadSettings.mockResolvedValue({
			interpreterEnabled: true,
			interpreterExecutionMode: 'grok',
			interpreterCodexModel: 'gpt-5.6-terra',
			interpreterCodexReasoningEffort: 'max'
		});
		const controller = new AbortController();

		await runLanguageLearningRequest({
			context: 'Context',
			prompts: [{ key: 'prompt_1', prompt: 'Translate' }]
		}, controller.signal);

		expect(mocks.executeNativeCliForPrompts).toHaveBeenCalledWith(
			'grok',
			'Context',
			[{ key: 'prompt_1', prompt: 'Translate' }],
			{ signal: controller.signal }
		);
	});
});
