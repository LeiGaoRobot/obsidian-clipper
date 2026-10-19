import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Settings } from '../types/types';
import { createAiDiagnostics } from './diagnostics';
import { AiError } from './errors';
import { createAiGateway, type AiGatewayDeps, type AiPortLike } from './gateway';
import { hashSegments, transcriptJobId } from './job-identity';
import {
	AI_JOB_KEY_PREFIX,
	LEGACY_CHECKPOINT_KEY_PREFIX,
	createAiJobStore,
	type AiJobRecord,
	type StorageAreaLike
} from './job-store';
import { RESUME_WINDOW_MS } from './job-runner';
import type { AiGatewayMessage } from './protocol';
import { createConnectionStatusStore } from './settings';
import { deriveAiSettings } from './settings-view';
import type { AiSettingsView, NativeMessagingSupport } from './types';

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

function memoryArea(initial: Record<string, unknown> = {}): StorageAreaLike & { values: Map<string, unknown> } {
	const values = new Map(Object.entries(initial));
	return {
		values,
		async get(keys) {
			const wanted = keys === undefined || keys === null
				? Array.from(values.keys())
				: (Array.isArray(keys) ? keys : [keys]).filter(key => values.has(key));
			return Object.fromEntries(wanted.map(key => [key, JSON.parse(JSON.stringify(values.get(key)))]));
		},
		async set(entries) {
			Object.entries(entries).forEach(([key, value]) => values.set(key, JSON.parse(JSON.stringify(value))));
		},
		async remove(keys) {
			(Array.isArray(keys) ? keys : [keys]).forEach(key => values.delete(key));
		}
	};
}


// The gateway reads the v2 view; in derived mode it is built from v1 exactly like this.
function v1View(settings = v1Settings(), nativeMessaging: NativeMessagingSupport = 'port') {
	return deriveAiSettings(settings, { nativeMessaging });
}

