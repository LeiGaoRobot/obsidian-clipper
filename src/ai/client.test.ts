import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../utils/browser-polyfill', () => ({ default: { runtime: { connect: vi.fn() } } }));

import { clearConnectionStatus, runAiTask, testConnection, type AiClientPort } from './client';
import { isAiError } from './errors';

class FakeClientPort implements AiClientPort {
	posted: any[] = [];
	disconnected = false;
	private messageListeners = new Set<(message: unknown) => void>();
	private disconnectListeners = new Set<() => void>();
	postMessage(message: unknown) {
		if (this.disconnected) throw new Error('Attempting to use a disconnected port object');
		this.posted.push(message);
	}
	disconnect() {
		this.disconnected = true;
	}
	onMessage = {
		addListener: (listener: (message: unknown) => void) => { this.messageListeners.add(listener); },
		removeListener: (listener: (message: unknown) => void) => { this.messageListeners.delete(listener); }
	};
	onDisconnect = {
		addListener: (listener: () => void) => { this.disconnectListeners.add(listener); },
		removeListener: (listener: () => void) => { this.disconnectListeners.delete(listener); }
	};
	receive(message: unknown) {
		this.messageListeners.forEach(listener => listener(message));
	}
	remoteDisconnect() {
		this.disconnectListeners.forEach(listener => listener());
	}
	get jobId(): string {
		return this.posted[0].jobId;
	}
	get listenerCount() {
		return this.messageListeners.size + this.disconnectListeners.size;
	}
}

const input = { context: 'Page text', prompts: [{ key: 'prompt_1', prompt: 'Summarize' }] };

function start(options: Parameters<typeof runAiTask>[2] = {}) {
	const port = new FakeClientPort();
	const connect = vi.fn(() => port);
	const promise = runAiTask('interpret', input, { connect, ...options });
	return { port, connect, promise };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('runAiTask', () => {
	test('starts a job on the ai port and resolves with its result', async () => {
		const onProgress = vi.fn();
		const { port, connect, promise } = start({ profileId: 'model-b', onProgress });
		expect(connect).toHaveBeenCalledWith('ai');
		expect(port.posted[0]).toMatchObject({ type: 'start', task: 'interpret', profileId: 'model-b', input });

		port.receive({ type: 'progress', jobId: port.jobId, phase: 'receiving', elapsedMs: 1200, receivedChars: 40 });
		port.receive({ type: 'result', jobId: 'other-job', output: {}, connectionKind: 'anthropic' });
		port.receive({ type: 'result', jobId: port.jobId, output: { prompt_1: 'Done' }, connectionKind: 'anthropic' });

		await expect(promise).resolves.toEqual({ output: { prompt_1: 'Done' }, connectionKind: 'anthropic' });
		expect(onProgress).toHaveBeenCalledWith({ phase: 'receiving', elapsedMs: 1200, receivedChars: 40 });
		expect(port.disconnected).toBe(true);
		expect(port.listenerCount).toBe(0);
	});

	test('rejects with the gateway error as an AiError', async () => {
		const { port, promise } = start();
		port.receive({ type: 'error', jobId: port.jobId, error: { code: 'auth', retryable: false, status: 401 } });
		const error = await promise.catch(value => value);
		expect(isAiError(error)).toBe(true);
		expect(error).toMatchObject({ code: 'auth', retryable: false, status: 401 });
	});

	test('sends cancel and rejects as cancelled when aborted', async () => {
		const controller = new AbortController();
		const { port, promise } = start({ signal: controller.signal });
		controller.abort();
		await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
		expect(port.posted[1]).toEqual({ type: 'cancel', jobId: port.jobId });
		expect(port.disconnected).toBe(true);
	});

	test('rejects immediately when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const connect = vi.fn();
		await expect(runAiTask('interpret', input, { signal: controller.signal, connect })).rejects.toMatchObject({ code: 'cancelled' });
		expect(connect).not.toHaveBeenCalled();
	});

	test('a disconnect before the result is a retryable network error', async () => {
		const { port, promise } = start();
		port.remoteDisconnect();
		await expect(promise).rejects.toMatchObject({ code: 'network', retryable: true });
	});

	test('pings while the job is pending and stops after it settles', async () => {
		vi.useFakeTimers();
		const { port, promise } = start({ keepaliveMs: 1000 });
		vi.advanceTimersByTime(2500);
		expect(port.posted.filter(message => message.type === 'ping')).toHaveLength(2);

		port.receive({ type: 'result', jobId: port.jobId, output: {}, connectionKind: 'ollama' });
		await promise;
		vi.advanceTimersByTime(5000);
		expect(port.posted.filter(message => message.type === 'ping')).toHaveLength(2);
	});

	test('a failed connect is a network error', async () => {
		const connect = vi.fn(() => {
			throw new Error('Extension context invalidated.');
		});
		await expect(runAiTask('interpret', input, { connect })).rejects.toMatchObject({
			code: 'network',
			detail: 'Extension context invalidated.'
		});
	});

	test('uses unique job IDs', () => {
		const first = start();
		const second = start();
		expect(first.port.jobId).not.toBe(second.port.jobId);
		first.port.remoteDisconnect();
		second.port.remoteDisconnect();
		return Promise.allSettled([first.promise, second.promise]);
	});
});

