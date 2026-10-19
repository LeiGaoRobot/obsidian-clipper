import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../utils/browser-polyfill', () => ({ default: { runtime: { connect: vi.fn() } } }));

import type { AiClientPort } from './client';
import { isAiError } from './errors';
import { transcriptJobId } from './job-identity';
import { isAiClientMessage } from './protocol';
import {
	clearTranscriptCheckpoint,
	loadTranscriptCheckpoint,
	runTranscriptJob,
	saveTranscriptCheckpoint,
	transcriptJobAttempts,
	type RunTranscriptJobOptions
} from './job-client';

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
		this.disconnected = true;
		this.disconnectListeners.forEach(listener => listener());
	}
	get listenerCount() {
		return this.messageListeners.size + this.disconnectListeners.size;
	}
}

const identity = { namespace: 'transcript-translation', scope: 'video-1:zh-CN' };
const segments = ['one', 'two', 'three', 'four'].map((text, id) => ({ id, text }));
const input = { instruction: 'Translate into Chinese.', segments, identity };
const jobId = transcriptJobId('translate', identity, segments);
const attempts = { requests: 2, retries: 0, splits: 0 };
const counts = (completedGroups: number, completedSegments: number) => ({
	completedGroups,
	totalGroups: 2,
	completedSegments,
	totalSegments: 4
});

function jobState(status: string, results: unknown[], extra: Record<string, unknown> = {}) {
	return { type: 'job-state', jobId, status, ...counts(status === 'running' ? 0 : 2, results.length), results, attempts, ...extra };
}

/** A connect that hands out a new fake port per call; `failNext` makes the next calls throw. */
function createConnector() {
	const ports: FakeClientPort[] = [];
	let failures = 0;
	const connect = vi.fn((name: string) => {
		expect(name).toBe('ai');
		if (failures > 0) {
			failures -= 1;
			throw new Error('Could not establish connection. Receiving end does not exist.');
		}
		const port = new FakeClientPort();
		ports.push(port);
		return port;
	});
	return {
		ports,
		connect,
		get last() {
			return ports[ports.length - 1];
		},
		failNext(count: number) {
			failures = count;
		}
	};
}