function setup(
	overrides: Partial<AiGatewayDeps> = {},
	settings = v1Settings(),
	nativeMessaging: NativeMessagingSupport = 'port'
) {
	const deps: AiGatewayDeps = {
		loadAiSettings: async () => v1View(settings, nativeMessaging),
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
			output: { responses: { prompt_1: 'A summary' }, missing: [] },
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

	test('returns a partial interpret reply with its missing keys', async () => {
		const twoPrompts = { ...input, prompts: [...input.prompts, { key: 'prompt_2', prompt: 'Tags' }] };
		const { port } = setup();
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input: twoPrompts });
		await flush();

		expect(port.last()).toMatchObject({
			type: 'result',
			output: { responses: { prompt_1: 'A summary' }, missing: ['prompt_2'] }
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
		const local = memoryArea();
		const { port } = setup({ executeApi, connectionStatus: createConnectionStatusStore(local) });
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();

		expect(port.last()).toMatchObject({ type: 'result', output: { responses: { prompt_1: 'A summary' }, missing: [] } });
		expect(executeApi.mock.calls[0][0].structured).toMatchObject({ mode: 'json_schema' });
		expect(executeApi.mock.calls[1][0]).not.toHaveProperty('structured');
		// The downgrade is this device's connection status, not the Phase 3 cache.
		expect(local.values.get('ai_connection_status')).toEqual({ 'provider-openai': { structuredOutput: 'none' } });
		expect(local.values.has('ai_structured_output')).toBe(false);

		port.send({ type: 'start', jobId: 'job-2', task: 'interpret', input });
		await flush();
		expect(executeApi).toHaveBeenCalledTimes(3);
		expect(executeApi.mock.calls[2][0]).not.toHaveProperty('structured');
	});

	test('does not remember the downgrade when the retry without structured output also fails', async () => {
		const executeApi = vi.fn()
			.mockRejectedValueOnce(new AiError('provider-error', { status: 400, detail: 'Invalid image format' }))
			.mockRejectedValueOnce(new AiError('provider-error', { status: 400, detail: 'Invalid image format' }));
		const local = memoryArea();
		const { port } = setup({ executeApi, connectionStatus: createConnectionStatusStore(local) });
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();

		expect(executeApi).toHaveBeenCalledTimes(2);
		expect(port.last()).toMatchObject({ type: 'error', error: { status: 400 } });
		expect(local.values.has('ai_connection_status')).toBe(false);
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
		expect(port.last()).toMatchObject({ output: { responses: { prompt_1: 'From CLI' }, missing: [] }, connectionKind: 'cli-codex' });
	});

	test('retries a Codex CLI that does not know --output-schema without it, and remembers', async () => {
		const executeCli = vi.fn()
			.mockRejectedValueOnce(new AiError('provider-error', {
				nativeCode: 'cli-failed',
				detail: "codex CLI failed: error: unexpected argument '--output-schema' found"
			}))
			.mockResolvedValue('{"prompt_1":"From CLI"}');
		const connectionStatus = createConnectionStatusStore();
		const { port } = setup(
			{ executeCli: executeCli as unknown as AiGatewayDeps['executeCli'], connectionStatus },
			v1Settings({ interpreterExecutionMode: 'codex' } as Partial<Settings>)
		);
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();

		expect(executeCli.mock.calls[0][0]).toHaveProperty('outputSchema');
		expect(executeCli.mock.calls[1][0]).not.toHaveProperty('outputSchema');
		expect(port.last()).toMatchObject({ type: 'result', output: { responses: { prompt_1: 'From CLI' }, missing: [] } });
		expect(await connectionStatus.get('legacy-cli-codex')).toEqual({ structuredOutput: 'none' });
	});

	test('uses the effective structured mode: status override, then the connection, then the default', async () => {
		const deepseek = v1Settings({
			providers: [{ id: 'provider-openai', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1/chat/completions', apiKey: 'sk', apiKeyRequired: true }]
		} as Partial<Settings>);
		const run = async (view: AiSettingsView, status?: Record<string, unknown>) => {
			const executeApi = vi.fn(async () => envelope);
			const local = memoryArea(status ? { ai_connection_status: status } : {});
			const { port } = setup({ executeApi, loadAiSettings: async () => view, connectionStatus: createConnectionStatusStore(local) });
			port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
			await flush();
			const call = (executeApi.mock.calls[0] as unknown[])[0] as { structured?: { mode: string } };
			return call.structured?.mode ?? 'none';
		};
		const base = v1View(deepseek);
		const detected = { ...base, connections: base.connections.map(connection => ({ ...connection, structuredOutput: 'json_schema' as const })) };

		expect(await run(base)).toBe('json_object');
		expect(await run(detected)).toBe('json_schema');
		expect(await run(detected, { 'provider-openai': { structuredOutput: 'none' } })).toBe('none');
		expect(await run(base, { 'provider-openai': { state: 'ok', testedAt: 1, structuredOutput: 'json_schema' } })).toBe('json_schema');
	});

	test('records one redacted diagnostics entry per single call', async () => {
		const diagnostics = createAiDiagnostics();
		const executeApi = vi.fn()
			.mockRejectedValueOnce(new AiError('provider-error', { status: 400, detail: "Unknown parameter 'response_format'" }))
			.mockResolvedValueOnce(envelope)
			.mockRejectedValueOnce(new AiError('rate-limited', { status: 429, detail: 'slow down' }));
		const { port } = setup({ executeApi, diagnostics });
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();
		port.send({ type: 'start', jobId: 'job-2', task: 'edit', input: { instruction: 'Fix it.', content: 'secret draft' } });
		await flush();

		const entries = await diagnostics.list();
		expect(entries).toEqual([
			expect.objectContaining({
				task: 'interpret',
				kind: 'openai-compatible',
				connectionId: 'provider-openai',
				outcome: 'ok',
				structuredMode: 'json_schema',
				fallback: true
			}),
			expect.objectContaining({ task: 'edit', outcome: 'error', code: 'rate-limited', status: 429 })
		]);
		expect(JSON.stringify(entries)).not.toMatch(/secret draft|Page text|sk-test|job-1|job-2/);
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
		expect(port.last()).toMatchObject({ output: { responses: { prompt_1: 'From Grok' }, missing: [] }, connectionKind: 'cli-grok' });
	});

	test('reports CLI profiles as unsupported without Native Messaging', async () => {
		const { port } = setup(
			{},
			v1Settings({ interpreterExecutionMode: 'grok' } as Partial<Settings>),
			'none'
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
			loadAiSettings: async () => v1View(v1Settings(), 'none'),
			app: () => ({ name: 'PagePick', homepageUrl: 'https://example.com' })
		});
		const port = new FakePort('something-else');
		gateway.handlePort(port);
		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		expect(port.posted).toEqual([]);
	});
});

describe('AI gateway connection Test', () => {
	const listing = (ids: string[]) => vi.fn(async () => new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	}));

	test('posts test-steps then test-result, persists the status, and records diagnostics', async () => {
		const local = memoryArea();
		const diagnostics = createAiDiagnostics();
		const fetchImpl = listing(['gpt-a']);
		const { deps, port } = setup({
			fetchImpl: fetchImpl as unknown as typeof fetch,
			connectionStatus: createConnectionStatusStore(local),
			diagnostics,
			now: () => 1000
		});
		port.send({ type: 'test', jobId: 'test-1', connectionId: 'provider-openai' });
		await flush();

		expect(port.posted.map(message => message.type)).toEqual(['test-step', 'test-result']);
		expect(port.posted[0]).toEqual({ type: 'test-step', jobId: 'test-1', step: 'listing' });
		expect(port.last()).toEqual({
			type: 'test-result',
			jobId: 'test-1',
			result: {
				connectionId: 'provider-openai',
				state: 'ok',
				testedAt: 1000,
				billable: false,
				listedModels: ['gpt-a'],
				models: [
					{ profileId: 'model-a', model: 'gpt-a', listed: true },
					{ profileId: 'model-b', model: 'gpt-b', listed: false }
				]
			}
		});
		// The key is resolved here from the view; it never travels in a message.
		const [url, init] = (fetchImpl.mock.calls[0] as unknown) as [string, RequestInit];
		expect(url).toBe('https://api.openai.com/v1/models');
		expect(init.headers).toEqual({ Authorization: 'Bearer sk-test' });
		expect(JSON.stringify(port.posted)).not.toContain('sk-test');
		expect(deps.executeApi).not.toHaveBeenCalled();
		expect(local.values.get('ai_connection_status')).toEqual({
			'provider-openai': {
				state: 'ok',
				testedAt: 1000,
				models: [
					{ profileId: 'model-a', model: 'gpt-a', listed: true },
					{ profileId: 'model-b', model: 'gpt-b', listed: false }
				]
			}
		});
		expect(await diagnostics.list()).toEqual([{
			at: 1000,
			task: 'test',
			kind: 'openai-compatible',
			connectionId: 'provider-openai',
			durationMs: 0,
			outcome: 'ok'
		}]);
	});

	test('a failing Test persists the reason and a later Test overwrites the structured-output downgrade', async () => {
		const local = memoryArea({ ai_connection_status: { 'provider-openai': { structuredOutput: 'none' } } });
		const settings = v1Settings({
			providers: [{ id: 'provider-openai', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1/chat/completions', apiKey: 'sk-test', apiKeyRequired: true }]
		} as Partial<Settings>);
		const executeApi = vi.fn(async () => '{"ok":true}');
		const unauthorized = vi.fn(async () => new Response('{"error":"invalid key sk-test"}', { status: 401 }));
		const first = setup({
			executeApi,
			fetchImpl: unauthorized as unknown as typeof fetch,
			connectionStatus: createConnectionStatusStore(local),
			now: () => 5
		}, settings);
		first.port.send({ type: 'test', jobId: 'test-1', connectionId: 'provider-openai' });
		await flush();
		expect(first.port.last()).toMatchObject({
			type: 'test-result',
			result: { state: 'failing', billable: false, error: { code: 'auth', status: 401, detail: '{"error":"invalid key [redacted]"}' } }
		});
		expect(executeApi).not.toHaveBeenCalled();
		expect(local.values.get('ai_connection_status')).toEqual({
			'provider-openai': { state: 'failing', testedAt: 5, code: 'auth', status: 401, detail: '{"error":"invalid key [redacted]"}', structuredOutput: 'none' }
		});

		const second = setup({
			executeApi,
			fetchImpl: listing(['gpt-a', 'gpt-b']) as unknown as typeof fetch,
			connectionStatus: createConnectionStatusStore(local),
			now: () => 6
		}, settings);
		second.port.send({ type: 'test', jobId: 'test-2', connectionId: 'provider-openai' });
		await flush();
		expect(second.port.posted.map(message => message.type === 'test-step' ? message.step : message.type))
			.toEqual(['listing', 'structured', 'test-result']);
		expect(second.port.last()).toMatchObject({ result: { state: 'ok', billable: true, structuredOutput: 'json_schema' } });
		expect(local.values.get('ai_connection_status')).toMatchObject({
			'provider-openai': { state: 'ok', testedAt: 6, structuredOutput: 'json_schema' }
		});
	});

	test('a successful listing-only Test drops a structured-output downgrade, so the next run uses the default', async () => {
		const local = memoryArea({ ai_connection_status: { 'provider-openai': { structuredOutput: 'none' } } });
		const executeApi = vi.fn(async () => envelope);
		const { port } = setup({
			executeApi,
			fetchImpl: listing(['gpt-a', 'gpt-b']) as unknown as typeof fetch,
			connectionStatus: createConnectionStatusStore(local),
			now: () => 7
		});
		port.send({ type: 'test', jobId: 'test-1', connectionId: 'provider-openai' });
		await flush();
		expect(port.last()).toMatchObject({ type: 'test-result', result: { state: 'ok', billable: false } });
		expect(executeApi).not.toHaveBeenCalled();
		expect(local.values.get('ai_connection_status')).toEqual({
			'provider-openai': {
				state: 'ok',
				testedAt: 7,
				models: [
					{ profileId: 'model-a', model: 'gpt-a', listed: true },
					{ profileId: 'model-b', model: 'gpt-b', listed: true }
				]
			}
		});

		port.send({ type: 'start', jobId: 'job-1', task: 'interpret', input });
		await flush();
		expect((executeApi.mock.calls[0] as unknown[])[0]).toMatchObject({ structured: { mode: 'json_schema' } });
	});

	test('is cancellable and then writes no status', async () => {
		const local = memoryArea();
		const diagnostics = createAiDiagnostics();
		let release!: () => void;
		const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
			release = () => reject(new DOMException('Aborted', 'AbortError'));
			init.signal?.addEventListener('abort', () => release());
		}));
		const { gateway, port } = setup({
			fetchImpl: fetchImpl as unknown as typeof fetch,
			connectionStatus: createConnectionStatusStore(local),
			diagnostics
		});
		port.send({ type: 'test', jobId: 'test-1', connectionId: 'provider-openai' });
		await flush();
		expect(gateway.activeJobIds()).toEqual(['test-1']);

		port.send({ type: 'cancel', jobId: 'test-1' });
		await flush();
		expect(port.last()).toMatchObject({ type: 'error', jobId: 'test-1', error: { code: 'cancelled' } });
		expect(local.values.has('ai_connection_status')).toBe(false);
		expect(gateway.activeJobIds()).toEqual([]);
		expect(await diagnostics.list()).toEqual([expect.objectContaining({ task: 'test', outcome: 'cancelled', code: 'cancelled' })]);
	});

	test('a missing connection answers not-configured without a request', async () => {
		const fetchImpl = vi.fn();
		const { deps, port } = setup({ fetchImpl: fetchImpl as unknown as typeof fetch });
		port.send({ type: 'test', jobId: 'test-1', connectionId: 'deleted' });
		await flush();
		expect(port.last()).toMatchObject({
			type: 'error',
			jobId: 'test-1',
			error: { code: 'not-configured', reason: 'connection-missing', connectionId: 'deleted' }
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(deps.executeApi).not.toHaveBeenCalled();
	});

	test('a CLI Test runs the health check and one exec per enabled profile', async () => {
		const checkCliHealth = vi.fn(async () => 'port' as const);
		const executeCli = vi.fn(async () => 'OK');
		const { port } = setup(
			{ checkCliHealth, executeCli: executeCli as unknown as AiGatewayDeps['executeCli'] },
			v1Settings({ interpreterExecutionMode: 'codex', interpreterCodexModel: 'gpt-5-codex', interpreterCodexReasoningEffort: 'high' } as Partial<Settings>)
		);
		port.send({ type: 'test', jobId: 'test-1', connectionId: 'legacy-cli-codex' });
		await flush();
		expect(checkCliHealth).toHaveBeenCalledWith('cli-codex', expect.objectContaining({ connectionId: 'legacy-cli-codex' }));
		expect(executeCli).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'cli-codex', model: 'gpt-5-codex', effort: 'high' }),
			expect.objectContaining({ connectionId: 'legacy-cli-codex' })
		);
		expect(port.last()).toMatchObject({ type: 'test-result', result: { state: 'ok', billable: true, transport: 'port' } });
	});

	test('status-clear removes only the named entry and answers status-cleared', async () => {
		const local = memoryArea({ ai_connection_status: { a: { state: 'ok', testedAt: 1 }, b: { structuredOutput: 'none' } } });
		const { port } = setup({ connectionStatus: createConnectionStatusStore(local) });
		port.send({ type: 'status-clear', jobId: 'status-1', connectionId: 'a' });
		port.send({ type: 'status-clear', jobId: 'status-2', connectionId: 'missing' });
		await flush();
		expect(port.posted).toEqual([
			{ type: 'status-cleared', jobId: 'status-1', connectionId: 'a' },
			{ type: 'status-cleared', jobId: 'status-2', connectionId: 'missing' }
		]);
		expect(local.values.get('ai_connection_status')).toEqual({ b: { structuredOutput: 'none' } });

		port.send({ type: 'status-clear', jobId: 'status-3' });
		await flush();
		expect(port.last()).toMatchObject({ type: 'error', jobId: 'status-3' });
	});

	test('a status-clear and a concurrent Test result for another connection both land', async () => {
		const local = memoryArea({ ai_connection_status: { other: { state: 'ok', testedAt: 1 } } });
		// Each storage call yields, so unserialized read-modify-writes would interleave.
		const slow: StorageAreaLike = {
			get: async keys => {
				await new Promise(resolve => setTimeout(resolve, 0));
				return local.get(keys);
			},
			set: async entries => {
				await new Promise(resolve => setTimeout(resolve, 0));
				return local.set(entries);
			},
			remove: keys => local.remove(keys)
		};
		const { port } = setup({
			fetchImpl: listing(['gpt-a']) as unknown as typeof fetch,
			connectionStatus: createConnectionStatusStore(slow),
			now: () => 9
		});
		port.send({ type: 'test', jobId: 'test-1', connectionId: 'provider-openai' });
		port.send({ type: 'status-clear', jobId: 'status-1', connectionId: 'other' });
		for (let index = 0; index < 4; index += 1) await flush();
		expect(port.posted.map(message => message.type)).toEqual(expect.arrayContaining(['status-cleared', 'test-result']));
		expect(local.values.get('ai_connection_status')).toEqual({
			'provider-openai': expect.objectContaining({ state: 'ok', testedAt: 9 })
		});
	});

	test('init removes the Phase 3 structured-output cache', async () => {
		const local = memoryArea({ ai_structured_output: { 'provider-openai': { baseUrl: '', mode: 'none' } }, other: 1 });
		const { gateway } = setup({ connectionStatus: createConnectionStatusStore(local) });
		await gateway.init();
		expect(local.values.has('ai_structured_output')).toBe(false);
		expect(local.values.get('other')).toBe(1);
	});
});

