import { describe, expect, test, vi } from 'vitest';
import type { TranscriptSegment } from './contracts';
import { AiError } from './errors';
import { hashSegments, transcriptJobId, type TranscriptJobTask } from './job-identity';
import {
	buildTranscriptPromptGroups,
	createJobRunner,
	isEmptySourceSegment,
	jobRetryBudget,
	maxConcurrencyFor,
	readingMaxTokens,
	retryDelayMs,
	RESUME_WINDOW_MS,
	transcriptGroupBudget,
	transcriptGroupMaxTokens,
	translationMaxTokens,
	type JobRunnerDeps,
	type JobRunnerEvent
} from './job-runner';
import { aiJobInputStorageKey, aiJobStorageKey, createAiJobStore, type AiJobRecord, type StorageAreaLike } from './job-store';
import type { AiJobInput, AiJobProgressMessage, AiJobRetryMessage, AiJobStateMessage } from './protocol';
import type { AiDiagnosticEntry, ConnectionKind } from './types';

// ---------------------------------------------------------------------------------------------
// Fakes

const flush = async (rounds = 4) => {
	for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setImmediate(resolve));
};

interface TrackingArea extends StorageAreaLike {
	values: Map<string, unknown>;
	maxConcurrentSets: number;
	/** Keys of every `set` call, including rejected ones. */
	sets: string[];
	/** While set, `set` calls wait for it. */
	gate?: Promise<void>;
	/** Returns an error to reject a `set` with, e.g. a quota error. */
	rejectSet?: (entries: Record<string, unknown>) => Error | undefined;
}

// Async and cloning like storage.session; counts overlapping `set` calls.
function trackingArea(): TrackingArea {
	const values = new Map<string, unknown>();
	const clone = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
	let active = 0;
	const area: TrackingArea = {
		values,
		maxConcurrentSets: 0,
		sets: [],
		async get(keys) {
			await Promise.resolve();
			const wanted = keys === null || keys === undefined
				? Array.from(values.keys())
				: (Array.isArray(keys) ? keys : [keys]).filter(key => values.has(key));
			return Object.fromEntries(wanted.map(key => [key, clone(values.get(key))]));
		},
		async set(entries) {
			area.sets.push(...Object.keys(entries));
			if (area.gate) await area.gate;
			const rejection = area.rejectSet?.(entries);
			if (rejection) throw rejection;
			active += 1;
			area.maxConcurrentSets = Math.max(area.maxConcurrentSets, active);
			await Promise.resolve();
			await Promise.resolve();
			Object.entries(entries).forEach(([key, value]) => values.set(key, clone(value)));
			active -= 1;
		},
		async remove(keys) {
			await Promise.resolve();
			(Array.isArray(keys) ? keys : [keys]).forEach(key => values.delete(key));
		}
	};
	return area;
}

/** Holds every later `set` until the returned function opens the gate. */
function closeGate(area: TrackingArea): () => void {
	let open: () => void = () => undefined;
	area.gate = new Promise<void>(resolve => {
		open = resolve;
	});
	return () => {
		area.gate = undefined;
		open();
	};
}