function start(options: RunTranscriptJobOptions<'translate'> = {}) {
	const connector = createConnector();
	const promise = runTranscriptJob('translate', input, { connect: connector.connect, ...options });
	return { connector, promise };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('runTranscriptJob', () => {
	test('starts a job, accumulates progress deltas, and resolves aligned values', async () => {
		const onProgress = vi.fn();
		const { connector, promise } = start({ profileId: 'model-b', onProgress });
		const port = connector.last;
		expect(port.posted[0]).toEqual({ type: 'start-job', jobId, task: 'translate', profileId: 'model-b', input });

		port.receive(jobState('running', []));
		port.receive({ type: 'job-progress', jobId: 'job:translate:other:1', ...counts(1, 2), results: [{ id: 0, text: 'x' }] });
		port.receive({ type: 'job-progress', jobId, ...counts(1, 2), results: [{ id: 1, text: '二' }, { id: 0, text: '一' }] });
		port.receive({ type: 'job-progress', jobId, ...counts(2, 4), results: [{ id: 3, text: '四' }, { id: 2, text: '三' }] });
		port.receive(jobState('completed', [{ id: 0, text: '一' }, { id: 1, text: '二' }, { id: 2, text: '三' }, { id: 3, text: '四' }]));

		await expect(promise).resolves.toEqual({
			status: 'completed',
			values: ['一', '二', '三', '四'],
			results: [{ id: 0, text: '一' }, { id: 1, text: '二' }, { id: 2, text: '三' }, { id: 3, text: '四' }],
			attempts,
			...counts(2, 4)
		});
		expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
			{ ...counts(0, 0), values: ['', '', '', ''] },
			{ ...counts(1, 2), values: ['一', '二', '', ''] },
			{ ...counts(2, 4), values: ['一', '二', '三', '四'] }
		]);
		expect(port.disconnected).toBe(true);
		expect(port.listenerCount).toBe(0);
	});

	test('progress values are copies the caller cannot use to corrupt local state', async () => {
		const onProgress = vi.fn(progress => { progress.values[0] = 'mutated'; });
		const { connector, promise } = start({ onProgress });
		connector.last.receive({ type: 'job-progress', jobId, ...counts(1, 1), results: [{ id: 0, text: '一' }] });
		connector.last.receive(jobState('incomplete', [{ id: 1, text: '二' }]));
		const result = await promise;
		expect(result.values).toEqual(['', '二', '', '']);
	});

	test('reconnects after a disconnect, attaches, and lets the snapshot replace local state', async () => {
		vi.useFakeTimers();
		const onProgress = vi.fn();
		const { connector, promise } = start({ onProgress });
		const first = connector.last;
		first.receive({ type: 'job-progress', jobId, ...counts(1, 2), results: [{ id: 0, text: '一' }, { id: 1, text: 'stale' }] });
		first.remoteDisconnect();
		expect(first.listenerCount).toBe(0);
		expect(connector.connect).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(249);
		expect(connector.connect).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		const second = connector.last;
		expect(second).not.toBe(first);
		expect(second.posted).toEqual([{ type: 'attach', jobId }]);

		// Groups finished while disconnected arrive in the snapshot; it replaces the local values.
		second.receive({ ...jobState('running', [{ id: 0, text: '一' }, { id: 1, text: '二' }, { id: 2, text: '三' }]), ...counts(1, 3) });
		expect(onProgress).toHaveBeenLastCalledWith({ ...counts(1, 3), values: ['一', '二', '三', ''] });
		second.receive({ type: 'job-progress', jobId, ...counts(2, 4), results: [{ id: 3, text: '四' }] });
		second.receive(jobState('completed', [{ id: 0, text: '一' }, { id: 1, text: '二' }, { id: 2, text: '三' }, { id: 3, text: '四' }]));

		await expect(promise).resolves.toMatchObject({ status: 'completed', values: ['一', '二', '三', '四'] });
		// No new start-job is ever sent on reconnect.
		expect(connector.ports.flatMap(port => port.posted).filter(message => message.type === 'start-job')).toHaveLength(1);
		expect(second.disconnected).toBe(true);
	});

	test('a reply after a reconnect resets the reconnect budget', async () => {
		vi.useFakeTimers();
		const { connector, promise } = start({ reconnectDelaysMs: [10, 20] });
		connector.last.remoteDisconnect();
		await vi.advanceTimersByTimeAsync(10);
		connector.last.remoteDisconnect();
		await vi.advanceTimersByTimeAsync(20);
		connector.last.receive(jobState('running', []));
		connector.last.remoteDisconnect();
		await vi.advanceTimersByTimeAsync(10);
		expect(connector.ports).toHaveLength(4);
		connector.last.receive(jobState('completed', segments.map(({ id }) => ({ id, text: `t${id}` }))));
		await expect(promise).resolves.toMatchObject({ status: 'completed' });
	});

	test('rejects network after five failed reconnects with the backoff delays', async () => {
		vi.useFakeTimers();
		const { connector, promise } = start();
		const outcome = promise.catch(error => error);
		connector.last.remoteDisconnect();
		connector.failNext(5);

		const elapsed: number[] = [];
		let total = 0;
		for (const delay of [250, 500, 1000, 2000, 4000]) {
			const calls = connector.connect.mock.calls.length;
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(connector.connect.mock.calls.length).toBe(calls);
			await vi.advanceTimersByTimeAsync(1);
			expect(connector.connect.mock.calls.length).toBe(calls + 1);
			total += delay;
			elapsed.push(total);
		}
		const error = await outcome;
		expect(isAiError(error)).toBe(true);
		expect(error).toMatchObject({ code: 'network', retryable: true });
		expect(connector.connect).toHaveBeenCalledTimes(6);
		expect(elapsed).toEqual([250, 750, 1750, 3750, 7750]);
	});

	test('a reconnect whose port disconnects before answering counts as a failed attempt', async () => {
		vi.useFakeTimers();
		const { connector, promise } = start({ reconnectDelaysMs: [10, 10] });
		const outcome = promise.catch(error => error);
		connector.last.remoteDisconnect();
		await vi.advanceTimersByTimeAsync(10);
		connector.last.remoteDisconnect();
		await vi.advanceTimersByTimeAsync(10);
		connector.last.remoteDisconnect();
		await expect(outcome).resolves.toMatchObject({ code: 'network' });
		expect(connector.ports).toHaveLength(3);
		expect(connector.ports.every(port => port.listenerCount === 0)).toBe(true);
	});

	test('rejects with the attach error when the job is no longer running', async () => {
		vi.useFakeTimers();
		const { connector, promise } = start();
		const outcome = promise.catch(error => error);
		connector.last.remoteDisconnect();
		await vi.advanceTimersByTimeAsync(250);
		connector.last.receive({
			type: 'error',
			jobId,
			error: { code: 'provider-error', retryable: true, detail: 'The job is no longer running.' }
		});
		const error = await outcome;
		expect(isAiError(error)).toBe(true);
		expect(error).toMatchObject({ code: 'provider-error', retryable: true, detail: 'The job is no longer running.' });
		expect(connector.last.disconnected).toBe(true);
	});

	test('abort posts cancel, rejects cancelled, and disconnects', async () => {
		const controller = new AbortController();
		const { connector, promise } = start({ signal: controller.signal });
		controller.abort();
		await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
		expect(connector.last.posted[1]).toEqual({ type: 'cancel', jobId });
		expect(connector.last.disconnected).toBe(true);
		expect(connector.last.listenerCount).toBe(0);
	});

	test('abort during a reconnect wait cancels on a fresh port and stops reconnecting', async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const { connector, promise } = start({ signal: controller.signal });
		connector.last.remoteDisconnect();
		controller.abort();
		await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
		expect(connector.ports).toHaveLength(2);
		expect(connector.last.posted).toEqual([{ type: 'cancel', jobId }]);
		expect(connector.last.disconnected).toBe(true);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(connector.ports).toHaveLength(2);
	});

	test('rejects immediately when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const connect = vi.fn();
		await expect(runTranscriptJob('translate', input, { signal: controller.signal, connect })).rejects.toMatchObject({ code: 'cancelled' });
		expect(connect).not.toHaveBeenCalled();
	});

	test('a failed job rejects with the deserialized error including retryAfterMs', async () => {
		const { connector, promise } = start();
		connector.last.receive(jobState('failed', [{ id: 0, text: '一' }], {
			error: { code: 'rate-limited', retryable: true, status: 429, retryAfterMs: 90_000 }
		}));
		const error = await promise.catch(value => value);
		expect(isAiError(error)).toBe(true);
		expect(error).toMatchObject({ code: 'rate-limited', retryable: true, status: 429, retryAfterMs: 90_000 });
	});

	test('a failed job rejection carries the attempts the run spent', async () => {
		const { connector, promise } = start();
		connector.last.receive(jobState('failed', [], {
			attempts: { requests: 4, retries: 0, splits: 2 },
			error: { code: 'timeout', retryable: true, nativeCode: 'timeout', timeoutSeconds: 300 }
		}));
		const error = await promise.catch(value => value);
		expect(error).toMatchObject({ code: 'timeout', nativeCode: 'timeout' });
		expect(transcriptJobAttempts(error)).toEqual({ requests: 4, retries: 0, splits: 2 });
	});

	test('errors without job attempts report none', async () => {
		const { connector, promise } = start();
		connector.last.receive({ type: 'error', jobId, error: { code: 'auth', retryable: false } });
		const error = await promise.catch(value => value);
		expect(transcriptJobAttempts(error)).toBeUndefined();
		expect(transcriptJobAttempts(new Error('plain'))).toBeUndefined();
	});

	test('a cancelled job rejects cancelled', async () => {
		const { connector, promise } = start();
		connector.last.receive(jobState('cancelled', []));
		await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
	});

	test('an error for the job rejects with it', async () => {
		const { connector, promise } = start();
		connector.last.receive({ type: 'error', jobId, error: { code: 'not-configured', retryable: false, reason: 'no-profile' } });
		await expect(promise).rejects.toMatchObject({ code: 'not-configured', reason: 'no-profile' });
	});

	test('incomplete resolves with gaps and the incomplete error', async () => {
		const { connector, promise } = start();
		connector.last.receive(jobState('incomplete', [{ id: 0, text: '一' }, { id: 2, text: '三' }], {
			error: { code: 'incomplete', retryable: true }
		}));
		const result = await promise;
		expect(result).toMatchObject({
			status: 'incomplete',
			values: ['一', '', '三', ''],
			results: [{ id: 0, text: '一' }, { id: 2, text: '三' }],
			completedSegments: 2,
			totalSegments: 4
		});
		expect(isAiError(result.error)).toBe(true);
		expect(result.error?.code).toBe('incomplete');
	});

	test('reading jobs align tokens and fill gaps with empty lists', async () => {
		const connector = createConnector();
		const readingSegments = [{ id: 0, text: '日本' }, { id: 1, text: '' }, { id: 2, text: '語' }];
		const readingIdentity = { namespace: 'japanese-readings', scope: 'shared' };
		const promise = runTranscriptJob('reading', { instruction: 'Read.', segments: readingSegments, identity: readingIdentity }, {
			connect: connector.connect
		});
		const readingJobId = transcriptJobId('reading', readingIdentity, readingSegments);
		expect(connector.last.posted[0]).toMatchObject({ type: 'start-job', jobId: readingJobId, task: 'reading' });
		connector.last.receive({
			type: 'job-state',
			jobId: readingJobId,
			status: 'incomplete',
			completedGroups: 1,
			totalGroups: 1,
			completedSegments: 2,
			totalSegments: 3,
			results: [{ id: 0, tokens: [{ text: '日本', reading: 'にほん' }] }, { id: 1, tokens: [] }],
			attempts
		});
		await expect(promise).resolves.toMatchObject({
			status: 'incomplete',
			values: [[{ text: '日本', reading: 'にほん' }], [], []],
			results: [{ id: 0, tokens: [{ text: '日本', reading: 'にほん' }] }, { id: 1, tokens: [] }]
		});
	});

	test('reports job-retry backoff', async () => {
		const onRetry = vi.fn();
		const { connector, promise } = start({ onRetry });
		connector.last.receive({ type: 'job-retry', jobId, code: 'rate-limited', status: 429, delayMs: 7000, attempt: 1 });
		expect(onRetry).toHaveBeenCalledWith({ code: 'rate-limited', status: 429, delayMs: 7000, attempt: 1 });
		connector.last.receive(jobState('completed', segments.map(({ id }) => ({ id, text: `t${id}` }))));
		await expect(promise).resolves.toMatchObject({ status: 'completed' });
	});

	test('pings while pending and stops after settling', async () => {
		vi.useFakeTimers();
		const { connector, promise } = start({ keepaliveMs: 1000 });
		vi.advanceTimersByTime(2500);
		expect(connector.last.posted.filter(message => message.type === 'ping')).toHaveLength(2);
		connector.last.receive(jobState('completed', segments.map(({ id }) => ({ id, text: `t${id}` }))));
		await promise;
		vi.advanceTimersByTime(5000);
		expect(connector.last.posted.filter(message => message.type === 'ping')).toHaveLength(2);
	});

	test('a failed first connect is a network error', async () => {
		const connect = vi.fn(() => {
			throw new Error('Extension context invalidated.');
		});
		await expect(runTranscriptJob('translate', input, { connect })).rejects.toMatchObject({
			code: 'network',
			detail: 'Extension context invalidated.'
		});
	});

	test('rejects segments whose ids are not their index without connecting', async () => {
		const connect = vi.fn();
		const shuffled = { ...input, segments: [{ id: 1, text: 'a' }, { id: 0, text: 'b' }] };
		const error = await runTranscriptJob('translate', shuffled, { connect }).catch(value => value);
		expect(isAiError(error)).toBe(true);
		expect(error.code).toBe('provider-error');
		expect(connect).not.toHaveBeenCalled();
	});
});