describe('AI gateway durable jobs', () => {
	const identity = { namespace: 'transcript-translation', scope: 'video-1' };
	const texts = ['Hola', 'Adiós'];
	const jobSegments = texts.map((text, id) => ({ id, text }));
	const jobId = transcriptJobId('translate', identity, jobSegments);
	const jobInput = { instruction: 'Translate.', segments: jobSegments, identity };
	const startJob = { type: 'start-job', jobId, task: 'translate', input: jobInput };
	const allTranslations = JSON.stringify({ translations: [{ id: 0, text: 'Hello' }, { id: 1, text: 'Goodbye' }] });

	function storedRecord(overrides: Partial<AiJobRecord> = {}): AiJobRecord {
		return {
			v: 1,
			id: jobId,
			task: 'translate',
			identity,
			segmentCount: texts.length,
			segmentHash: hashSegments(identity.scope, texts),
			status: 'running',
			results: {},
			attempts: { requests: 0, retries: 0, splits: 0 },
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...overrides
		};
	}

	function jobSetup(overrides: Partial<AiGatewayDeps> = {}, area = memoryArea()) {
		const store = createAiJobStore(area);
		const result = setup({ jobStore: store, executeApi: vi.fn(async () => allTranslations), ...overrides });
		return { ...result, store, area };
	}

	async function seed(store: ReturnType<typeof createAiJobStore>, record: AiJobRecord, withInput = true) {
		if (withInput) await store.putInput(record.id, { instruction: 'Translate.', segments: texts });
		await store.put(record);
	}

	async function settle() {
		for (let index = 0; index < 10; index += 1) await flush();
	}

	function pendingApi() {
		const calls: Array<{
			request: { messages: unknown };
			signal?: AbortSignal;
			resolve: (text: string) => void;
			reject: (error: unknown) => void;
		}> = [];
		const executeApi = vi.fn((request: { messages: unknown }, options: { signal?: AbortSignal }) => new Promise<string>((resolve, reject) => {
			calls.push({ request, signal: options.signal, resolve, reject });
			options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
		}));
		return { calls, executeApi: executeApi as unknown as AiGatewayDeps['executeApi'] };
	}

	const types = (port: FakePort) => port.posted.map(message => (
		message.type === 'job-state' ? `job-state:${message.status}` : message.type
	));

	test('start-job runs the transcript as one checkpointed job and streams snapshot, progress, and final state', async () => {
		const { deps, port, store } = jobSetup();
		port.send(startJob);
		await settle();

		expect(types(port)).toEqual(['job-state:running', 'job-progress', 'job-state:completed']);
		expect(port.posted[1]).toMatchObject({ type: 'job-progress', jobId, results: [{ id: 0, text: 'Hello' }, { id: 1, text: 'Goodbye' }] });
		expect(port.last()).toMatchObject({
			type: 'job-state',
			jobId,
			status: 'completed',
			completedSegments: 2,
			totalSegments: 2,
			results: [{ id: 0, text: 'Hello' }, { id: 1, text: 'Goodbye' }],
			attempts: { requests: 1, retries: 0, splits: 0 }
		});
		expect(deps.executeApi).toHaveBeenCalledTimes(1);
		expect(deps.executeApi).toHaveBeenCalledWith(
			expect.objectContaining({ model: 'gpt-a', credential: 'sk-test', maxTokens: expect.any(Number) }),
			expect.objectContaining({ connectionId: 'provider-openai' })
		);
		expect(await store.get(jobId)).toMatchObject({ status: 'completed', results: { 0: 'Hello', 1: 'Goodbye' } });
	});

	test('start-job answers Invalid AI request when the id does not match the input', async () => {
		const { deps, port, store } = jobSetup();
		const otherId = transcriptJobId('translate', { ...identity, scope: 'video-2' }, jobSegments);
		port.send({ ...startJob, jobId: otherId });
		port.send({ ...startJob, task: 'reading' });
		await settle();

		expect(port.posted).toEqual([
			{ type: 'error', jobId: otherId, error: expect.objectContaining({ code: 'provider-error', detail: 'Invalid AI request.' }) },
			{ type: 'error', jobId, error: expect.objectContaining({ code: 'provider-error', detail: 'Invalid AI request.' }) }
		]);
		expect(deps.executeApi).not.toHaveBeenCalled();
		expect(await store.list()).toEqual([]);
	});

	test('a start-job for a running id attaches instead of starting again', async () => {
		const api = pendingApi();
		const { gateway, port } = jobSetup({ executeApi: api.executeApi });
		port.send(startJob);
		await settle();
		const second = new FakePort();
		gateway.handlePort(second);
		second.send(startJob);
		await settle();

		expect(api.executeApi).toHaveBeenCalledTimes(1);
		expect(types(second)).toEqual(['job-state:running']);

		api.calls[0].resolve(allTranslations);
		await settle();
		expect(port.last()).toMatchObject({ type: 'job-state', status: 'completed' });
		expect(second.last()).toMatchObject({ type: 'job-state', status: 'completed' });
	});

	test('attach to a live durable job replays a snapshot and forwards later events', async () => {
		const api = pendingApi();
		const { gateway, port } = jobSetup({ executeApi: api.executeApi });
		port.send(startJob);
		await settle();
		port.disconnect();
		const second = new FakePort();
		gateway.handlePort(second);
		second.send({ type: 'attach', jobId });
		await settle();
		expect(types(second)).toEqual(['job-state:running']);

		const before = port.posted.length;
		api.calls[0].resolve(allTranslations);
		await settle();
		expect(types(second)).toEqual(['job-state:running', 'job-progress', 'job-state:completed']);
		// The disconnected port's listener was detached.
		expect(port.posted).toHaveLength(before);
	});

	test('attach to a running record with no live job resumes only the missing segments', async () => {
		const { deps, port, store } = jobSetup();
		await seed(store, storedRecord({ results: { 0: 'Hello' } }));
		port.send({ type: 'attach', jobId });
		await settle();

		expect(deps.executeApi).toHaveBeenCalledTimes(1);
		const [call] = (deps.executeApi as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(JSON.stringify(call.messages)).toContain('Adiós');
		expect(JSON.stringify(call.messages)).not.toContain('Hola');
		expect(port.last()).toMatchObject({
			type: 'job-state',
			status: 'completed',
			results: [{ id: 0, text: 'Hello' }, { id: 1, text: 'Goodbye' }]
		});
	});

	test('attach to a finished durable job replays its terminal state from the store', async () => {
		const { deps, gateway, port, store } = jobSetup();
		port.send(startJob);
		await settle();
		expect(gateway.activeJobIds()).toEqual([]);

		// A fresh gateway stands for a restarted worker: nothing is in memory any more.
		const restarted = createAiGateway({ ...deps, jobStore: store });
		const second = new FakePort();
		restarted.handlePort(second);
		second.send({ type: 'attach', jobId });
		await settle();
		expect(second.posted).toEqual([expect.objectContaining({
			type: 'job-state',
			jobId,
			status: 'completed',
			completedSegments: 2,
			results: [{ id: 0, text: 'Hello' }, { id: 1, text: 'Goodbye' }]
		})]);
		expect(deps.executeApi).toHaveBeenCalledTimes(1);
	});

	test('attach to an unknown durable id reports that the job is no longer running', async () => {
		const { port } = jobSetup();
		port.send({ type: 'attach', jobId });
		await settle();
		expect(port.posted).toEqual([{
			type: 'error',
			jobId,
			error: expect.objectContaining({ code: 'provider-error', retryable: true, detail: 'The job is no longer running.' })
		}]);
	});

	test('attach with a job-shaped id falls back to a single-call job of that id', async () => {
		const pending = deferred<string>();
		const { gateway, port } = jobSetup({ executeApi: vi.fn(() => pending.promise) });
		port.send({ type: 'start', jobId, task: 'translate', input: segmentInput });
		await settle();
		const second = new FakePort();
		gateway.handlePort(second);
		second.send({ type: 'attach', jobId });
		await settle();
		expect(second.posted).toEqual([expect.objectContaining({ type: 'progress', phase: 'started' })]);
	});

	test('cancel stops a live durable job and aborts its request', async () => {
		const api = pendingApi();
		const { gateway, port, store } = jobSetup({ executeApi: api.executeApi });
		port.send(startJob);
		await settle();
		port.send({ type: 'cancel', jobId });
		await settle();

		expect(api.calls[0].signal?.aborted).toBe(true);
		expect(port.last()).toMatchObject({ type: 'job-state', status: 'cancelled', error: { code: 'cancelled' } });
		expect(await store.get(jobId)).toMatchObject({ status: 'cancelled' });
		expect(gateway.activeJobIds()).toEqual([]);
	});

	test('a cancel sent right after start-job cancels the job it started', async () => {
		const api = pendingApi();
		const { port, store } = jobSetup({ executeApi: api.executeApi });
		port.send(startJob);
		port.send({ type: 'cancel', jobId });
		await settle();

		expect(api.calls.every(call => call.signal?.aborted)).toBe(true);
		expect(port.last()).toMatchObject({ type: 'job-state', status: 'cancelled' });
		expect(await store.get(jobId)).toMatchObject({ status: 'cancelled' });
	});

	test('cancel of a running record with no live job marks it cancelled without a request', async () => {
		const { deps, port, store } = jobSetup();
		await seed(store, storedRecord({ results: { 0: 'Hello' } }));
		port.send({ type: 'cancel', jobId });
		await settle();

		expect(deps.executeApi).not.toHaveBeenCalled();
		expect(await store.get(jobId)).toMatchObject({ status: 'cancelled', results: { 0: 'Hello' } });
	});

	test('checkpoint-get returns the stored record and never executes, even for a running record', async () => {
		const { deps, gateway, port, store } = jobSetup();
		await seed(store, storedRecord({ results: { 0: 'Hello' } }));
		port.send({ type: 'checkpoint-get', requestId: 'request-1', jobId });
		await settle();

		expect(port.posted).toEqual([{
			type: 'checkpoint',
			requestId: 'request-1',
			jobId,
			ok: true,
			record: { status: 'running', results: [{ id: 0, text: 'Hello' }], completedSegments: 1, totalSegments: 2 }
		}]);
		expect(deps.executeApi).not.toHaveBeenCalled();
		expect(gateway.activeJobIds()).toEqual([]);
		expect(await store.get(jobId)).toMatchObject({ status: 'running' });
	});

	test('checkpoint-get without a record answers ok without one', async () => {
		const { port } = jobSetup();
		port.send({ type: 'checkpoint-get', requestId: 'request-1', jobId });
		await settle();
		expect(port.posted).toEqual([{ type: 'checkpoint', requestId: 'request-1', jobId, ok: true }]);
	});

	describe('checkpoint-put', () => {
		const put = (results: unknown[], overrides: Record<string, unknown> = {}) => ({
			type: 'checkpoint-put',
			requestId: 'request-1',
			jobId,
			task: 'translate',
			identity,
			segmentCount: texts.length,
			segments: jobSegments,
			results,
			...overrides
		});

		test('writes a completed record and its source input when every segment has a result', async () => {
			const { deps, port, store } = jobSetup();
			port.send(put([{ id: 0, text: 'Hello' }, { id: 1, text: 'Goodbye' }]));
			await settle();

			expect(port.posted).toEqual([{ type: 'checkpoint', requestId: 'request-1', jobId, ok: true }]);
			expect(await store.get(jobId)).toMatchObject({
				status: 'completed',
				segmentHash: hashSegments(identity.scope, texts),
				results: { 0: 'Hello', 1: 'Goodbye' }
			});
			expect(await store.getInput(jobId)).toEqual({ instruction: '', segments: texts });
			expect(deps.executeApi).not.toHaveBeenCalled();
		});

		test('writes an incomplete record when a segment has no result', async () => {
			const { port, store } = jobSetup();
			port.send(put([{ id: 1, text: 'Goodbye' }]));
			await settle();
			expect(port.last()).toMatchObject({ type: 'checkpoint', ok: true });
			expect(await store.get(jobId)).toMatchObject({ status: 'incomplete', results: { 1: 'Goodbye' } });
		});

		test('counts empty-source segments as complete without a result', async () => {
			const readingIdentity = { namespace: 'japanese-readings', scope: 'shared' };
			const readingSegments = [{ id: 0, text: '雨' }, { id: 1, text: '' }];
			const readingId = transcriptJobId('reading', readingIdentity, readingSegments);
			const { port, store } = jobSetup();
			port.send(put([{ id: 0, tokens: [{ text: '雨', reading: 'あめ' }] }, { id: 1, tokens: [] }], {
				jobId: readingId,
				task: 'reading',
				identity: readingIdentity,
				segments: readingSegments
			}));
			await settle();

			expect(port.last()).toMatchObject({ type: 'checkpoint', jobId: readingId, ok: true });
			const record = await store.get(readingId);
			expect(record).toMatchObject({ status: 'completed', results: { 0: [{ text: '雨', reading: 'あめ' }] } });
			expect(record?.results).not.toHaveProperty('1');

			port.send({ type: 'checkpoint-get', requestId: 'request-2', jobId: readingId });
			await settle();
			expect(port.last()).toMatchObject({
				type: 'checkpoint',
				record: { status: 'completed', completedSegments: 2, totalSegments: 2 }
			});
		});

		test('is refused while that job runs, live or as a stored running record', async () => {
			const api = pendingApi();
			const { port, store } = jobSetup({ executeApi: api.executeApi });
			port.send(startJob);
			await settle();
			port.send(put([{ id: 0, text: 'Mine' }, { id: 1, text: 'Mine too' }]));
			await settle();
			expect(port.last()).toEqual({ type: 'checkpoint', requestId: 'request-1', jobId, ok: false });
			expect(await store.get(jobId)).toMatchObject({ status: 'running', results: {} });

			const other = jobSetup();
			await seed(other.store, storedRecord());
			other.port.send(put([{ id: 0, text: 'Mine' }, { id: 1, text: 'Mine too' }]));
			await settle();
			expect(other.port.last()).toEqual({ type: 'checkpoint', requestId: 'request-1', jobId, ok: false });
			expect(await other.store.get(jobId)).toMatchObject({ status: 'running' });
		});

		test('rejects a job id that does not match the segments', async () => {
			const { port, store } = jobSetup();
			port.send(put([{ id: 0, text: 'Hello' }], { segments: [{ id: 0, text: 'Other' }, { id: 1, text: 'Adiós' }] }));
			await settle();
			expect(port.posted).toEqual([
				{ type: 'error', jobId, error: expect.objectContaining({ detail: 'Invalid AI request.' }) }
			]);
			expect(await store.get(jobId)).toBeUndefined();
		});

		test('a later start-job continues from the saved results', async () => {
			const { deps, port } = jobSetup();
			port.send(put([{ id: 0, text: 'Hello' }]));
			await settle();
			port.send(startJob);
			await settle();

			expect(deps.executeApi).toHaveBeenCalledTimes(1);
			const [call] = (deps.executeApi as ReturnType<typeof vi.fn>).mock.calls[0];
			expect(JSON.stringify(call.messages)).not.toContain('Hola');
			expect(port.last()).toMatchObject({ type: 'job-state', status: 'completed', completedSegments: 2 });
		});
	});

	test('checkpoint-clear cancels a live job and removes its record', async () => {
		const api = pendingApi();
		const { gateway, port, store } = jobSetup({ executeApi: api.executeApi });
		port.send(startJob);
		await settle();
		port.send({ type: 'checkpoint-clear', requestId: 'request-1', jobId });
		await settle();

		expect(api.calls[0].signal?.aborted).toBe(true);
		expect(port.posted).toContainEqual(expect.objectContaining({ type: 'job-state', status: 'cancelled' }));
		expect(port.last()).toEqual({ type: 'checkpoint', requestId: 'request-1', jobId, ok: true });
		expect(await store.get(jobId)).toBeUndefined();
		expect(await store.getInput(jobId)).toBeUndefined();
		expect(gateway.activeJobIds()).toEqual([]);
	});

	test('checkpoint-clear of a stored record removes it without a request', async () => {
		const { deps, port, store } = jobSetup();
		await seed(store, storedRecord({ status: 'incomplete', results: { 0: 'Hello' } }));
		port.send({ type: 'checkpoint-clear', requestId: 'request-1', jobId });
		await settle();
		expect(port.last()).toEqual({ type: 'checkpoint', requestId: 'request-1', jobId, ok: true });
		expect(await store.get(jobId)).toBeUndefined();
		expect(deps.executeApi).not.toHaveBeenCalled();
	});

	test('init removes legacy checkpoints, resumes recent running jobs, and expires old ones', async () => {
		const oldTexts = ['Uno'];
		const oldSegments = oldTexts.map((text, id) => ({ id, text }));
		const oldId = transcriptJobId('translate', identity, oldSegments);
		const area = memoryArea({
			[`${LEGACY_CHECKPOINT_KEY_PREFIX}video-1`]: { translations: ['x'] },
			unrelated: 1
		});
		const { deps, gateway, store } = jobSetup({}, area);
		await seed(store, storedRecord());
		await store.putInput(oldId, { instruction: 'Translate.', segments: oldTexts });
		await store.put(storedRecord({
			id: oldId,
			segmentCount: 1,
			segmentHash: hashSegments(identity.scope, oldTexts),
			updatedAt: Date.now() - RESUME_WINDOW_MS - 1000
		}));

		await expect(gateway.init()).resolves.toEqual({ resumed: [jobId], expired: [oldId] });
		await settle();

		expect(area.values.has(`${LEGACY_CHECKPOINT_KEY_PREFIX}video-1`)).toBe(false);
		expect(area.values.get('unrelated')).toBe(1);
		expect(deps.executeApi).toHaveBeenCalledTimes(1);
		expect(await store.get(jobId)).toMatchObject({ status: 'completed' });
		expect(await store.get(oldId)).toMatchObject({ status: 'incomplete' });
		expect(Array.from(area.values.keys()).filter(key => key.startsWith(AI_JOB_KEY_PREFIX)).sort())
			.toEqual([`${AI_JOB_KEY_PREFIX}${jobId}`, `${AI_JOB_KEY_PREFIX}${oldId}`].sort());
		// Idempotent.
		await expect(gateway.init()).resolves.toEqual({ resumed: [jobId], expired: [oldId] });
		expect(deps.executeApi).toHaveBeenCalledTimes(1);
	});

	test('an attach that arrives before init finishes shares the one resumed job', async () => {
		const api = pendingApi();
		const { gateway, port, store } = jobSetup({ executeApi: api.executeApi });
		await seed(store, storedRecord());
		port.send({ type: 'attach', jobId });
		const init = gateway.init();
		await settle();
		await init;

		expect(api.executeApi).toHaveBeenCalledTimes(1);
		expect(types(port)).toEqual(['job-state:running']);
		api.calls[0].resolve(allTranslations);
		await settle();
		expect(types(port)).toEqual(['job-state:running', 'job-progress', 'job-state:completed']);
		expect(api.executeApi).toHaveBeenCalledTimes(1);
	});

	test('a disconnect never cancels a durable job but still cancels interactive tasks', async () => {
		const api = pendingApi();
		const { port, store } = jobSetup({ executeApi: api.executeApi });
		port.send(startJob);
		port.send({ type: 'start', jobId: 'job-explain', task: 'explain', input: textInput });
		await settle();
		expect(api.calls).toHaveLength(2);
		const durableCall = api.calls.find(call => JSON.stringify(call.request.messages).includes('Hola'));
		const explainCall = api.calls.find(call => call !== durableCall);
		port.disconnect();

		expect(explainCall?.signal?.aborted).toBe(true);
		expect(durableCall?.signal?.aborted).toBe(false);
		durableCall?.resolve(allTranslations);
		await settle();
		expect(await store.get(jobId)).toMatchObject({ status: 'completed', results: { 0: 'Hello', 1: 'Goodbye' } });
	});

	test('keeps the worker alive while a durable job runs and stops afterwards', async () => {
		vi.useFakeTimers();
		const keepAlive = vi.fn();
		const api = pendingApi();
		const { gateway, port } = jobSetup({ keepAlive, keepAliveIntervalMs: 1000, executeApi: api.executeApi });
		port.send(startJob);
		await vi.advanceTimersByTimeAsync(10);
		expect(gateway.activeJobIds()).toEqual([jobId]);
		port.disconnect();
		await vi.advanceTimersByTimeAsync(3000);
		expect(keepAlive).toHaveBeenCalledTimes(3);

		api.calls[0].resolve(allTranslations);
		await vi.advanceTimersByTimeAsync(10);
		expect(gateway.activeJobIds()).toEqual([]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(keepAlive).toHaveBeenCalledTimes(3);
	});

	test('keeps the worker alive for a job resumed on init', async () => {
		vi.useFakeTimers();
		const keepAlive = vi.fn();
		const api = pendingApi();
		const { gateway, store } = jobSetup({ keepAlive, keepAliveIntervalMs: 1000, executeApi: api.executeApi });
		await seed(store, storedRecord());
		await gateway.init();
		await vi.advanceTimersByTimeAsync(2500);
		expect(keepAlive).toHaveBeenCalledTimes(2);

		api.calls[0].resolve(allTranslations);
		await vi.advanceTimersByTimeAsync(5000);
		expect(keepAlive).toHaveBeenCalledTimes(2);
	});
});
