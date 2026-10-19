import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Settings } from '../types/types';
import { AiError } from './errors';
import { createAiGateway, type AiGatewayDeps, type AiPortLike } from './gateway';
import type { AiGatewayMessage } from './protocol';

function v1Settings(overrides: Partial<Settings> = {}): Settings {
	return {
		interpreterEnabled: true,
		interpreterExecutionMode: 'api',
		interpreterModel: 'model-a',
		providers: [
			{ id: 'provider-openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1/chat/completions', apiKey: 'sk-test', apiKeyRequired: true }
		],
		models: [
			{ id: 'model-a', providerId: 'provider-openai', providerModelId: 'gpt-a', name: 'A', enabled: true },
			{ id: 'model-b', providerId: 'provider-openai', providerModelId: 'gpt-b', name: 'B', enabled: true }
		],
		readerSettings: {},
		...overrides
	} as Settings;
}

class FakePort implements AiPortLike {
	name: string;
	posted: AiGatewayMessage[] = [];
	private messageListeners: Array<(message: unknown) => void> = [];
	private disconnectListeners: Array<() => void> = [];
	constructor(name = 'ai') {
		this.name = name;
	}
	postMessage(message: unknown) {
		this.posted.push(message as AiGatewayMessage);
	}
	onMessage = { addListener: (listener: (message: unknown) => void) => { this.messageListeners.push(listener); } };
	onDisconnect = { addListener: (listener: () => void) => { this.disconnectListeners.push(listener); } };
	send(message: unknown) {
		this.messageListeners.forEach(listener => listener(message));
	}
	disconnect() {
		this.disconnectListeners.forEach(listener => listener());
	}
	last() {
		return this.posted[this.posted.length - 1];
	}
}

const input = { context: 'Page text', prompts: [{ key: 'prompt_1', prompt: 'Summarize' }] };
const envelope = '{"prompts_responses":{"prompt_1":"A summary"}}';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function setup(overrides: Partial<AiGatewayDeps> = {}, settings = v1Settings()) {
	const deps: AiGatewayDeps = {
		loadSettings: async () => settings,
		nativeMessaging: () => 'port',
		app: () => ({ name: 'PagePick', homepageUrl: 'https://example.com' }),
		executeApi: vi.fn(async () => envelope),
		executeCli: vi.fn(async () => ({ prompt_1: 'From CLI' })),
		...overrides
	};
	const gateway = createAiGateway(deps);
	const port = new FakePort();
	gateway.handlePort(port);
	return { deps, gateway, port };
}

async function flush() {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
	await new Promise(resolve => setTimeout(resolve, 0));
}

afterEach(() => {
	vi.useRealTimers();
});

