import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	connectNative: vi.fn(),
	sendNativeMessage: vi.fn()
}));

vi.mock('./browser-polyfill', () => ({
	default: {
		runtime: {
			connectNative: mocks.connectNative,
			sendNativeMessage: mocks.sendNativeMessage
		}
	}
}));

import { RequestCancelledError } from './request-cancellation';
import { checkNativeCliHealth, sendNativeCliRequest } from './native-cli-service';
import { buildNativeCliRequest, NATIVE_CLI_PROTOCOL_VERSION } from './native-cli-contract';

function createPort() {
	const messageListeners: Array<(message: unknown) => void> = [];
	const disconnectListeners: Array<() => void> = [];
	return {
		posted: [] as unknown[],
		postMessage(message: unknown) {
			this.posted.push(message);
		},
		disconnect: vi.fn(),
		onMessage: {
			addListener(listener: (message: unknown) => void) {
				messageListeners.push(listener);
			},
			removeListener(listener: (message: unknown) => void) {
				const index = messageListeners.indexOf(listener);
				if (index >= 0) messageListeners.splice(index, 1);
			}
		},
		onDisconnect: {
			addListener(listener: () => void) {
				disconnectListeners.push(listener);
			},
			removeListener(listener: () => void) {
				const index = disconnectListeners.indexOf(listener);
				if (index >= 0) disconnectListeners.splice(index, 1);
			}
		},
		emitMessage(message: unknown) {
			messageListeners.forEach(listener => listener(message));
		},
		emitDisconnect() {
			disconnectListeners.forEach(listener => listener());
		}
	};
}

describe('Native CLI service', () => {
	beforeEach(() => {
		mocks.connectNative.mockReset();
		mocks.sendNativeMessage.mockReset();
	});

	test('sends cancellation over the same Native Messaging port', async () => {
		const port = createPort();
		mocks.connectNative.mockReturnValue(port);
		const controller = new AbortController();
		const request = buildNativeCliRequest('grok', 'Context', [], 'request-1');

		const response = sendNativeCliRequest(request, controller.signal);
		controller.abort();

		await expect(response).rejects.toBeInstanceOf(RequestCancelledError);
		expect(port.posted).toEqual([
			request,
			{
				type: 'cancelCli',
				protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
				requestId: 'request-1'
			}
		]);
	});

	test('preserves structured timeout errors from the host', async () => {
		const port = createPort();
		mocks.connectNative.mockReturnValue(port);
		const response = sendNativeCliRequest(
			buildNativeCliRequest('grok', 'Context', [], 'request-2')
		);
		port.emitMessage({
			requestId: 'request-2',
			ok: false,
			errorCode: 'timeout',
			error: 'grok CLI timed out after 120 seconds.',
			details: { mode: 'grok', timeoutSeconds: 120 }
		});

		await expect(response).rejects.toMatchObject({
			name: 'NativeCliExecutionError',
			code: 'timeout',
			details: { mode: 'grok', timeoutSeconds: 120 }
		});
	});

	test('checks the installed host and selected CLI without running a prompt', async () => {
		const port = createPort();
		mocks.connectNative.mockReturnValue(port);
		const response = checkNativeCliHealth('codex');
		const request = port.posted[0] as { requestId: string };
		port.emitMessage({
			requestId: request.requestId,
			ok: true,
			health: {
				protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
				mode: 'codex',
				command: '/usr/local/bin/codex'
			}
		});

		await expect(response).resolves.toEqual({
			protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
			mode: 'codex',
			command: '/usr/local/bin/codex'
		});
	});

	test('reports an old host response without request IDs as a protocol mismatch', async () => {
		const port = createPort();
		mocks.connectNative.mockReturnValue(port);
		const response = checkNativeCliHealth('grok');
		port.emitMessage({
			ok: false,
			error: 'Unsupported native host request.'
		});

		const outcome = await Promise.race([
			response.then(() => 'resolved', error => (error as { code?: string }).code),
			new Promise<string>(resolve => setTimeout(() => resolve('still-pending'), 0))
		]);
		expect(outcome).toBe('protocol-mismatch');
	});

	test('times out a health check when an old host never replies', async () => {
		vi.useFakeTimers();
		try {
			const port = createPort();
			mocks.connectNative.mockReturnValue(port);
			const response = checkNativeCliHealth('codex');
			const rejection = expect(response).rejects.toMatchObject({ code: 'protocol-mismatch' });

			await vi.advanceTimersByTimeAsync(5000);
			await rejection;
			expect(port.disconnect).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});
