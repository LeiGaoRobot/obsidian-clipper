import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sendMessage: vi.fn() }));

vi.mock('./browser-polyfill', () => ({
	default: { runtime: { sendMessage: mocks.sendMessage } }
}));
vi.mock('./i18n', () => ({ getMessage: (key: string) => key }));

import { requestNativeCliHealth } from './native-cli-health';

describe('Native CLI health client', () => {
	beforeEach(() => mocks.sendMessage.mockReset());

	test('returns host, command, and last-run diagnostics', async () => {
		mocks.sendMessage.mockResolvedValue({
			success: true,
			health: { protocolVersion: 2, mode: 'grok', command: '/opt/homebrew/bin/grok' },
			lastRun: { mode: 'grok', status: 'success', finishedAt: 123 }
		});

		await expect(requestNativeCliHealth('grok')).resolves.toEqual({
			health: { protocolVersion: 2, mode: 'grok', command: '/opt/homebrew/bin/grok' },
			lastRun: { mode: 'grok', status: 'success', finishedAt: 123 }
		});
		expect(mocks.sendMessage).toHaveBeenCalledWith({ action: 'nativeCliHealth', mode: 'grok' });
	});

	test('preserves a structured setup failure', async () => {
		mocks.sendMessage.mockResolvedValue({
			success: false,
			errorCode: 'config',
			error: 'Grok command is not configured.',
			errorDetails: { mode: 'grok' }
		});

		await expect(requestNativeCliHealth('grok')).rejects.toMatchObject({
			name: 'NativeCliHealthError',
			code: 'config',
			details: { mode: 'grok' }
		});
	});

	test('uses a localized generic fallback when the background omits an error message', async () => {
		mocks.sendMessage.mockResolvedValue({ success: false });

		await expect(requestNativeCliHealth('codex')).rejects.toMatchObject({
			message: 'error'
		});
	});
});
