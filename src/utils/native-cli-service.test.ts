import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	connectNative: vi.fn(),
	sendNativeMessage: vi.fn(),
	lastError: undefined as { message: string } | undefined,
	lastErrorReads: 0
}));

vi.mock('./browser-polyfill', () => ({
	default: {
		runtime: {
			connectNative: mocks.connectNative,
			sendNativeMessage: mocks.sendNativeMessage,
			get lastError() {
				mocks.lastErrorReads += 1;
				return mocks.lastError;
			}
		}
	}
}));

import {
	checkNativeCliHealth,
	sendNativeCliRequest
} from './native-cli-service';
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
		mocks.lastError = undefined;
		mocks.lastErrorReads = 0;
	});

	test('sends cancellation over the same Native Messaging port', async () => {
		const port = createPort();
		mocks.connectNative.mockReturnValue(port);
		const controller = new AbortController();
		const request = buildNativeCliRequest('grok', 'Context', [], { requestId: 'request-1' });

		const response = sendNativeCliRequest(request, controller.signal);
		controller.abort();

		await expect(response).rejects.toMatchObject({ name: 'AiError', code: 'cancelled' });
		expect(port.posted).toEqual([
			request,
			{
				type: 'cancelCli',
				protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
				requestId: 'request-1'
			}
		]);
	});

	test('requests and forwards heartbeats on a connected port without settling', async () => {
		const port = createPort();
		mocks.connectNative.mockReturnValue(port);
		const heartbeats: unknown[] = [];
		const request = buildNativeCliRequest('codex', 'Context', [], { requestId: 'request-hb' });

		const response = sendNativeCliRequest(request, undefined, heartbeat => heartbeats.push(heartbeat));
		expect(port.posted[0]).toEqual({ ...request, heartbeat: true });
		port.emitMessage({ type: 'heartbeat', requestId: 'other', elapsedMs: 1 });
		port.emitMessage({ type: 'heartbeat', requestId: 'request-hb', elapsedMs: 10000 });
		port.emitMessage({ requestId: 'request-hb', ok: true, stdout: 'done' });

		await expect(response).resolves.toMatchObject({ stdout: 'done' });
		expect(heartbeats).toEqual([{ type: 'heartbeat', requestId: 'request-hb', elapsedMs: 10000 }]);
	});

	test('never asks for heartbeats over one-shot Native Messaging', async () => {
		mocks.connectNative.mockImplementation(undefined as never);
		const runtime = (await import('./browser-polyfill')).default.runtime as { connectNative?: unknown };
		const connectNative = runtime.connectNative;
		runtime.connectNative = undefined;
		mocks.sendNativeMessage.mockResolvedValue({ ok: true, requestId: 'request-once', stdout: 'done' });
		try {
			const request = buildNativeCliRequest('codex', 'Context', [], { requestId: 'request-once' });
			await sendNativeCliRequest({ ...request, heartbeat: true }, undefined, () => {});
			expect(mocks.sendNativeMessage.mock.calls[0][1]).toEqual(request);
		} finally {
			runtime.connectNative = connectNative;
		}
	});

	test('forwards canonical Codex model and effort on the Native Messaging request', async () => {
		const port = createPort();
		mocks.connectNative.mockReturnValue(port);
		const response = sendNativeCliRequest(buildNativeCliRequest(
			'codex',
			'Context',
			[{ key: 'prompt_1', prompt: 'Summarize' }],
			{ model: '  gpt-5.6-sol  ', effort: 'ultra' }
		));
		const request = port.posted[0] as {
			requestId: string;
			mode: string;
			model?: string;
			effort?: string;
		};

		expect(request).toMatchObject({ mode: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' });
		port.emitMessage({
			requestId: request.requestId,
			ok: true,
			stdout: '{"prompt_1":"Done"}'
		});
		await expect(response).resolves.toMatchObject({ ok: true, stdout: '{"prompt_1":"Done"}' });
	});

	test('does not put Codex model or effort properties on Grok Native Messaging requests', async () => {
		const port = createPort();
		mocks.connectNative.mockReturnValue(port);
		const response = sendNativeCliRequest(buildNativeCliRequest(
			'grok',
			'Context',
			[{ key: 'prompt_1', prompt: 'Summarize' }]
		));
		const grokRequest = port.posted[0] as { requestId: string };

		expect((Object as ObjectConstructor & {
			hasOwn(object: object, property: PropertyKey): boolean;
		}).hasOwn(grokRequest, 'model')).toBe(false);
		expect((Object as ObjectConstructor & {
			hasOwn(object: object, property: PropertyKey): boolean;
		}).hasOwn(grokRequest, 'effort')).toBe(false);
		port.emitMessage({
			requestId: grokRequest.requestId,
			ok: true,
			stdout: '{"prompt_1":"Done"}'
		});
		await expect(response).resolves.toMatchObject({ ok: true, stdout: '{"prompt_1":"Done"}' });
	});

	test('forwards cancellation from prompt execution over the same Native Messaging port', async () => {
		const port = createPort();
		mocks.connectNative.mockReturnValue(port);
		const controller = new AbortController();
		const response = sendNativeCliRequest(buildNativeCliRequest(
			'codex',
			'Context',
			[{ key: 'prompt_1', prompt: 'Summarize' }]
		), controller.signal);
		const request = port.posted[0] as { requestId: string };

		controller.abort();

		await expect(response).rejects.toMatchObject({ name: 'AiError', code: 'cancelled' });
		expect(port.posted).toEqual([
			request,
			{
				type: 'cancelCli',
				protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
				requestId: request.requestId
			}
		]);
	});

	test('preserves structured timeout errors from the host', async () => {
		const port = createPort();
		mocks.connectNative.mockReturnValue(port);
		const response = sendNativeCliRequest(
			buildNativeCliRequest('grok', 'Context', [], { requestId: 'request-2' })
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
			health: {
				protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
				mode: 'codex',
				command: '/usr/local/bin/codex'
			},
			transport: 'port'
		});
	});

	async function withoutConnectNative(run: () => Promise<void>): Promise<void> {
		const runtime = (await import('./browser-polyfill')).default.runtime as { connectNative?: unknown };
		const connectNative = runtime.connectNative;
		runtime.connectNative = undefined;
		try {
			await run();
		} finally {
			runtime.connectNative = connectNative;
		}
	}

	test('checks health over one-shot sendNativeMessage when connectNative is absent', async () => {
		await withoutConnectNative(async () => {
			mocks.sendNativeMessage.mockImplementation(async (_host: string, request: { requestId: string }) => ({
				requestId: request.requestId,
				ok: true,
				health: { protocolVersion: NATIVE_CLI_PROTOCOL_VERSION, mode: 'grok', command: '/usr/local/bin/grok' }
			}));

			await expect(checkNativeCliHealth('grok')).resolves.toEqual({
				health: { protocolVersion: NATIVE_CLI_PROTOCOL_VERSION, mode: 'grok', command: '/usr/local/bin/grok' },
				transport: 'message'
			});
			expect(mocks.connectNative).not.toHaveBeenCalled();
			expect(mocks.sendNativeMessage).toHaveBeenCalledOnce();
			expect(mocks.sendNativeMessage.mock.calls[0][1]).toMatchObject({ type: 'healthCheck', mode: 'grok' });
		});
	});

	test('a one-shot health check reports a setup failure and an old Host', async () => {
		await withoutConnectNative(async () => {
			mocks.sendNativeMessage.mockResolvedValueOnce({ requestId: 'x', ok: false, errorCode: 'config', error: 'Grok is not configured.' });
			await expect(checkNativeCliHealth('grok')).rejects.toMatchObject({ name: 'NativeCliExecutionError', code: 'config' });

			mocks.sendNativeMessage.mockResolvedValueOnce({ ok: false, error: 'Unsupported native host request.' });
			await expect(checkNativeCliHealth('grok')).rejects.toMatchObject({ code: 'protocol-mismatch' });

			mocks.sendNativeMessage.mockRejectedValueOnce(new Error('Specified native messaging host not found.'));
			await expect(checkNativeCliHealth('codex')).rejects.toMatchObject({ name: 'NativeCliUnavailableError' });
		});
	});

	test('consumes Chrome runtime.lastError when closing a completed native port', async () => {
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
		await response;

		mocks.lastError = { message: 'Native host has exited.' };
		port.emitDisconnect();

		expect(mocks.lastErrorReads).toBe(1);
	});

	test('reports Chrome runtime.lastError when the native host exits before responding', async () => {
		const port = createPort();
		mocks.connectNative.mockReturnValue(port);
		mocks.lastError = { message: 'Native host has exited.' };
		const response = checkNativeCliHealth('codex');

		port.emitDisconnect();

		await expect(response).rejects.toMatchObject({ message: 'Native host has exited.' });
		expect(mocks.lastErrorReads).toBe(1);
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