describe('testConnection', () => {
	test('sends only the connection id, forwards steps, and resolves the result', async () => {
		const port = new FakeClientPort();
		const onStep = vi.fn();
		const promise = testConnection('openai', { connect: () => port, onStep });
		expect(port.posted[0]).toEqual({ type: 'test', jobId: port.jobId, connectionId: 'openai' });

		port.receive({ type: 'test-step', jobId: port.jobId, step: 'listing' });
		port.receive({ type: 'test-step', jobId: 'other', step: 'probe' });
		port.receive({ type: 'test-step', jobId: port.jobId, step: 'exec', profileId: 'codex-high' });
		const result = { connectionId: 'openai', state: 'ok', testedAt: 1, billable: false };
		port.receive({ type: 'test-result', jobId: port.jobId, result });

		await expect(promise).resolves.toEqual(result);
		expect(onStep.mock.calls).toEqual([['listing', undefined], ['exec', 'codex-high']]);
		expect(port.disconnected).toBe(true);
	});

	test('rejects with the gateway error and cancels on abort', async () => {
		const failing = new FakeClientPort();
		const failed = testConnection('gone', { connect: () => failing });
		failing.receive({ type: 'error', jobId: failing.jobId, error: { code: 'not-configured', retryable: false, reason: 'connection-missing' } });
		await expect(failed).rejects.toMatchObject({ code: 'not-configured', reason: 'connection-missing' });

		const port = new FakeClientPort();
		const controller = new AbortController();
		const pending = testConnection('openai', { connect: () => port, signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
		expect(port.posted[1]).toEqual({ type: 'cancel', jobId: port.jobId });
	});
});

describe('clearConnectionStatus', () => {
	test('sends only the connection id and resolves on status-cleared', async () => {
		const port = new FakeClientPort();
		const promise = clearConnectionStatus('openai', { connect: () => port });
		expect(port.posted[0]).toEqual({ type: 'status-clear', jobId: port.jobId, connectionId: 'openai' });
		port.receive({ type: 'status-cleared', jobId: 'other', connectionId: 'openai' });
		port.receive({ type: 'status-cleared', jobId: port.jobId, connectionId: 'openai' });
		await expect(promise).resolves.toBeUndefined();
		expect(port.disconnected).toBe(true);
	});

	test('rejects with the gateway error', async () => {
		const port = new FakeClientPort();
		const promise = clearConnectionStatus('openai', { connect: () => port });
		port.receive({ type: 'error', jobId: port.jobId, error: { code: 'provider-error', retryable: false, detail: 'QUOTA_BYTES quota exceeded' } });
		await expect(promise).rejects.toMatchObject({ code: 'provider-error', detail: 'QUOTA_BYTES quota exceeded' });
	});
});
