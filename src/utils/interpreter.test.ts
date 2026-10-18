// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	executeNativeCli: vi.fn(),
	generalSettings: {
		interpreterExecutionMode: 'codex',
		interpreterCodexModel: 'gpt-5.6-luna',
		interpreterCodexReasoningEffort: 'high',
		providers: []
	}
}));

vi.mock('./storage-utils', () => ({
	generalSettings: mocks.generalSettings,
	saveSettings: vi.fn()
}));
vi.mock('./native-cli-client', () => ({ executeNativeCli: mocks.executeNativeCli }));
vi.mock('./i18n', () => ({ getMessage: (key: string) => key }));
vi.mock('./debug', () => ({ debugLog: vi.fn() }));

import { handleInterpreterUI } from './interpreter';

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
		mocks.executeNativeCli.mockReset().mockResolvedValue({ prompt_1: 'Done' });
	});

	test('forwards stored Codex model and effort to requests', async () => {
		await handleInterpreterUI({
			id: 'template-1',
			name: 'Template',
			behavior: 'create',
			noteNameFormat: '',
			path: '',
			noteContentFormat: '{{"Summarize"}}',
			properties: []
		}, {}, 1, 'https://example.com');

		expect(mocks.executeNativeCli).toHaveBeenCalledWith(
			'codex',
			'Page context',
			[{ key: 'prompt_1', prompt: 'Summarize', filters: '' }],
			{ model: 'gpt-5.6-luna', effort: 'high' }
		);
	});
});