describe('transcript checkpoints', () => {
	test('load does one checkpoint-get round trip, aligns values, and disconnects', async () => {
		const connector = createConnector();
		const promise = loadTranscriptCheckpoint('translate', identity, segments, { connect: connector.connect });
		const port = connector.last;
		expect(port.posted).toHaveLength(1);
		expect(port.posted[0]).toMatchObject({ type: 'checkpoint-get', jobId });
		const requestId = port.posted[0].requestId;
		port.receive({ type: 'checkpoint', requestId: 'other', jobId, ok: true });
		port.receive({
			type: 'checkpoint',
			requestId,
			jobId,
			ok: true,
			record: { status: 'incomplete', results: [{ id: 1, text: '二' }], completedSegments: 1, totalSegments: 4 }
		});
		await expect(promise).resolves.toEqual({
			status: 'incomplete',
			values: ['', '二', '', ''],
			completedSegments: 1,
			totalSegments: 4
		});
		expect(connector.ports).toHaveLength(1);
		expect(port.disconnected).toBe(true);
		expect(port.listenerCount).toBe(0);
	});

	test('load resolves undefined when there is no record', async () => {
		const connector = createConnector();
		const promise = loadTranscriptCheckpoint('translate', identity, segments, { connect: connector.connect });
		const { requestId } = connector.last.posted[0];
		connector.last.receive({ type: 'checkpoint', requestId, jobId, ok: true });
		await expect(promise).resolves.toBeUndefined();
	});

	test('load rejects network when the port disconnects first', async () => {
		const connector = createConnector();
		const promise = loadTranscriptCheckpoint('translate', identity, segments, { connect: connector.connect });
		connector.last.remoteDisconnect();
		await expect(promise).rejects.toMatchObject({ code: 'network' });
		expect(connector.last.listenerCount).toBe(0);
	});

	test('save sends checkpoint-put with contract-valid items only', async () => {
		const connector = createConnector();
		const promise = saveTranscriptCheckpoint('translate', identity, segments, ['一', '  ', '三', ''], {
			connect: connector.connect
		});
		const message = connector.last.posted[0];
		expect(message).toMatchObject({
			type: 'checkpoint-put',
			jobId,
			task: 'translate',
			identity,
			segmentCount: 4,
			segments,
			results: [{ id: 0, text: '一' }, { id: 2, text: '三' }]
		});
		expect(isAiClientMessage(message)).toBe(true);
		connector.last.receive({ type: 'checkpoint', requestId: message.requestId, jobId, ok: true });
		await expect(promise).resolves.toBe(true);
		expect(connector.last.disconnected).toBe(true);
	});

	test('save keeps complete readings, including an empty segment, and drops incomplete ones', async () => {
		const connector = createConnector();
		const readingSegments = [{ id: 0, text: '日本' }, { id: 1, text: '' }, { id: 2, text: '語' }, { id: 3, text: 'かな' }];
		const readingIdentity = { namespace: 'japanese-readings', scope: 'shared' };
		const promise = saveTranscriptCheckpoint('reading', readingIdentity, readingSegments, [
			[{ text: '日本', reading: 'にほん' }],
			[],
			[{ text: '語', reading: '' }],
			[]
		], { connect: connector.connect });
		const message = connector.last.posted[0];
		expect(message.jobId).toBe(transcriptJobId('reading', readingIdentity, readingSegments));
		expect(message.segments).toEqual(readingSegments);
		expect(isAiClientMessage(message)).toBe(true);
		expect(message.results).toEqual([{ id: 0, tokens: [{ text: '日本', reading: 'にほん' }] }, { id: 1, tokens: [] }]);
		connector.last.receive({ type: 'checkpoint', requestId: message.requestId, jobId: message.jobId, ok: false });
		await expect(promise).resolves.toBe(false);
	});

	test('clear sends checkpoint-clear and resolves with ok', async () => {
		const connector = createConnector();
		const promise = clearTranscriptCheckpoint('translate', identity, segments, { connect: connector.connect });
		const message = connector.last.posted[0];
		expect(message).toEqual({ type: 'checkpoint-clear', requestId: message.requestId, jobId });
		connector.last.receive({ type: 'checkpoint', requestId: message.requestId, jobId, ok: true });
		await expect(promise).resolves.toBe(true);
		expect(connector.ports).toHaveLength(1);
		expect(connector.last.disconnected).toBe(true);
	});

	test('a gateway error for the job rejects the checkpoint request', async () => {
		const connector = createConnector();
		const promise = clearTranscriptCheckpoint('translate', identity, segments, { connect: connector.connect });
		connector.last.receive({ type: 'error', jobId, error: { code: 'provider-error', retryable: false, detail: 'Invalid AI request.' } });
		await expect(promise).rejects.toMatchObject({ code: 'provider-error', detail: 'Invalid AI request.' });
	});
});
