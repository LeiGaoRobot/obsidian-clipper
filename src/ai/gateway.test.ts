import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Settings } from '../types/types';
import { createMemoryStructuredOutputCache } from './capabilities';
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
const envelope = '{"prompt_1":"A summary"}';
const segmentInput = { instruction: 'Translate.', segments: [{ id: 0, text: 'Hola' }] };
const translationReply = '{"translations":[{"id":0,"text":"Hello"}]}';
const readingReply = '{"readings":[{"id":0,"tokens":[{"text":"Hola","reading":""}]}]}';
const textInput = { instruction: 'Explain.', content: 'word' };

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
		executeCli: vi.fn(async () => '{"prompt_1":"From CLI"}'),
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
	test('runs an API task and returns the contract output', async () => {
		const { deps, port } = setup();
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();

		expect(port.posted[0]).toMatchObject({ type: 'progress', jobId: 'job-1', phase: 'started' });
		expect(port.last()).toEqual({
			type: 'result',
			jobId: 'job-1',
			output: { prompt_1: 'A summary' },
			connectionKind: 'openai-compatible'
		});
		expect(deps.executeApi).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'openai-compatible',
				baseUrl: 'https://api.openai.com/v1/chat/completions',
				model: 'gpt-a',
				credential: 'sk-test',
				messages: expect.objectContaining({ user: expect.stringContaining('Page text') }),
				structured: expect.objectContaining({ mode: 'json_schema', name: 'interpret_responses' }),
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

	test('rejects a reply that breaks the contract', async () => {
		const { port } = setup({ executeApi: vi.fn(async () => 'no json here') });
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();
		expect(port.last()).toMatchObject({
			type: 'error',
			error: { code: 'bad-response', connectionId: 'provider-openai', detail: expect.stringContaining('no json here') }
		});
	});

	test('returns text tasks without structured output', async () => {
		const { deps, port } = setup({ executeApi: vi.fn(async () => ' Revised. ') });
		port.send({ type: 'start', jobId: 'job-1', task: 'edit', input: { instruction: 'Fix it.', content: 'draft' } });
		await flush();
		expect(port.last()).toMatchObject({ type: 'result', output: 'Revised.' });
		const [call] = (deps.executeApi as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call.messages).toEqual({ system: expect.stringContaining('Fix it.'), user: 'draft' });
		expect(call).not.toHaveProperty('structured');
	});

	test('retries once without structured output when the provider rejects it, and remembers', async () => {
		const executeApi = vi.fn()
			.mockRejectedValueOnce(new AiError('provider-error', { status: 400, detail: "Unknown parameter 'response_format'" }))
			.mockResolvedValue(envelope);
		const structuredOutput = createMemoryStructuredOutputCache();
		const { port } = setup({ executeApi, structuredOutput });
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();

		expect(port.last()).toMatchObject({ type: 'result', output: { prompt_1: 'A summary' } });
		expect(executeApi.mock.calls[0][0].structured).toMatchObject({ mode: 'json_schema' });
		expect(executeApi.mock.calls[1][0]).not.toHaveProperty('structured');
		expect(await structuredOutput.get('provider-openai', 'https://api.openai.com/v1/chat/completions')).toBe('none');

		port.send({ type: 'start', jobId: 'job-2', task: 'interpret', input });
		await flush();
		expect(executeApi).toHaveBeenCalledTimes(3);
		expect(executeApi.mock.calls[2][0]).not.toHaveProperty('structured');
	});

	test('does not remember the downgrade when the retry without structured output also fails', async () => {
		const executeApi = vi.fn()
			.mockRejectedValueOnce(new AiError('provider-error', { status: 400, detail: 'Invalid image format' }))
			.mockRejectedValueOnce(new AiError('provider-error', { status: 400, detail: 'Invalid image format' }));
		const structuredOutput = createMemoryStructuredOutputCache();
		const { port } = setup({ executeApi, structuredOutput });
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();

		expect(executeApi).toHaveBeenCalledTimes(2);
		expect(port.last()).toMatchObject({ type: 'error', error: { status: 400 } });
		expect(await structuredOutput.get('provider-openai', 'https://api.openai.com/v1/chat/completions')).toBeUndefined();
	});

	test('does not retry other 400s', async () => {
		const executeApi = vi.fn().mockRejectedValue(new AiError('provider-error', { status: 400, detail: 'context too long' }));
		const { port } = setup({ executeApi });
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();
		expect(executeApi).toHaveBeenCalledTimes(1);
		expect(port.last()).toMatchObject({ type: 'error', error: { status: 400 } });
	});

	test('rejects an input that does not match its task', async () => {
		const { deps, port } = setup();
		port.send({ type: 'start', jobId: 'job-1', task: 'translate', input });
		await flush();
		expect(port.last()).toMatchObject({ type: 'error', jobId: 'job-1', error: { code: 'provider-error' } });
		expect(deps.executeApi).not.toHaveBeenCalled();
	});

	test('routes CLI profiles to the Native Host and forwards heartbeats', async () => {
		const executeCli = vi.fn(async (_call: unknown, options: { onHeartbeat?: (elapsedMs: number) => void }) => {
			options.onHeartbeat?.(10_000);
			return '{"prompt_1":"From CLI"}';
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
			{
				kind: 'cli-codex',
				model: 'gpt-5-codex',
				effort: 'high',
				prompt: expect.stringContaining('Page text'),
				outputSchema: expect.objectContaining({ required: ['prompt_1'] })
			},
			expect.objectContaining({ connectionId: 'legacy-cli-codex' })
		);
		expect(port.posted.map(message => message.type === 'progress' ? message.phase : message.type))
			.toEqual(['started', 'heartbeat', 'result']);
		expect(port.last()).toMatchObject({ output: { prompt_1: 'From CLI' }, connectionKind: 'cli-codex' });
	});

	test('retries a Codex CLI that does not know --output-schema without it, and remembers', async () => {
		const executeCli = vi.fn()
			.mockRejectedValueOnce(new AiError('provider-error', {
				nativeCode: 'cli-failed',
				detail: "codex CLI failed: error: unexpected argument '--output-schema' found"
			}))
			.mockResolvedValue('{"prompt_1":"From CLI"}');
		const structuredOutput = createMemoryStructuredOutputCache();
		const { port } = setup(
			{ executeCli: executeCli as unknown as AiGatewayDeps['executeCli'], structuredOutput },
			v1Settings({ interpreterExecutionMode: 'codex' } as Partial<Settings>)
		);
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();

		expect(executeCli.mock.calls[0][0]).toHaveProperty('outputSchema');
		expect(executeCli.mock.calls[1][0]).not.toHaveProperty('outputSchema');
		expect(port.last()).toMatchObject({ type: 'result', output: { prompt_1: 'From CLI' } });
		expect(await structuredOutput.get('legacy-cli-codex', undefined)).toBe('none');
	});

	test('sends Grok prompt rules only, without an output schema', async () => {
		const executeCli = vi.fn(async () => 'Here you go: {"prompt_1":"From Grok"}');
		const { port } = setup(
			{ executeCli: executeCli as unknown as AiGatewayDeps['executeCli'] },
			v1Settings({ interpreterExecutionMode: 'grok' } as Partial<Settings>)
		);
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();
		expect((executeCli.mock.calls[0] as unknown[])[0]).not.toHaveProperty('outputSchema');
		expect(port.last()).toMatchObject({ output: { prompt_1: 'From Grok' }, connectionKind: 'cli-grok' });
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
		port.send({ type: 'start', jobId: 'job-1', task: 'translate', input: segmentInput });
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
		port.send({ type: 'start', jobId: 'job-1', task: 'explain', input: textInput });
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
		port.send({ type: 'start', jobId: 'job-1', task: 'translate', input: segmentInput });
		await flush();
		port.disconnect();
		expect(seenSignal?.aborted).toBe(false);

		pending.resolve(translationReply);
		await flush();
		const second = new FakePort();
		gateway.handlePort(second);
		second.send({ type: 'attach', jobId: 'job-1' });
		expect(second.last()).toMatchObject({ type: 'result', jobId: 'job-1', output: [{ id: 0, text: 'Hello' }] });
	});

	test('attach to a running job subscribes to its outcome', async () => {
		const pending = deferred<string>();
		const { gateway, port } = setup({ executeApi: vi.fn(() => pending.promise) });
		port.send({ type: 'start', jobId: 'job-1', task: 'reading', input: segmentInput });
		await flush();
		const second = new FakePort();
		gateway.handlePort(second);
		second.send({ type: 'attach', jobId: 'job-1' });
		expect(second.last()).toMatchObject({ type: 'progress', phase: 'started' });

		pending.resolve(readingReply);
		await flush();
		expect(port.last()).toMatchObject({ type: 'result' });
		expect(second.last()).toMatchObject({ type: 'result' });
	});

	test('pings the runtime while a job is unfinished and stops afterwards', async () => {
		vi.useFakeTimers();
		const keepAlive = vi.fn();
		const pending = deferred<string>();
		const { port } = setup({ keepAlive, keepAliveIntervalMs: 1000, executeApi: vi.fn(() => pending.promise) });
		port.send({ type: 'start', jobId: 'job-1', task: 'translate', input: segmentInput });
		port.disconnect();
		await vi.advanceTimersByTimeAsync(3500);
		expect(keepAlive).toHaveBeenCalledTimes(3);

		pending.resolve(translationReply);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5000);
		expect(keepAlive).toHaveBeenCalledTimes(3);
	});

	test('sends attach progress only to the attaching port', async () => {
		const pending = deferred<string>();
		const { gateway, port } = setup({ executeApi: vi.fn(() => pending.promise) });
		port.send({ type: 'start', jobId: 'job-1', task: 'reading', input: segmentInput });
		await flush();
		const before = port.posted.length;
		const second = new FakePort();
		gateway.handlePort(second);
		second.send({ type: 'attach', jobId: 'job-1' });
		expect(port.posted).toHaveLength(before);
		expect(second.posted).toEqual([expect.objectContaining({ type: 'progress', phase: 'started' })]);
	});

	test('passes only contract fields to adapters', async () => {
		const { deps, port } = setup();
		port.send({
			type: 'start',
			jobId: 'job-1',
			task: 'interpret',
			input: { context: 'Page text', prompts: [{ key: 'prompt_1', prompt: 'Summarize', filters: '|upper', extra: 'x' }], maxTokens: 900 }
		});
		await flush();
		const [call] = (deps.executeApi as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call.maxTokens).toBe(900);
		expect(JSON.stringify(call.messages)).not.toMatch(/upper|extra/);
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