function fakeClock(start = 1_000_000) {
	let time = start;
	let sequence = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	return {
		now: () => time,
		setTimeout: (callback: () => void, ms: number) => {
			sequence += 1;
			timers.set(sequence, { at: time + ms, callback });
			return sequence;
		},
		clearTimeout: (handle: unknown) => {
			timers.delete(handle as number);
		},
		get pending() {
			return timers.size;
		},
		async advance(ms: number) {
			const end = time + ms;
			for (;;) {
				const due = Array.from(timers.entries())
					.filter(([, timer]) => timer.at <= end)
					.sort((left, right) => left[1].at - right[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				time = due[1].at;
				due[1].callback();
				await flush();
			}
			time = end;
			await flush();
		}
	};
}

interface ExecCall {
	task: TranscriptJobTask;
	input: { instruction: string; segments: TranscriptSegment[]; maxTokens?: number };
	ids: number[];
	settled: boolean;
	resolve(output: unknown[]): void;
	reject(error: unknown): void;
}

type Respond = (call: ExecCall, index: number) => unknown[] | Error | 'hold';

interface SetupOptions {
	kind?: ConnectionKind;
	maxConcurrency?: number;
	respond?: Respond;
	/** False mimics Safari's sendNativeMessage, which cannot be aborted. */
	abortable?: boolean;
}

const echo: Respond = call => call.task === 'translate'
	? call.input.segments.map(segment => ({ id: segment.id, text: `T:${segment.text}` }))
	: call.input.segments.map(segment => ({ id: segment.id, tokens: [{ text: segment.text, reading: '' }] }));

function setup(options: SetupOptions = {}) {
	const area = trackingArea();
	const store = createAiJobStore(area);
	const clock = fakeClock();
	const calls: ExecCall[] = [];
	const stats = { inFlight: 0, maxInFlight: 0 };
	const connection = { kind: options.kind ?? 'openai-compatible' as ConnectionKind, id: 'conn-1', maxConcurrency: options.maxConcurrency };
	const diagnostics: AiDiagnosticEntry[] = [];
	const respond = options.respond ?? echo;
	const execute = ((task: TranscriptJobTask, input: ExecCall['input'], { signal }: { signal: AbortSignal }) => (
		new Promise<unknown>((resolve, reject) => {
			stats.inFlight += 1;
			stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
			const finish = () => {
				call.settled = true;
				stats.inFlight -= 1;
			};
			const call: ExecCall = {
				task,
				input,
				ids: input.segments.map(segment => segment.id),
				settled: false,
				resolve(output) {
					if (call.settled) return;
					finish();
					resolve({ output, connectionKind: connection.kind });
				},
				reject(error) {
					if (call.settled) return;
					finish();
					reject(error);
				}
			};
			calls.push(call);
			if (options.abortable !== false) {
				signal.addEventListener('abort', () => call.reject(new AiError('cancelled')));
			}
			const answer = respond(call, calls.length - 1);
			if (answer instanceof Error) queueMicrotask(() => call.reject(answer));
			else if (Array.isArray(answer)) queueMicrotask(() => call.resolve(answer));
		})
	)) as JobRunnerDeps['execute'];
	const runner = createJobRunner({
		store,
		resolveConnection: async () => ({ ...connection }),
		execute,
		now: clock.now,
		random: () => 0.5,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		heartbeatMs: 20_000,
		recordDiagnostics: entry => diagnostics.push(entry)
	});
	const events: JobRunnerEvent[] = [];
	const listener = (event: JobRunnerEvent) => {
		events.push(event);
	};
	const states = () => events.filter((event): event is AiJobStateMessage => event.type === 'job-state');
	const progress = () => events.filter((event): event is AiJobProgressMessage => event.type === 'job-progress');
	const retries = () => events.filter((event): event is AiJobRetryMessage => event.type === 'job-retry');
	const final = () => states().find(state => state.status !== 'running');
	return { area, store, clock, calls, stats, connection, diagnostics, runner, events, listener, states, progress, retries, final };
}

const IDENTITY = { namespace: 'transcript-translation', scope: 'video:zh-CN' };

function jobInput(task: TranscriptJobTask, texts: string[]): { jobId: string; input: AiJobInput } {
	const segments = texts.map((text, id) => ({ id, text }));
	const instruction = task === 'translate' ? 'Translate.' : 'Annotate.';
	return { jobId: transcriptJobId(task, IDENTITY, segments), input: { instruction, segments, identity: IDENTITY } };
}

/** Texts that each fill one API translate group (6000 chars). */
function oneGroupEach(count: number): string[] {
	return Array.from({ length: count }, (_, index) => String(index).padEnd(3500, 'x'));
}

function storedRecord(
	task: TranscriptJobTask,
	texts: string[],
	overrides: Partial<AiJobRecord>,
	now: number
): AiJobRecord {
	const { jobId } = jobInput(task, texts);
	return {
		v: 1,
		id: jobId,
		task,
		identity: IDENTITY,
		segmentCount: texts.length,
		segmentHash: hashSegments(IDENTITY.scope, texts),
		status: 'running',
		results: {},
		attempts: { requests: 0, retries: 0, splits: 0 },
		createdAt: now - 5000,
		updatedAt: now - 1000,
		...overrides
	};
}

async function seed(harness: ReturnType<typeof setup>, record: AiJobRecord, texts?: string[], instruction = 'Translate.') {
	await harness.store.put(record);
	if (texts) await harness.store.putInput(record.id, { instruction, segments: texts });
}

// ---------------------------------------------------------------------------------------------
// Policy and planning

describe('job runner policy', () => {
	test('group budgets by connection kind and task', () => {
		for (const kind of ['openai-compatible', 'anthropic', 'ollama', 'azure-openai'] as ConnectionKind[]) {
			expect(transcriptGroupBudget(kind, 'translate')).toBe(6000);
			expect(transcriptGroupBudget(kind, 'reading')).toBe(2500);
			// Splits apply to CLIs only.
			expect(transcriptGroupBudget(kind, 'reading', 600)).toBe(2500);
		}
		expect(transcriptGroupBudget('cli-codex', 'translate')).toBe(6000);
		expect(transcriptGroupBudget('cli-codex', 'reading')).toBe(2500);
		expect(transcriptGroupBudget('cli-grok', 'translate')).toBe(6000);
		expect(transcriptGroupBudget('cli-grok', 'reading')).toBe(1600);
		expect(transcriptGroupBudget('cli-grok', 'reading', 800)).toBe(800);
	});

	test('concurrency defaults and the connection override', () => {
		expect(maxConcurrencyFor({ kind: 'openai-compatible' })).toBe(3);
		expect(maxConcurrencyFor({ kind: 'anthropic' })).toBe(3);
		expect(maxConcurrencyFor({ kind: 'ollama' })).toBe(1);
		expect(maxConcurrencyFor({ kind: 'cli-codex' })).toBe(1);
		expect(maxConcurrencyFor({ kind: 'cli-grok' })).toBe(1);
		expect(maxConcurrencyFor({ kind: 'ollama', maxConcurrency: 2 })).toBe(2);
		expect(maxConcurrencyFor({ kind: 'openai-compatible', maxConcurrency: 0 })).toBe(3);
		expect(maxConcurrencyFor({ kind: 'openai-compatible', maxConcurrency: 1.5 })).toBe(3);
	});

	test('retry budget and delays', () => {
		expect(jobRetryBudget(1)).toBe(2);
		expect(jobRetryBudget(5)).toBe(4);
		expect(jobRetryBudget(40)).toBe(8);
		expect(retryDelayMs(1, undefined, () => 0.5)).toBe(1000);
		expect(retryDelayMs(2, undefined, () => 0.5)).toBe(2000);
		expect(retryDelayMs(1, undefined, () => 0)).toBe(500);
		expect(retryDelayMs(10, undefined, () => 0.999)).toBe(Math.round(30_000 * 1.499));
		// Retry-After is a floor; jitter never sends a request before it.
		expect(retryDelayMs(1, 7000, () => 0)).toBe(7000);
	});

	test('maxTokens formulas', () => {
		const group = (sourceChars: number, count: number) => ({
			sourceChars,
			segments: Array.from({ length: count }, (_, id) => ({ id, text: '' }))
		});
		expect(translationMaxTokens(group(100, 2))).toBe(1600);
		expect(translationMaxTokens(group(3000, 10))).toBe(Math.ceil(3000 * 1.2 + 150));
		expect(translationMaxTokens(group(10_000, 10))).toBe(8000);
		expect(readingMaxTokens(group(100, 1))).toBe(2000);
		expect(readingMaxTokens(group(1000, 1))).toBe(5000);
		expect(readingMaxTokens(group(10_000, 1))).toBe(16000);
		expect(transcriptGroupMaxTokens('translate', group(3000, 10))).toBe(translationMaxTokens(group(3000, 10)));
		expect(transcriptGroupMaxTokens('reading', group(1000, 1))).toBe(5000);
	});

	test('groups keep source ids, stay atomic, and skip excluded ids', () => {
		const groups = buildTranscriptPromptGroups(['a', 'b'.repeat(50), 'c', 'd'], 'Do.', 40, id => id !== 3);
		expect(groups.map(group => group.segments.map(segment => segment.id))).toEqual([[0], [1], [2]]);
		expect(groups[1].sourceChars).toBe(50);
	});

	test('empty sources need no request', () => {
		expect(isEmptySourceSegment('translate', '')).toBe(true);
		expect(isEmptySourceSegment('translate', '  ')).toBe(true);
		expect(isEmptySourceSegment('reading', '')).toBe(true);
		// A whitespace reading must still reproduce its source, so it is requested as today.
		expect(isEmptySourceSegment('reading', ' ')).toBe(false);
		expect(isEmptySourceSegment('translate', 'a')).toBe(false);
	});
});

describe('job runner planning', () => {
	test('sends each group with its maxTokens and the instruction', async () => {
		const harness = setup();
		const { jobId, input } = jobInput('translate', ['hello', 'world']);
		await harness.runner.start(jobId, 'translate', input, 'profile-1', harness.listener);
		await flush();
		expect(harness.calls).toHaveLength(1);
		expect(harness.calls[0].input).toEqual({
			instruction: 'Translate.',
			segments: [{ id: 0, text: 'hello' }, { id: 1, text: 'world' }],
			maxTokens: 1600
		});
		expect(harness.states()[0]).toMatchObject({ status: 'running', totalGroups: 1, completedGroups: 0, totalSegments: 2 });
		expect(harness.final()).toMatchObject({
			status: 'completed',
			completedGroups: 1,
			completedSegments: 2,
			results: [{ id: 0, text: 'T:hello' }, { id: 1, text: 'T:world' }],
			attempts: { requests: 1, retries: 0, splits: 0 }
		});
		expect(harness.final()?.error).toBeUndefined();
		expect((await harness.store.get(jobId))?.profileId).toBe('profile-1');
	});

	test('rebuilds groups from the missing ids only and keeps earlier results', async () => {
		const harness = setup();
		const texts = oneGroupEach(3);
		const { jobId, input } = jobInput('translate', texts);
		await seed(harness, storedRecord('translate', texts, {
			status: 'incomplete',
			results: { 1: 'done' },
			attempts: { requests: 4, retries: 2, splits: 0 },
			error: { code: 'incomplete', retryable: true }
		}, harness.clock.now()));
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		expect(harness.calls.map(call => call.ids)).toEqual([[0], [2]]);
		expect(harness.states()[0]).toMatchObject({ totalGroups: 2, completedSegments: 1, results: [{ id: 1, text: 'done' }] });
		expect(harness.final()).toMatchObject({
			status: 'completed',
			completedSegments: 3,
			attempts: { requests: 2, retries: 0, splits: 0 }
		});
		expect(harness.final()?.results.map(item => item.id)).toEqual([0, 1, 2]);
	});

	test('empty-source segments count as complete without a request', async () => {
		const harness = setup();
		const { jobId, input } = jobInput('translate', ['', 'hello', '  ']);
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		expect(harness.calls.map(call => call.ids)).toEqual([[1]]);
		expect(harness.final()).toMatchObject({
			status: 'completed',
			completedSegments: 3,
			totalSegments: 3,
			results: [{ id: 1, text: 'T:hello' }]
		});

		const reading = setup();
		const job = jobInput('reading', ['', 'かな']);
		await reading.runner.start(job.jobId, 'reading', job.input, undefined, reading.listener);
		await flush();
		expect(reading.calls.map(call => call.ids)).toEqual([[1]]);
		expect(reading.final()).toMatchObject({ status: 'completed', completedSegments: 2 });
	});

	test('a transcript of only empty segments completes at once', async () => {
		const harness = setup();
		const { jobId, input } = jobInput('translate', ['', ' ']);
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		expect(harness.calls).toHaveLength(0);
		expect(harness.states()).toHaveLength(2);
		expect(harness.final()).toMatchObject({ status: 'completed', completedSegments: 2, results: [] });
	});
});

// ---------------------------------------------------------------------------------------------
// Pool

describe('job runner pool', () => {
	test('keeps at most maxConcurrency groups in flight and reports progress in source order', async () => {
		const harness = setup({ respond: () => 'hold' });
		const texts = oneGroupEach(5);
		const { jobId, input } = jobInput('translate', texts);
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		expect(harness.calls.map(call => call.ids)).toEqual([[0], [1], [2]]);

		// Group 3 of the first three finishes first: checkpointed now, reported after groups 1 and 2.
		harness.calls[2].resolve(echo(harness.calls[2], 2) as unknown[]);
		await flush();
		expect(harness.progress()).toHaveLength(0);
		expect(Object.keys((await harness.store.get(jobId))!.results)).toEqual(['2']);
		expect(harness.calls).toHaveLength(4);

		harness.calls[0].resolve(echo(harness.calls[0], 0) as unknown[]);
		await flush();
		harness.calls[1].resolve(echo(harness.calls[1], 1) as unknown[]);
		await flush();
		harness.calls.slice(3).forEach((call, index) => call.resolve(echo(call, index + 3) as unknown[]));
		await flush();
		harness.calls.slice(3).forEach((call, index) => call.resolve(echo(call, index + 3) as unknown[]));
		await flush();

		expect(harness.stats.maxInFlight).toBe(3);
		expect(harness.calls).toHaveLength(5);
		expect(harness.progress().map(event => event.results.map(item => item.id))).toEqual([[0], [1], [2], [3], [4]]);
		expect(harness.progress().map(event => event.completedGroups)).toEqual([1, 2, 3, 4, 5]);
		expect(harness.progress().map(event => event.completedSegments)).toEqual([1, 2, 3, 4, 5]);
		expect(harness.progress().every(event => event.totalGroups === 5 && event.totalSegments === 5)).toBe(true);
		// Checkpoint writes never overlap, and the last one holds every item.
		expect(harness.area.maxConcurrentSets).toBe(1);
		const record = await harness.store.get(jobId);
		expect(record?.status).toBe('completed');
		expect(Object.keys(record!.results)).toEqual(['0', '1', '2', '3', '4']);
		expect(harness.final()?.results).toHaveLength(5);
	});

	test('re-reads maxConcurrency before each dispatch', async () => {
		const harness = setup({ respond: () => 'hold', maxConcurrency: 1 });
		const { jobId, input } = jobInput('translate', oneGroupEach(3));
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		expect(harness.calls).toHaveLength(1);
		harness.connection.maxConcurrency = 2;
		harness.calls[0].resolve(echo(harness.calls[0], 0) as unknown[]);
		await flush();
		expect(harness.calls).toHaveLength(3);
	});

	test('accepts only requested ids', async () => {
		const harness = setup({
			respond: call => [...(echo(call, 0) as unknown[]), { id: 1, text: 'stray' }, { id: 0, text: 'duplicate' }]
		});
		const texts = oneGroupEach(2);
		const { jobId, input } = jobInput('translate', texts);
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		// Group 0 answered id 1 too; group 1 still asked for it and got its own answer.
		expect(harness.progress()[0].results).toEqual([{ id: 0, text: `T:${texts[0]}` }]);
		expect(harness.final()?.results).toEqual([{ id: 0, text: `T:${texts[0]}` }, { id: 1, text: `T:${texts[1]}` }]);
	});
});

// ---------------------------------------------------------------------------------------------
// Retry

describe('job runner retry', () => {
	test('honors Retry-After on a 429 and emits job-retry', async () => {
		const harness = setup({
			respond: (call, index) => index === 0
				? new AiError('rate-limited', { status: 429, retryAfterMs: 7000 })
				: echo(call, index)
		});
		const { jobId, input } = jobInput('translate', ['hello']);
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		expect(harness.retries()).toEqual([{
			type: 'job-retry',
			jobId,
			code: 'rate-limited',
			status: 429,
			delayMs: 7000,
			attempt: 1
		}]);
		await harness.clock.advance(6999);
		expect(harness.calls).toHaveLength(1);
		await harness.clock.advance(1);
		expect(harness.calls).toHaveLength(2);
		expect(harness.calls[1].ids).toEqual([0]);
		expect(harness.final()).toMatchObject({ status: 'completed', attempts: { requests: 2, retries: 1, splits: 0 } });
	});

	test('records one diagnostics entry per finished job with group and retry counts', async () => {
		const harness = setup({
			maxConcurrency: 1,
			respond: (call, index) => index === 0 ? new AiError('rate-limited', { status: 429, retryAfterMs: 1000 }) : echo(call, index)
		});
		const { jobId, input } = jobInput('translate', oneGroupEach(3));
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		await harness.clock.advance(1000);
		await flush(8);
		expect(harness.final()).toMatchObject({ status: 'completed' });
		expect(harness.diagnostics).toEqual([{
			at: harness.clock.now(),
			task: 'translate',
			kind: 'openai-compatible',
			connectionId: 'conn-1',
			durationMs: 1000,
			outcome: 'ok',
			groups: 3,
			retries: 1
		}]);
		// Never content, prompts, keys, or job ids.
		expect(Object.keys(harness.diagnostics[0]).sort()).toEqual(
			['at', 'connectionId', 'durationMs', 'groups', 'kind', 'outcome', 'retries', 'task']
		);
	});

	test('records a failed and a cancelled job with their codes', async () => {
		const failed = setup({ respond: () => new AiError('auth', { status: 401 }) });
		const first = jobInput('translate', ['hello']);
		await failed.runner.start(first.jobId, 'translate', first.input, undefined, failed.listener);
		await flush(8);
		expect(failed.diagnostics).toEqual([expect.objectContaining({ outcome: 'error', code: 'auth', status: 401, groups: 1, retries: 0 })]);

		const cancelled = setup({ respond: () => 'hold' });
		const second = jobInput('translate', ['hello']);
		await cancelled.runner.start(second.jobId, 'translate', second.input, undefined, cancelled.listener);
		await flush();
		await cancelled.runner.cancel(second.jobId);
		expect(cancelled.diagnostics).toEqual([expect.objectContaining({ outcome: 'cancelled', code: 'cancelled' })]);
	});

	test('retries a 503 twice, then fails the job', async () => {
		const harness = setup({
			maxConcurrency: 1,
			respond: () => new AiError('provider-error', { status: 503, retryable: true })
		});
		// Four groups give a job budget of 4, so the per-group limit is what stops here.
		const { jobId, input } = jobInput('translate', oneGroupEach(4));
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		await harness.clock.advance(1000);
		await harness.clock.advance(2000);
		await harness.clock.advance(60_000);
		expect(harness.calls.map(call => call.ids)).toEqual([[0], [0], [0]]);
		expect(harness.retries().map(event => [event.attempt, event.delayMs, event.status])).toEqual([[1, 1000, 503], [2, 2000, 503]]);
		expect(harness.final()).toMatchObject({
			status: 'failed',
			error: { code: 'provider-error', status: 503 },
			attempts: { requests: 3, retries: 2 }
		});
		expect((await harness.store.get(jobId))?.status).toBe('failed');
	});

	test('does not retry a quota 429', async () => {
		const harness = setup({ respond: () => new AiError('quota', { status: 429 }) });
		const { jobId, input } = jobInput('translate', ['hello']);
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		await harness.clock.advance(60_000);
		expect(harness.calls).toHaveLength(1);
		expect(harness.retries()).toHaveLength(0);
		expect(harness.final()).toMatchObject({ status: 'failed', error: { code: 'quota', status: 429 } });
	});

	test('does not retry an API timeout or a network error', async () => {
		for (const error of [new AiError('timeout', { timeoutSeconds: 120 }), new AiError('network')]) {
			const harness = setup({ respond: () => error });
			const { jobId, input } = jobInput('translate', ['hello']);
			await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
			await flush();
			await harness.clock.advance(60_000);
			expect(harness.calls).toHaveLength(1);
			expect(harness.final()).toMatchObject({ status: 'failed', error: { code: error.code } });
		}
	});

	test('does not wait out a Retry-After above 60 s', async () => {
		const harness = setup({ respond: () => new AiError('rate-limited', { status: 429, retryAfterMs: 61_000 }) });
		const { jobId, input } = jobInput('translate', ['hello']);
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		expect(harness.calls).toHaveLength(1);
		expect(harness.final()).toMatchObject({ status: 'failed', error: { code: 'rate-limited', retryAfterMs: 61_000 } });
	});

	test('the per-job budget stops retries across groups', async () => {
		const rateLimited = () => new AiError('rate-limited', { status: 429 });
		const harness = setup({
			maxConcurrency: 1,
			respond: (call, index) => index === 2 ? echo(call, index) : rateLimited()
		});
		// Two groups: budget min(8, 2 + 1) = 3.
		const { jobId, input } = jobInput('translate', oneGroupEach(2));
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		for (let step = 0; step < 6; step += 1) await harness.clock.advance(5000);
		// Group 0: 429, 429, ok (two retries). Group 1: 429, retry three, 429, out of budget.
		expect(harness.calls.map(call => call.ids)).toEqual([[0], [0], [0], [1], [1]]);
		expect(harness.retries().map(event => event.attempt)).toEqual([1, 2, 1]);
		expect(harness.final()).toMatchObject({
			status: 'failed',
			error: { code: 'rate-limited' },
			attempts: { requests: 5, retries: 3 }
		});
		expect((await harness.store.get(jobId))?.attempts.retries).toBe(3);
		expect(harness.final()?.results.map(item => item.id)).toEqual([0]);
	});

	test('cancel during backoff ends the job cancelled without another request', async () => {
		const harness = setup({ respond: () => new AiError('rate-limited', { status: 429, retryAfterMs: 5000 }) });
		const { jobId, input } = jobInput('translate', ['hello']);
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		expect(harness.retries()).toHaveLength(1);
		expect(await harness.runner.cancel(jobId)).toBe(true);
		await harness.clock.advance(120_000);
		expect(harness.calls).toHaveLength(1);
		expect(harness.final()).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } });
		expect(harness.states().filter(state => state.status !== 'running')).toHaveLength(1);
		expect((await harness.store.get(jobId))?.status).toBe('cancelled');
		expect(harness.runner.isActive(jobId)).toBe(false);
		expect(harness.clock.pending).toBe(0);
	});

	test('a fatal error ends another group\'s backoff without a request', async () => {
		const harness = setup({
			respond: (_call, index) => index === 0
				? new AiError('rate-limited', { status: 429, retryAfterMs: 30_000 })
				: new AiError('auth', { status: 401 })
		});
		const { jobId, input } = jobInput('translate', oneGroupEach(2));
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		expect(harness.calls).toHaveLength(2);
		expect(harness.final()).toMatchObject({ status: 'failed', error: { code: 'auth' } });
		await harness.clock.advance(60_000);
		expect(harness.calls).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------------------------
// CLI timeout split

describe('job runner CLI split', () => {
	// 1000-char segments: five per 6000-char group, two per 3000-char group.
	const texts = Array.from({ length: 10 }, (_, index) => String(index).padEnd(1000, 'y'));

	test('a CLI timeout halves the budget, re-plans the remaining ids, and succeeds', async () => {
		const harness = setup({
			kind: 'cli-codex',
			respond: (call, index) => index === 0 ? new AiError('timeout', { timeoutSeconds: 120 }) : echo(call, index)
		});
		const { jobId, input } = jobInput('translate', texts);
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush(8);
		expect(harness.calls[0].ids).toEqual([0, 1, 2, 3, 4]);
		expect(harness.calls.slice(1).map(call => call.ids)).toEqual([[0, 1], [2, 3], [4, 5], [6, 7], [8, 9]]);
		expect(harness.final()).toMatchObject({
			status: 'completed',
			completedGroups: 5,
			totalGroups: 5,
			completedSegments: 10,
			attempts: { requests: 6, retries: 0, splits: 1 }
		});
		const record = await harness.store.get(jobId);
		expect(record).toMatchObject({ cliPromptChars: 3000, attempts: { splits: 1 } });
	});

	test('fails with the timeout at the floor', async () => {
		const harness = setup({ kind: 'cli-grok', respond: () => new AiError('timeout', { timeoutSeconds: 120 }) });
		const readingTexts = Array.from({ length: 6 }, () => 'かな'.repeat(100));
		const { jobId, input } = jobInput('reading', readingTexts);
		await harness.runner.start(jobId, 'reading', input, undefined, harness.listener);
		await flush(8);
		// 1600 → 800 → 600 (floor), then the timeout is final.
		expect(harness.calls).toHaveLength(3);
		expect(harness.final()).toMatchObject({
			status: 'failed',
			error: { code: 'timeout', timeoutSeconds: 120 },
			attempts: { splits: 2 }
		});
		expect(await harness.store.get(jobId)).toMatchObject({ cliPromptChars: 600, attempts: { splits: 2 } });
	});

	test('fails with the timeout after three splits', async () => {
		const harness = setup({ kind: 'cli-codex', respond: () => new AiError('timeout', { timeoutSeconds: 120 }) });
		const { jobId, input } = jobInput('translate', texts);
		await seed(harness, storedRecord('translate', texts, { status: 'incomplete', cliPromptChars: 20_000 }, harness.clock.now()));
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush(8);
		// 20000 → 10000 → 5000 → 2500: still above the floor, but out of splits.
		expect(harness.calls).toHaveLength(4);
		expect(harness.final()).toMatchObject({ status: 'failed', error: { code: 'timeout' }, attempts: { splits: 3 } });
		expect(await harness.store.get(jobId)).toMatchObject({ cliPromptChars: 2500, attempts: { splits: 3 } });
	});
});

// ---------------------------------------------------------------------------------------------
// Terminal states

describe('job runner terminal states', () => {
	test('omitted ids end the job incomplete, without re-requesting them', async () => {
		const harness = setup({
			respond: (call, index) => call.ids.includes(1) ? [] : echo(call, index)
		});
		const { jobId, input } = jobInput('translate', oneGroupEach(3));
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		expect(harness.calls).toHaveLength(3);
		expect(harness.final()).toMatchObject({
			status: 'incomplete',
			error: { code: 'incomplete' },
			completedGroups: 3,
			completedSegments: 2
		});
		expect(harness.final()?.results.map(item => item.id)).toEqual([0, 2]);
		expect((await harness.store.get(jobId))?.status).toBe('incomplete');
	});

	test('an auth error stops dispatch, and the in-flight group still checkpoints', async () => {
		const harness = setup({ maxConcurrency: 2, respond: () => 'hold' });
		const texts = oneGroupEach(3);
		const { jobId, input } = jobInput('translate', texts);
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		expect(harness.calls).toHaveLength(2);
		harness.calls[0].reject(new AiError('auth', { status: 401 }));
		await flush();
		expect(harness.calls).toHaveLength(2);
		expect(harness.final()).toBeUndefined();
		harness.calls[1].resolve(echo(harness.calls[1], 1) as unknown[]);
		await flush();
		expect(harness.progress().map(event => event.results.map(item => item.id))).toEqual([[1]]);
		expect(harness.final()).toMatchObject({ status: 'failed', error: { code: 'auth', status: 401 }, results: [{ id: 1 }] });
		const record = await harness.store.get(jobId);
		expect(record?.status).toBe('failed');
		expect(Object.keys(record!.results)).toEqual(['1']);
	});

	test('a resolveConnection failure fails the job before any request', async () => {
		const harness = setup();
		const runner = createJobRunner({
			store: harness.store,
			resolveConnection: async () => {
				throw new AiError('not-configured', { reason: 'disabled' });
			},
			execute: (() => Promise.reject(new Error('unexpected'))) as JobRunnerDeps['execute'],
			now: harness.clock.now,
			setTimeout: harness.clock.setTimeout,
			clearTimeout: harness.clock.clearTimeout
		});
		const { jobId, input } = jobInput('translate', ['hello']);
		await runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		expect(harness.final()).toMatchObject({ status: 'failed', error: { code: 'not-configured', reason: 'disabled' } });
	});

	test('cancel is terminal at once; a late result that cannot be aborted is still checkpointed', async () => {
		const harness = setup({ abortable: false, respond: () => 'hold' });
		const { jobId, input } = jobInput('translate', ['hello']);
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		expect(await harness.runner.cancel(jobId)).toBe(true);
		expect(harness.final()).toMatchObject({ status: 'cancelled' });
		const eventCount = harness.events.length;
		harness.calls[0].resolve([{ id: 0, text: 'late' }]);
		await flush();
		expect(harness.events).toHaveLength(eventCount);
		expect(await harness.store.get(jobId)).toMatchObject({ status: 'cancelled', results: { 0: 'late' } });
		// Continue remaining then skips it.
		const next = setup();
		await seed(next, (await harness.store.get(jobId))!);
		await next.runner.start(jobId, 'translate', input, undefined, next.listener);
		await flush();
		expect(next.calls).toHaveLength(0);
		expect(next.final()).toMatchObject({ status: 'completed', results: [{ id: 0, text: 'late' }] });
	});

	test('a late result after a newer job completed the record does not flip it back to cancelled', async () => {
		const harness = setup({ abortable: false, respond: (call, index) => index === 0 ? 'hold' : echo(call, index) });
		const { jobId, input } = jobInput('translate', ['hello']);
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		await harness.runner.cancel(jobId);
		await harness.runner.start(jobId, 'translate', input, undefined, () => undefined);
		await flush();
		expect(await harness.store.get(jobId)).toMatchObject({ status: 'completed', results: { 0: 'T:hello' } });
		harness.calls[0].resolve([{ id: 0, text: 'late' }]);
		await flush();
		expect(await harness.store.get(jobId)).toMatchObject({ status: 'completed', results: { 0: 'T:hello' } });
	});

	test('a late result after checkpoint-clear does not resurrect the removed record', async () => {
		const harness = setup({ abortable: false, respond: () => 'hold' });
		const { jobId, input } = jobInput('translate', ['hello']);
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		await harness.runner.cancel(jobId);
		await harness.store.remove(jobId);
		harness.calls[0].resolve([{ id: 0, text: 'late' }]);
		await flush();
		expect(await harness.store.get(jobId)).toBeUndefined();
	});

	test('a late result that lands in a newer live job is reported and counted', async () => {
		const harness = setup({ abortable: false, respond: () => 'hold' });
		const { jobId, input } = jobInput('translate', ['hello']);
		await harness.runner.start(jobId, 'translate', input, undefined, () => undefined);
		await flush();
		await harness.runner.cancel(jobId);
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		expect(harness.calls).toHaveLength(2);
		harness.calls[0].resolve([{ id: 0, text: 'late' }]);
		await flush();
		expect(harness.progress()).toEqual([expect.objectContaining({
			completedSegments: 1,
			totalSegments: 1,
			results: [{ id: 0, text: 'late' }]
		})]);
		// The newer job's own request for id 0 then adds nothing, and the count stays right.
		harness.calls[1].resolve([{ id: 0, text: 'T:hello' }]);
		await flush();
		expect(harness.progress().map(event => event.completedSegments)).toEqual([1, 1]);
		expect(harness.final()).toMatchObject({ status: 'completed', completedSegments: 1, results: [{ id: 0, text: 'late' }] });

		// The late result arrives while the newer job is still starting: it is handed to that job.
		const racing = setup({ abortable: false, respond: () => 'hold' });
		await racing.runner.start(jobId, 'translate', input, undefined, () => undefined);
		await flush();
		await racing.runner.cancel(jobId);
		const starting = racing.runner.start(jobId, 'translate', input, undefined, racing.listener);
		racing.calls[0].resolve([{ id: 0, text: 'late' }]);
		await starting;
		await flush();
		expect(racing.progress().flatMap(event => event.results)).toEqual([{ id: 0, text: 'late' }]);
		expect(racing.progress()[racing.progress().length - 1].completedSegments).toBe(1);
	});

	test('start, attach, and cancel during settle wait for the final record', async () => {
		for (const action of ['start', 'attach', 'cancel'] as const) {
			const harness = setup({ maxConcurrency: 1, respond: () => 'hold' });
			const { jobId, input } = jobInput('translate', oneGroupEach(2));
			await harness.runner.start(jobId, 'translate', input, undefined, () => undefined);
			await flush();
			// Storage is slow: every checkpoint from here on waits, the final one included.
			const open = closeGate(harness.area);
			harness.calls[0].resolve(echo(harness.calls[0], 0) as unknown[]);
			await flush();
			harness.calls[1].resolve(echo(harness.calls[1], 1) as unknown[]);
			await flush();
			// The job still owns its id while the final write is pending.
			expect(harness.runner.isActive(jobId)).toBe(true);
			const pending = action === 'start'
				? harness.runner.start(jobId, 'translate', input, undefined, harness.listener)
				: action === 'attach'
					? harness.runner.attach(jobId, harness.listener)
					: harness.runner.cancel(jobId);
			await flush();
			open();
			const result = await pending;
			await flush();
			// No group is requested again, and the completed record is not overwritten.
			expect(harness.calls).toHaveLength(2);
			expect(await harness.store.get(jobId)).toMatchObject({ status: 'completed' });
			expect(Object.keys((await harness.store.get(jobId))!.results)).toEqual(['0', '1']);
			if (action === 'cancel') {
				expect(result).toBe(false);
			} else {
				expect(harness.final()).toMatchObject({ status: 'completed', completedSegments: 2 });
				expect(harness.states().filter(state => state.status === 'running')).toHaveLength(action === 'start' ? 1 : 0);
			}
		}
	});

	test('cancel of a running record without a live job marks it cancelled', async () => {
		const harness = setup();
		const texts = ['hello'];
		const record = storedRecord('translate', texts, {}, harness.clock.now());
		await seed(harness, record, texts);
		expect(await harness.runner.cancel(record.id)).toBe(true);
		expect((await harness.store.get(record.id))?.status).toBe('cancelled');
		expect(await harness.runner.cancel(record.id)).toBe(false);
		expect(await harness.runner.resume(record.id)).toBe(false);
		expect(harness.calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------------------------
// Resume, attach, heartbeat

describe('job runner resume', () => {
	test('a running record with 2 of 4 groups done resumes exactly the missing ids', async () => {
		const harness = setup();
		const texts = oneGroupEach(4);
		const record = storedRecord('translate', texts, {
			results: { 0: 'zero', 1: 'one' },
			attempts: { requests: 2, retries: 1, splits: 0 },
			profileId: 'profile-2'
		}, harness.clock.now());
		await seed(harness, record, texts);
		expect(await harness.runner.resumeRunning()).toEqual({ resumed: [record.id], expired: [] });
		await flush();
		expect(harness.calls.map(call => call.ids)).toEqual([[2], [3]]);
		const stored = await harness.store.get(record.id);
		expect(stored?.status).toBe('completed');
		expect(Object.keys(stored!.results)).toEqual(['0', '1', '2', '3']);
		// A resume continues the run's attempts.
		expect(stored?.attempts).toEqual({ requests: 4, retries: 1, splits: 0 });
		expect(stored?.profileId).toBe('profile-2');
	});

	test('init never resumes terminal records and expires old running ones', async () => {
		const harness = setup();
		const texts = ['hello'];
		const now = harness.clock.now();
		const statuses = ['incomplete', 'failed', 'cancelled', 'completed'] as const;
		for (const [index, status] of statuses.entries()) {
			const own = [`${status}-${index}`];
			await seed(harness, storedRecord('translate', own, { status }, now), own);
		}
		const old = storedRecord('translate', texts, {
			updatedAt: now - RESUME_WINDOW_MS - 1,
			error: { code: 'network', retryable: true }
		}, now);
		await seed(harness, old, texts);
		expect(await harness.runner.resumeRunning()).toEqual({ resumed: [], expired: [old.id] });
		await flush();
		expect(harness.calls).toHaveLength(0);
		const expired = await harness.store.get(old.id);
		expect(expired?.status).toBe('incomplete');
		expect(expired?.error).toBeUndefined();
		for (const record of await harness.store.list()) {
			if (record.id !== old.id) expect(statuses).toContain(record.status);
		}
	});

	test('resume, attach, and init racing yield one job', async () => {
		const harness = setup({ respond: () => 'hold' });
		const texts = oneGroupEach(2);
		const record = storedRecord('translate', texts, {}, harness.clock.now());
		await seed(harness, record, texts);
		const [first, second, detach] = await Promise.all([
			harness.runner.resume(record.id),
			harness.runner.resume(record.id),
			harness.runner.attach(record.id, harness.listener),
			harness.runner.resumeRunning()
		]);
		await flush();
		expect(first).toBe(true);
		expect(second).toBe(true);
		expect(detach).toBeTypeOf('function');
		expect(harness.calls.map(call => call.ids)).toEqual([[0], [1]]);
		expect(harness.states().filter(state => state.status === 'running')).toHaveLength(1);
		harness.calls.forEach((call, index) => call.resolve(echo(call, index) as unknown[]));
		await flush();
		expect(harness.final()).toMatchObject({ status: 'completed', completedSegments: 2 });
	});

	test('a running record without its input ends incomplete instead of resuming', async () => {
		const harness = setup();
		const texts = ['hello'];
		const record = storedRecord('translate', texts, {}, harness.clock.now());
		await seed(harness, record);
		expect(await harness.runner.resume(record.id)).toBe(false);
		expect((await harness.store.get(record.id))?.status).toBe('incomplete');
		// An input whose hash does not match is not trusted either.
		const other = storedRecord('translate', ['other'], {}, harness.clock.now());
		await seed(harness, other, ['changed']);
		expect(await harness.runner.resume(other.id)).toBe(false);
		expect(harness.calls).toHaveLength(0);
	});

	test('start-job for a running record with no live job resumes it as it was', async () => {
		const harness = setup();
		const texts = oneGroupEach(2);
		const record = storedRecord('translate', texts, {
			results: { 0: 'zero' },
			attempts: { requests: 3, retries: 1, splits: 0 },
			profileId: 'stored'
		}, harness.clock.now());
		await seed(harness, record);
		const { input } = jobInput('translate', texts);
		await harness.runner.start(record.id, 'translate', input, 'other', harness.listener);
		await flush();
		expect(harness.calls.map(call => call.ids)).toEqual([[1]]);
		expect(await harness.store.get(record.id)).toMatchObject({
			status: 'completed',
			profileId: 'stored',
			attempts: { requests: 4, retries: 1 }
		});
		expect(await harness.store.getInput(record.id)).toEqual({ instruction: 'Translate.', segments: texts });
	});

	test('start-job for a live job attaches without duplicating work', async () => {
		const harness = setup({ respond: () => 'hold' });
		const { jobId, input } = jobInput('translate', ['hello']);
		const second: JobRunnerEvent[] = [];
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		await harness.runner.start(jobId, 'translate', input, undefined, event => second.push(event));
		expect(harness.calls).toHaveLength(1);
		expect(second).toEqual([expect.objectContaining({ type: 'job-state', status: 'running', totalGroups: 1 })]);
		harness.calls[0].resolve([{ id: 0, text: 'hola' }]);
		await flush();
		expect(second.map(event => event.type)).toEqual(['job-state', 'job-progress', 'job-state']);
		expect(second[2]).toMatchObject({ status: 'completed' });
	});

	test('attach replays a stored terminal record once, and a detached listener hears nothing more', async () => {
		const harness = setup({ respond: () => 'hold' });
		expect(await harness.runner.attach('job:translate:ns:missing', harness.listener)).toBeUndefined();

		const texts = ['', 'hello'];
		const done = storedRecord('translate', texts, { status: 'completed', results: { 1: 'hola' } }, harness.clock.now());
		await seed(harness, done, texts);
		await harness.runner.attach(done.id, harness.listener);
		expect(harness.events).toEqual([expect.objectContaining({
			type: 'job-state',
			status: 'completed',
			completedSegments: 2,
			totalSegments: 2,
			results: [{ id: 1, text: 'hola' }]
		})]);
		expect(await harness.runner.get(done.id)).toMatchObject({ status: 'completed' });

		const live = jobInput('translate', ['a']);
		const detached: JobRunnerEvent[] = [];
		await harness.runner.start(live.jobId, 'translate', live.input, undefined, harness.listener);
		const detach = await harness.runner.attach(live.jobId, event => detached.push(event));
		detach?.();
		await flush();
		harness.calls[0].resolve([{ id: 0, text: 'A' }]);
		await flush();
		expect(detached).toHaveLength(1);
		expect(harness.states()[harness.states().length - 1]).toMatchObject({ jobId: live.jobId, status: 'completed' });
	});

	test('the heartbeat refreshes updatedAt while the job runs, and stops after', async () => {
		const harness = setup({ respond: () => 'hold' });
		const { jobId, input } = jobInput('translate', ['hello']);
		const startedAt = harness.clock.now();
		await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
		await flush();
		expect((await harness.store.get(jobId))?.updatedAt).toBe(startedAt);
		await harness.clock.advance(20_000);
		expect((await harness.store.get(jobId))?.updatedAt).toBe(startedAt + 20_000);
		await harness.clock.advance(20_000);
		expect((await harness.store.get(jobId))?.updatedAt).toBe(startedAt + 40_000);
		harness.calls[0].resolve([{ id: 0, text: 'hola' }]);
		await flush();
		expect(harness.final()?.status).toBe('completed');
		expect(harness.clock.pending).toBe(0);
		expect(harness.area.values.has(aiJobInputStorageKey(jobId))).toBe(true);
	});

	test('a record that cannot fit the quota stops checkpointing without evicting other jobs, and the job completes', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			const harness = setup({ maxConcurrency: 1, respond: () => 'hold' });
			const texts = oneGroupEach(4);
			const { jobId, input } = jobInput('translate', texts);
			const siblings = Array.from({ length: 5 }, (_, index) => storedRecord(
				'translate',
				[`sibling-${index}`],
				{ status: 'completed', updatedAt: index },
				harness.clock.now()
			));
			for (const sibling of siblings) await seed(harness, sibling);
			const key = aiJobStorageKey(jobId);
			// The record stops fitting once it holds a result.
			harness.area.rejectSet = entries => {
				const value = entries[key] as AiJobRecord | undefined;
				return value && Object.keys(value.results).length > 0
					? new Error('Session storage quota bytes exceeded. Values were not stored.')
					: undefined;
			};
			await harness.runner.start(jobId, 'translate', input, undefined, harness.listener);
			await flush();
			harness.calls[0].resolve(echo(harness.calls[0], 0) as unknown[]);
			await flush();
			const attempts = () => harness.area.sets.filter(entry => entry === key).length;
			const afterRejection = attempts();
			// Neither heartbeats nor later checkpoints try to write the record again.
			await harness.clock.advance(60_000);
			for (let index = 1; index < 4; index += 1) {
				harness.calls[index].resolve(echo(harness.calls[index], index) as unknown[]);
				await flush();
			}
			expect(attempts()).toBe(afterRejection);
			expect(harness.progress().flatMap(event => event.results.map(item => item.id))).toEqual([0, 1, 2, 3]);
			expect(harness.final()).toMatchObject({ status: 'completed', completedSegments: 4 });
			// One sibling went for the single retry; the others stay.
			const ids = (await harness.store.list()).map(entry => entry.id);
			expect(siblings.filter(sibling => ids.includes(sibling.id))).toHaveLength(4);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0][0])).not.toContain(texts[0].slice(0, 20));
			// The stale `running` record is gone, so an attach cannot resume and bill it again.
			expect(await harness.store.get(jobId)).toBeUndefined();
			expect(await harness.runner.attach(jobId, () => undefined)).toBeUndefined();
			expect(harness.calls).toHaveLength(4);
		} finally {
			warn.mockRestore();
		}
	});
});
