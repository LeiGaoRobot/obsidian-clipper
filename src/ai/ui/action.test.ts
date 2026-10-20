import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AiError } from '../errors';
import { createAiAction, type AiActionProgress, type AiActionState } from './action';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A run the test settles by hand, with the signal and reporter it was given. */
function manualRun<T>() {
	const calls: Array<{ signal: AbortSignal; report: (progress: AiActionProgress) => void; result: ReturnType<typeof deferred<T>> }> = [];
	const run = vi.fn((signal: AbortSignal, report: (progress: AiActionProgress) => void) => {
		const result = deferred<T>();
		calls.push({ signal, report, result });
		return result.promise;
	});
	return { run, calls };
}

function setup() {
	let time = 1000;
	const changes: Array<{ state: AiActionState; previous: AiActionState }> = [];
	const action = createAiAction<string>({
		onChange: (state, previous) => changes.push({ state, previous }),
		now: () => time
	});
	return {
		action,
		changes,
		statuses: () => changes.map(change => change.state.status),
		advance: (ms: number) => {
			time += ms;
		}
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('createAiAction', () => {
	test('starts idle and never runs on its own', async () => {
		const { action, changes } = setup();
		await vi.runAllTimersAsync();
		expect(action.state).toEqual({ status: 'idle' });
		expect(changes).toEqual([]);
		await expect(action.retry()).resolves.toBeUndefined();
		expect(changes).toEqual([]);
	});

	test('start moves idle → running with startedAt, then done with the value', async () => {
		const { action, statuses } = setup();
		const { run, calls } = manualRun<string>();
		const result = action.start(run);
		expect(action.state).toEqual({ status: 'running', startedAt: 1000 });
		expect(run).toHaveBeenCalledOnce();
		expect(calls[0].signal.aborted).toBe(false);

		calls[0].result.resolve('answer');
		await expect(result).resolves.toBe('answer');
		expect(action.state).toEqual({ status: 'done', startedAt: 1000 });
		expect(statuses()).toEqual(['running', 'done']);
	});

	test('progress reports update the state and fire onChange', async () => {
		const { action, changes } = setup();
		const { run, calls } = manualRun<string>();
		void action.start(run);
		calls[0].report({ completed: 1, total: 3 });
		calls[0].report({ completed: 1, total: 3, retry: { delayMs: 2000, attempt: 1 } });

		expect(action.state).toEqual({
			status: 'running',
			startedAt: 1000,
			progress: { completed: 1, total: 3, retry: { delayMs: 2000, attempt: 1 } }
		});
		expect(changes.map(change => change.state.progress)).toEqual([
			undefined,
			{ completed: 1, total: 3 },
			{ completed: 1, total: 3, retry: { delayMs: 2000, attempt: 1 } }
		]);
	});

	test('a rejected run gives error through toAiError and keeps the last progress', async () => {
		const { action } = setup();
		const { run, calls } = manualRun<string>();
		const result = action.start(run);
		calls[0].report({ completed: 2, total: 5 });
		calls[0].result.reject(new TypeError('Failed to fetch'));

		await expect(result).resolves.toBeUndefined();
		expect(action.state.status).toBe('error');
		expect(action.state.error).toBeInstanceOf(AiError);
		expect(action.state.error).toMatchObject({ code: 'network', detail: 'Failed to fetch' });
		expect(action.state.progress).toEqual({ completed: 2, total: 5 });
		expect(action.state.startedAt).toBe(1000);
	});

	test('an AiError rejection is kept as is', async () => {
		const { action } = setup();
		const error = new AiError('auth', { status: 401 });
		await action.start(async () => {
			throw error;
		});
		expect(action.state.error).toBe(error);
	});

	test('a run that throws synchronously still ends in error', async () => {
		const { action } = setup();
		await action.start(() => {
			throw new Error('boom');
		});
		expect(action.state).toMatchObject({ status: 'error', error: { code: 'provider-error', detail: 'boom' } });
	});

	test.each([
		['an AiError cancelled', (call: { result: { reject: (error: unknown) => void } }) => call.result.reject(new AiError('cancelled'))],
		['a DOM AbortError', (call: { result: { reject: (error: unknown) => void } }) => call.result.reject(new DOMException('Aborted', 'AbortError'))],
		['a late resolution', (call: { result: { resolve: (value: string) => void } }) => call.result.resolve('too late')]
	] as const)('cancel aborts the signal and the settlement is cancelled after %s', async (_label, settle) => {
		const { action, statuses } = setup();
		const { run, calls } = manualRun<string>();
		const result = action.start(run);
		calls[0].report({ completed: 1, total: 4 });
		action.cancel();

		expect(calls[0].signal.aborted).toBe(true);
		expect(action.state).toEqual({ status: 'cancelled', startedAt: 1000, progress: { completed: 1, total: 4 } });
		await expect(result).resolves.toBeUndefined();

		settle(calls[0] as never);
		await vi.runAllTimersAsync();
		expect(action.state.status).toBe('cancelled');
		expect(statuses()).toEqual(['running', 'running', 'cancelled']);
	});

	test('a run that rejects with cancelled on its own ends cancelled, not error', async () => {
		const { action } = setup();
		await action.start(async () => {
			throw new AiError('cancelled');
		});
		expect(action.state).toEqual({ status: 'cancelled', startedAt: 1000 });
	});

	test('cancel without a running run changes nothing', async () => {
		const { action, changes } = setup();
		action.cancel();
		await action.start(async () => 'value');
		const count = changes.length;
		action.cancel();
		expect(changes).toHaveLength(count);
		expect(action.state.status).toBe('done');
	});

	test('a second start aborts the first, and the first run\'s late settlement changes nothing', async () => {
		const { action, changes, advance } = setup();
		const { run, calls } = manualRun<string>();
		const first = action.start(run);
		calls[0].report({ completed: 1, total: 2 });
		advance(500);
		const second = action.start(run);

		expect(calls[0].signal.aborted).toBe(true);
		expect(calls[1].signal.aborted).toBe(false);
		await expect(first).resolves.toBeUndefined();
		expect(action.state).toEqual({ status: 'running', startedAt: 1500 });

		const before = changes.length;
		calls[0].report({ completed: 2, total: 2 });
		calls[0].result.resolve('stale');
		await vi.runAllTimersAsync();
		expect(changes).toHaveLength(before);
		expect(action.state.status).toBe('running');

		calls[1].result.resolve('fresh');
		await expect(second).resolves.toBe('fresh');
		expect(action.state).toEqual({ status: 'done', startedAt: 1500 });
	});

	test('a stale rejection after a newer start changes nothing', async () => {
		const { action } = setup();
		const { run, calls } = manualRun<string>();
		void action.start(run);
		const second = action.start(run);
		calls[0].result.reject(new AiError('auth'));
		await vi.runAllTimersAsync();
		expect(action.state.status).toBe('running');
		calls[1].result.resolve('ok');
		await expect(second).resolves.toBe('ok');
	});

	test('retry re-runs the last run with a fresh signal and reset progress', async () => {
		const { action, advance } = setup();
		const { run, calls } = manualRun<string>();
		const first = action.start(run);
		calls[0].report({ completed: 1, total: 3 });
		calls[0].result.reject(new AiError('rate-limited'));
		await first;
		expect(action.state).toMatchObject({ status: 'error', progress: { completed: 1, total: 3 } });

		advance(2000);
		const retried = action.retry();
		expect(run).toHaveBeenCalledTimes(2);
		expect(calls[1].signal).not.toBe(calls[0].signal);
		expect(calls[1].signal.aborted).toBe(false);
		expect(action.state).toEqual({ status: 'running', startedAt: 3000 });

		calls[1].result.resolve('second time');
		await expect(retried).resolves.toBe('second time');
		expect(action.state.status).toBe('done');
	});

	test('dispose cancels and ignores everything after', async () => {
		const { action, statuses } = setup();
		const { run, calls } = manualRun<string>();
		const result = action.start(run);
		action.dispose();

		expect(calls[0].signal.aborted).toBe(true);
		await expect(result).resolves.toBeUndefined();
		expect(statuses()).toEqual(['running', 'cancelled']);

		calls[0].report({ completed: 1, total: 1 });
		calls[0].result.resolve('late');
		await expect(action.start(run)).resolves.toBeUndefined();
		await expect(action.retry()).resolves.toBeUndefined();
		action.cancel();
		await vi.runAllTimersAsync();
		expect(run).toHaveBeenCalledOnce();
		expect(statuses()).toEqual(['running', 'cancelled']);
	});

	test('onChange receives (state, previous) once per transition', async () => {
		const { action, changes } = setup();
		const { run, calls } = manualRun<string>();
		void action.start(run);
		calls[0].report({ completed: 1, total: 2 });
		calls[0].result.reject(new AiError('timeout'));
		await vi.runAllTimersAsync();

		expect(changes).toHaveLength(3);
		expect(changes[0]).toEqual({ previous: { status: 'idle' }, state: { status: 'running', startedAt: 1000 } });
		expect(changes[1].previous).toBe(changes[0].state);
		expect(changes[2].previous).toBe(changes[1].state);
		expect(changes[2].state).toMatchObject({ status: 'error', error: { code: 'timeout' }, progress: { completed: 1, total: 2 } });
		expect(action.state).toBe(changes[2].state);
	});

	test('owns no timers', () => {
		const { action } = setup();
		void action.start(() => new Promise<string>(() => undefined));
		expect(vi.getTimerCount()).toBe(0);
		action.cancel();
		expect(vi.getTimerCount()).toBe(0);
	});
});