describe('AI gateway', () => {
	test('runs an API task and returns responses by prompt key', async () => {
		const { deps, port } = setup();
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();

		expect(port.posted[0]).toMatchObject({ type: 'progress', jobId: 'job-1', phase: 'started' });
		expect(port.last()).toEqual({
			type: 'result',
			jobId: 'job-1',
			responses: { prompt_1: 'A summary' },
			connectionKind: 'openai-compatible'
		});
		expect(deps.executeApi).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'openai-compatible',
				baseUrl: 'https://api.openai.com/v1/chat/completions',
				model: 'gpt-a',
				credential: 'sk-test',
				context: 'Page text',
				app: { name: 'PagePick', homepageUrl: 'https://example.com' }
			}),
			expect.objectContaining({ connectionId: 'provider-openai' })
		);
	});

	test('an explicit profile beats task routing', async () => {
		const { deps, port } = setup();
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', profileId: 'model-b', input });
		await flush();
		expect(deps.executeApi).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-b' }), expect.anything());
	});

	test('reports configuration problems as typed errors', async () => {
		const { deps, port } = setup({}, v1Settings({ interpreterEnabled: false }));
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();
		expect(port.last()).toMatchObject({ type: 'error', jobId: 'job-1', error: { code: 'not-configured', reason: 'disabled' } });
		expect(deps.executeApi).not.toHaveBeenCalled();
	});

	test('serializes adapter errors', async () => {
		const { port } = setup({
			executeApi: vi.fn(async () => {
				throw new AiError('rate-limited', { status: 429, connectionId: 'provider-openai', detail: 'slow down' });
			})
		});
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();
		expect(port.last()).toEqual({
			type: 'error',
			jobId: 'job-1',
			error: { code: 'rate-limited', retryable: true, status: 429, connectionId: 'provider-openai', detail: 'slow down' }
		});
	});

	test('rejects a reply with no envelope as a bad response', async () => {
		const { port } = setup({ executeApi: vi.fn(async () => 'no json here') });
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();
		expect(port.last()).toMatchObject({ type: 'error', error: { code: 'bad-response', detail: 'no json here' } });
	});

	test('routes CLI profiles to the Native Host and forwards heartbeats', async () => {
		const executeCli = vi.fn(async (_call: unknown, options: { onHeartbeat?: (elapsedMs: number) => void }) => {
			options.onHeartbeat?.(10_000);
			return { prompt_1: 'From CLI' };
		});
		const { port } = setup(
			{ executeCli: executeCli as unknown as AiGatewayDeps['executeCli'] },
			v1Settings({
				interpreterExecutionMode: 'codex',
				interpreterCodexModel: 'gpt-5-codex',
				interpreterCodexReasoningEffort: 'high'
			} as Partial<Settings>)
		);
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();

		expect(executeCli).toHaveBeenCalledWith(
			{ kind: 'cli-codex', model: 'gpt-5-codex', effort: 'high', context: 'Page text', prompts: input.prompts },
			expect.objectContaining({ connectionId: 'legacy-cli-codex' })
		);
		expect(port.posted.map(message => message.type === 'progress' ? message.phase : message.type))
			.toEqual(['started', 'heartbeat', 'result']);
		expect(port.last()).toMatchObject({ responses: { prompt_1: 'From CLI' }, connectionKind: 'cli-codex' });
	});

	test('reports CLI profiles as unsupported without Native Messaging', async () => {
		const { port } = setup(
			{ nativeMessaging: () => 'none' },
			v1Settings({ interpreterExecutionMode: 'grok' } as Partial<Settings>)
		);
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();
		expect(port.last()).toMatchObject({ type: 'error', error: { code: 'host-unsupported' } });
	});

	test('throttles receiving progress', async () => {
		let time = 0;
		const executeApi = vi.fn(async (_call: unknown, options: { onReceive?: (chars: number) => void }) => {
			for (const [at, chars] of [[100, 10], [200, 20], [700, 30], [800, 40], [1300, 50]]) {
				time = at;
				options.onReceive?.(chars);
			}
			return envelope;
		});
		const { port } = setup({ now: () => time, executeApi: executeApi as unknown as AiGatewayDeps['executeApi'] });
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();
		expect(port.posted.filter(message => message.type === 'progress' && message.phase === 'receiving')
			.map(message => message.type === 'progress' ? message.receivedChars : undefined)).toEqual([10, 30, 50]);
	});

	test('cancel aborts the running job', async () => {
		let seenSignal: AbortSignal | undefined;
		const pending = deferred<string>();
		const executeApi = vi.fn(async (_call: unknown, options: { signal?: AbortSignal }) => {
			seenSignal = options.signal;
			options.signal?.addEventListener('abort', () => pending.reject(new DOMException('Aborted', 'AbortError')));
			return pending.promise;
		});
		const { gateway, port } = setup({ executeApi: executeApi as unknown as AiGatewayDeps['executeApi'] });
		port.send({ type: 'start', jobId: 'job-1', task: 'translate', input });
		await flush();
		expect(gateway.activeJobIds()).toEqual(['job-1']);

		port.send({ type: 'cancel', jobId: 'job-1' });
		await flush();
		expect(seenSignal?.aborted).toBe(true);
		expect(port.last()).toMatchObject({ type: 'error', jobId: 'job-1', error: { code: 'cancelled' } });
		expect(gateway.activeJobIds()).toEqual([]);
	});

	test('aborts interactive tasks when their last listener disconnects', async () => {
		let seenSignal: AbortSignal | undefined;
		const executeApi = vi.fn(async (_call: unknown, options: { signal?: AbortSignal }) => {
			seenSignal = options.signal;
			return new Promise<string>(() => undefined);
		});
		const { port } = setup({ executeApi: executeApi as unknown as AiGatewayDeps['executeApi'] });
		port.send({ type: 'start', jobId: 'job-1', task: 'explain', input });
		await flush();
		port.disconnect();
		expect(seenSignal?.aborted).toBe(true);
	});

	test('keeps batch tasks running after a disconnect and replays the outcome on attach', async () => {
		let seenSignal: AbortSignal | undefined;
		const pending = deferred<string>();
		const executeApi = vi.fn(async (_call: unknown, options: { signal?: AbortSignal }) => {
			seenSignal = options.signal;
			return pending.promise;
		});
		const { gateway, port } = setup({ executeApi: executeApi as unknown as AiGatewayDeps['executeApi'] });
		port.send({ type: 'start', jobId: 'job-1', task: 'translate', input });
		await flush();
		port.disconnect();
		expect(seenSignal?.aborted).toBe(false);

		pending.resolve(envelope);
		await flush();
		const second = new FakePort();
		gateway.handlePort(second);
		second.send({ type: 'attach', jobId: 'job-1' });
		expect(second.last()).toMatchObject({ type: 'result', jobId: 'job-1', responses: { prompt_1: 'A summary' } });
	});

	test('attach to a running job subscribes to its outcome', async () => {
		const pending = deferred<string>();
		const { gateway, port } = setup({ executeApi: vi.fn(() => pending.promise) });
		port.send({ type: 'start', jobId: 'job-1', task: 'reading', input });
		await flush();
		const second = new FakePort();
		gateway.handlePort(second);
		second.send({ type: 'attach', jobId: 'job-1' });
		expect(second.last()).toMatchObject({ type: 'progress', phase: 'started' });

		pending.resolve(envelope);
		await flush();
		expect(port.last()).toMatchObject({ type: 'result' });
		expect(second.last()).toMatchObject({ type: 'result' });
	});

	test('pings the runtime while a job is unfinished and stops afterwards', async () => {
		vi.useFakeTimers();
		const keepAlive = vi.fn();
		const pending = deferred<string>();
		const { port } = setup({ keepAlive, keepAliveIntervalMs: 1000, executeApi: vi.fn(() => pending.promise) });
		port.send({ type: 'start', jobId: 'job-1', task: 'translate', input });
		port.disconnect();
		await vi.advanceTimersByTimeAsync(3500);
		expect(keepAlive).toHaveBeenCalledTimes(3);

		pending.resolve(envelope);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5000);
		expect(keepAlive).toHaveBeenCalledTimes(3);
	});

	test('sends attach progress only to the attaching port', async () => {
		const pending = deferred<string>();
		const { gateway, port } = setup({ executeApi: vi.fn(() => pending.promise) });
		port.send({ type: 'start', jobId: 'job-1', task: 'reading', input });
		await flush();
		const before = port.posted.length;
		const second = new FakePort();
		gateway.handlePort(second);
		second.send({ type: 'attach', jobId: 'job-1' });
		expect(port.posted).toHaveLength(before);
		expect(second.posted).toEqual([expect.objectContaining({ type: 'progress', phase: 'started' })]);
	});

	test('passes only prompt keys and text to adapters', async () => {
		const { deps, port } = setup();
		port.send({
			type: 'start',
			jobId: 'job-1',
			task: 'interpret',
			input: { context: 'Page text', prompts: [{ key: 'prompt_1', prompt: 'Summarize', filters: '|upper', extra: 'x' }], maxTokens: 900 }
		});
		await flush();
		expect(deps.executeApi).toHaveBeenCalledWith(
			expect.objectContaining({ prompts: [{ key: 'prompt_1', prompt: 'Summarize' }], maxTokens: 900 }),
			expect.anything()
		);
	});

	test('forgets finished jobs after the retention window', async () => {
		vi.useFakeTimers();
		const { gateway, port } = setup({ retainMs: 1000 });
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await vi.runAllTicks();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(port.last()).toMatchObject({ type: 'result' });

		vi.advanceTimersByTime(1000);
		const second = new FakePort();
		gateway.handlePort(second);
		second.send({ type: 'attach', jobId: 'job-1' });
		expect(second.last()).toMatchObject({ type: 'error', error: { code: 'provider-error', retryable: true } });
		expect(gateway.activeJobIds()).toEqual([]);
	});

	test('rejects duplicate job IDs and invalid messages', async () => {
		const pending = deferred<string>();
		const { port } = setup({ executeApi: vi.fn(() => pending.promise) });
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		expect(port.last()).toMatchObject({ type: 'error', jobId: 'job-1', error: { code: 'provider-error' } });

		port.send({ type: 'start', jobId: 'job-2', task: 'unknown-task', input });
		expect(port.last()).toMatchObject({ type: 'error', jobId: 'job-2', error: { code: 'provider-error' } });
		port.send({ type: 'ping' });
		expect(port.last()).toMatchObject({ jobId: 'job-2' });
	});

	test('ignores ports with other names', () => {
		const gateway = createAiGateway({
			loadSettings: async () => v1Settings(),
			nativeMessaging: () => 'none',
			app: () => ({ name: 'PagePick', homepageUrl: 'https://example.com' })
		});
		const port = new FakePort('something-else');
		gateway.handlePort(port);
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		expect(port.posted).toEqual([]);
	});
});
