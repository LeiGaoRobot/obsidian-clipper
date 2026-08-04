import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sendMessage: vi.fn() }));

vi.mock('./browser-polyfill', () => ({
	default: { runtime: { sendMessage: mocks.sendMessage } }
}));
vi.mock('./i18n', () => ({ getMessage: (key: string) => key }));

import { executeNativeCli } from './native-cli-client';

describe('Native CLI client', () => {
	beforeEach(() => {
		mocks.sendMessage.mockReset();
		mocks.sendMessage.mockResolvedValue({
			success: true,
			stdout: '{"prompt_1":"done"}'
		});
	});

	test('sends request-scoped Codex model and effort to the background', async () => {
		await executeNativeCli(
			'codex',
			'Context',
			[{ key: 'prompt_1', prompt: 'Summarize', filters: '' }],
			{ model: 'gpt-5.6-sol', effort: 'max' }
		);

		expect(mocks.sendMessage).toHaveBeenCalledWith({
			action: 'nativeCliRequest',
			request: expect.objectContaining({
				mode: 'codex',
				model: 'gpt-5.6-sol',
				effort: 'max'
			})
		});
	});
});
