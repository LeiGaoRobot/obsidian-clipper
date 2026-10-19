// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AiError } from '../ai/errors';
import type { ModelConfig, Template } from '../types/types';

const mocks = vi.hoisted(() => ({
	runAiTask: vi.fn(),
	generalSettings: {
		interpreterExecutionMode: 'codex',
		providers: []
	} as Record<string, unknown>
}));

vi.mock('./storage-utils', () => ({
	generalSettings: mocks.generalSettings,
	saveSettings: vi.fn()
}));
vi.mock('../ai/client', () => ({ runAiTask: mocks.runAiTask }));
vi.mock('./i18n', () => ({ getMessage: (key: string) => key }));
vi.mock('./debug', () => ({ debugLog: vi.fn() }));

import { handleInterpreterUI } from './interpreter';

const template: Template = {
	id: 'template-1',
	name: 'Template',
	behavior: 'create',
	noteNameFormat: '',
	path: '',
	noteContentFormat: '{{"Summarize"}}',
	properties: []
};

const modelConfig: ModelConfig = {
	id: 'model-b',
	providerId: 'provider-1',
	providerModelId: 'gpt-b',
	name: 'B',
	enabled: true
};

describe('Interpreter', () => {
	beforeEach(() => {
		document.body.innerHTML = `
			<div id="interpreter"></div>
			<button id="interpret-btn"></button>
			<div id="interpreter-error"></div>
			<span id="interpreter-timer"></span>
			<button id="clip-btn"></button>
			<button id="more-btn"></button>
			<textarea id="prompt-context">Page context</textarea>
		`;
		mocks.generalSettings.interpreterExecutionMode = 'codex';
		mocks.runAiTask.mockReset().mockResolvedValue({ responses: { prompt_1: 'Done' }, connectionKind: 'cli-codex' });
	});

	test('runs CLI modes through the gateway without an explicit profile', async () => {
		await handleInterpreterUI(template, {}, 1, 'https://example.com');

		expect(mocks.runAiTask).toHaveBeenCalledWith(
			'interpret',
			{ context: 'Page context', prompts: [{ key: 'prompt_1', prompt: 'Summarize', filters: '' }] },
			{}
		);
		expect(document.getElementById('interpreter')?.classList.contains('done')).toBe(true);
	});

	test('passes the selected model as the profile in API mode', async () => {
		mocks.generalSettings.interpreterExecutionMode = 'api';
		await handleInterpreterUI(template, {}, 1, 'https://example.com', modelConfig);

		expect(mocks.runAiTask).toHaveBeenCalledWith('interpret', expect.anything(), { profileId: 'model-b' });
	});

	test('shows a localized AI error with its technical detail', async () => {
		mocks.runAiTask.mockRejectedValue(new AiError('auth', { status: 401, detail: 'invalid x-api-key' }));

		await expect(handleInterpreterUI(template, {}, 1, 'https://example.com')).rejects.toThrow('aiErrorAuthBody');

		const error = document.getElementById('interpreter-error') as HTMLDivElement;
		expect(error.style.display).toBe('block');
		expect(error.querySelector('strong')?.textContent).toBe('aiErrorAuthTitle');
		expect(error.textContent).toContain('aiErrorAuthBody');
		expect(error.querySelector('details')?.textContent).toContain('invalid x-api-key');
		expect(document.getElementById('interpreter')?.classList.contains('error')).toBe(true);
	});
});
