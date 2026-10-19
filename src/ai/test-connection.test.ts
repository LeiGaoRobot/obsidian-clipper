import { describe, expect, test, vi } from 'vitest';
import { AiError } from './errors';
import {
	CLI_TEST_PROMPT,
	connectionTestPlan,
	runConnectionTest,
	statusFromTestResult,
	type ConnectionTestDeps,
	type ConnectionTestInput
} from './test-connection';
import type { Connection, ModelProfile } from './types';

const OPENAI: Connection = { id: 'openai', kind: 'openai-compatible', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1/chat/completions', apiKeyRequired: true };
const DEEPSEEK: Connection = { id: 'deepseek', kind: 'openai-compatible', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1/chat/completions', apiKeyRequired: true };
const ANTHROPIC: Connection = { id: 'anthropic', kind: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1/messages', apiKeyRequired: true };
const OLLAMA: Connection = { id: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/api/chat', apiKeyRequired: false };
const AZURE: Connection = { id: 'azure', kind: 'azure-openai', label: 'Azure', baseUrl: 'https://work.openai.azure.com/openai/deployments/x/chat/completions?api-version=2024-10-21', apiKeyRequired: true };
const PERPLEXITY: Connection = { id: 'perplexity', kind: 'perplexity', label: 'Perplexity', baseUrl: 'https://api.perplexity.ai/chat/completions', apiKeyRequired: true };
const CODEX: Connection = { id: 'codex', kind: 'cli-codex', label: '' };
const GROK: Connection = { id: 'grok', kind: 'cli-grok', label: '' };

function profile(id: string, connectionId: string, model?: string, effort?: 'low' | 'high'): ModelProfile {
	return {
		id,
		connectionId,
		...(model ? { model } : {}),
		label: '',
		...(effort ? { options: { reasoningEffort: effort } } : {}),
		enabled: true
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function harness(overrides: Partial<ConnectionTestDeps> = {}) {
	const deps: ConnectionTestDeps = {
		app: { name: 'PagePick', homepageUrl: 'https://example.com' },
		executeApi: vi.fn(async () => '{"ok":true}'),
		executeCli: vi.fn(async () => 'OK'),
		health: vi.fn(async () => 'port' as const),
		fetchImpl: vi.fn(async () => json({ data: [{ id: 'gpt-5.6' }] })) as unknown as typeof fetch,
		now: () => 42,
		...overrides
	};
	const steps: Array<[string, string | undefined]> = [];
	const run = (input: Partial<ConnectionTestInput> & { connection: Connection }, signal?: AbortSignal) => runConnectionTest(
		{ profiles: [], nativeMessaging: 'port', credential: 'sk-test', ...input },
		deps,
		{ ...(signal ? { signal } : {}), onStep: (step, profileId) => steps.push([step, profileId]) }
	);
	return { deps, steps, run };
}

describe('connection Test plan', () => {
	test('per kind: free steps first, a billable step only where needed', () => {
		const gpt = [profile('p', 'x', 'm')];
		expect(connectionTestPlan(OPENAI, gpt)).toEqual({ steps: ['listing'], billable: false });
		expect(connectionTestPlan(DEEPSEEK, gpt)).toEqual({ steps: ['listing', 'structured'], billable: true });
		// Without a model to probe, a compatible server is only listed.
		expect(connectionTestPlan(DEEPSEEK, [])).toEqual({ steps: ['listing'], billable: false });
		expect(connectionTestPlan(ANTHROPIC, gpt)).toEqual({ steps: ['listing'], billable: false });
		expect(connectionTestPlan(OLLAMA, gpt)).toEqual({ steps: ['listing'], billable: false });
		expect(connectionTestPlan(AZURE, gpt)).toEqual({ steps: ['probe'], billable: true });
		expect(connectionTestPlan(PERPLEXITY, gpt)).toEqual({ steps: ['probe'], billable: true });
		expect(connectionTestPlan({ kind: 'huggingface', baseUrl: 'https://api-inference.huggingface.co/models/x/chat/completions' }, gpt))
			.toEqual({ steps: ['probe'], billable: true });
		expect(connectionTestPlan({ kind: 'openai-compatible', baseUrl: 'https://example.com/generate' }, gpt))
			.toEqual({ steps: ['structured'], billable: true });
		expect(connectionTestPlan(CODEX, gpt)).toEqual({ steps: ['health', 'exec'], billable: true });
		expect(connectionTestPlan(GROK)).toEqual({ steps: ['health', 'exec'], billable: true });
	});
});

describe('API connection Test', () => {
	test('lists models and reports listed and unlisted profile models without a billable request', async () => {
		const fetchImpl = vi.fn(async () => json({ data: [{ id: 'gpt-5.6' }, { id: 'gpt-5.6-mini' }] }));
		const { deps, steps, run } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
		const result = await run({
			connection: OPENAI,
			profiles: [profile('gpt', 'openai', 'gpt-5.6'), profile('old', 'openai', 'gpt-4')]
		});

		expect(result).toEqual({
			connectionId: 'openai',
			state: 'ok',
			testedAt: 42,
			billable: false,
			listedModels: ['gpt-5.6', 'gpt-5.6-mini'],
			models: [
				{ profileId: 'gpt', model: 'gpt-5.6', listed: true },
				{ profileId: 'old', model: 'gpt-4', listed: false }
			]
		});
		expect(steps).toEqual([['listing', undefined]]);
		expect(deps.executeApi).not.toHaveBeenCalled();
		expect(fetchImpl).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({
			method: 'GET',
			headers: { Authorization: 'Bearer sk-test' }
		}));
	});

	test('caps the listed ids at 200', async () => {
		const ids = Array.from({ length: 250 }, (_, index) => ({ id: `m${index}` }));
		const { run } = harness({ fetchImpl: vi.fn(async () => json({ data: ids })) as unknown as typeof fetch });
		expect((await run({ connection: OPENAI })).listedModels).toHaveLength(200);
	});

	test('a 401 is failing with auth, and the key never appears in the result', async () => {
		const fetchImpl = vi.fn(async () => new Response('{"error":"Incorrect API key provided: sk-test"}', { status: 401 }));
		const { deps, run } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
		const result = await run({ connection: DEEPSEEK, profiles: [profile('p', 'deepseek', 'deepseek-chat')] });

		expect(result).toMatchObject({ state: 'failing', billable: false, error: { code: 'auth', status: 401, connectionId: 'deepseek' } });
		expect(JSON.stringify(result)).not.toContain('sk-test');
		expect(result.error?.detail).toContain('[redacted]');
		// A rejected key stops the Test before the billable probe.
		expect(deps.executeApi).not.toHaveBeenCalled();
	});

	test('a missing key fails without any request', async () => {
		const { deps, run } = harness();
		const result = await run({ connection: OPENAI, credential: undefined });
		expect(result).toMatchObject({ state: 'failing', error: { code: 'credential-missing' } });
		expect(deps.fetchImpl).not.toHaveBeenCalled();
	});

	test('the structured probe goes json_schema, then json_object, then none, and is billable', async () => {
		const rejection = (field: string) => new AiError('provider-error', { status: 400, detail: `Unsupported parameter: ${field}` });
		const cases: Array<[unknown[], string, number]> = [
			[['{"ok":true}'], 'json_schema', 1],
			[[rejection('response_format.json_schema'), '{"ok":true}'], 'json_object', 2],
			[[rejection('response_format.json_schema'), rejection('response_format')], 'none', 2]
		];
		for (const [replies, mode, calls] of cases) {
			const executeApi = vi.fn();
			for (const reply of replies) {
				if (reply instanceof Error) executeApi.mockRejectedValueOnce(reply);
				else executeApi.mockResolvedValueOnce(reply);
			}
			const { steps, run } = harness({ executeApi });
			const result = await run({ connection: DEEPSEEK, profiles: [profile('p', 'deepseek', 'deepseek-chat')] });

			expect(result).toMatchObject({ state: 'ok', billable: true, structuredOutput: mode });
			expect(executeApi).toHaveBeenCalledTimes(calls);
			expect(steps.map(([step]) => step)).toEqual(['listing', 'structured']);
			expect(executeApi.mock.calls[0][0]).toMatchObject({
				kind: 'openai-compatible',
				model: 'deepseek-chat',
				credential: 'sk-test',
				maxTokens: 16,
				structured: { mode: 'json_schema', name: 'connection_test' }
			});
			if (calls > 1) expect(executeApi.mock.calls[1][0]).toMatchObject({ structured: { mode: 'json_object' } });
		}
	});

	test('a probe error other than a structured rejection fails the connection', async () => {
		const executeApi = vi.fn().mockRejectedValue(new AiError('model-unavailable', { status: 404, detail: 'no such model' }));
		const { run } = harness({ executeApi });
		const result = await run({ connection: DEEPSEEK, profiles: [profile('p', 'deepseek', 'gone')] });
		expect(result).toMatchObject({ state: 'failing', billable: true, error: { code: 'model-unavailable' } });
		expect(executeApi).toHaveBeenCalledTimes(1);
	});

	test('a server without a listing endpoint falls back to the probe', async () => {
		const fetchImpl = vi.fn(async () => new Response('Not found', { status: 404 }));
		const { deps, steps, run } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
		const result = await run({ connection: OLLAMA, credential: undefined, profiles: [profile('l', 'ollama', 'llama4')] });
		expect(result).toMatchObject({ state: 'ok', billable: true });
		expect(steps.map(([step]) => step)).toEqual(['listing', 'probe']);
		expect(deps.executeApi).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ollama', maxTokens: 1 }), expect.anything());
	});

	test('Azure sends one 1-token completion and counts a 200 with empty text as ok', async () => {
		const executeApi = vi.fn(async () => '');
		const { deps, steps, run } = harness({ executeApi });
		const result = await run({ connection: AZURE });
		expect(result).toEqual({ connectionId: 'azure', state: 'ok', testedAt: 42, billable: true });
		expect(steps).toEqual([['probe', undefined]]);
		expect(executeApi).toHaveBeenCalledTimes(1);
		expect((executeApi.mock.calls[0] as unknown[])[0]).toMatchObject({ kind: 'azure-openai', maxTokens: 1 });
		expect((executeApi.mock.calls[0] as unknown[])[0]).not.toHaveProperty('structured');
		expect(deps.fetchImpl).not.toHaveBeenCalled();
	});

	test('a probe without a model to test fails as not configured', async () => {
		const { deps, run } = harness();
		expect(await run({ connection: PERPLEXITY })).toMatchObject({ state: 'failing', billable: false, error: { code: 'not-configured', reason: 'no-profile' } });
		expect(deps.executeApi).not.toHaveBeenCalled();
	});

	test('cancel mid-plan ends cancelled with no further request', async () => {
		const controller = new AbortController();
		const fetchImpl = vi.fn(async () => {
			controller.abort();
			return json({ data: [{ id: 'deepseek-chat' }] });
		});
		const { deps, run } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
		await expect(run({ connection: DEEPSEEK, profiles: [profile('p', 'deepseek', 'deepseek-chat')] }, controller.signal))
			.rejects.toMatchObject({ code: 'cancelled', connectionId: 'deepseek' });
		expect(deps.executeApi).not.toHaveBeenCalled();
	});
});

describe('CLI connection Test', () => {
	test('Codex runs the health check, then one exec per enabled profile with its model and effort', async () => {
		const { deps, steps, run } = harness();
		const result = await run({
			connection: CODEX,
			profiles: [profile('fast', 'codex', 'gpt-5.6-luna', 'low'), profile('deep', 'codex', 'gpt-5.6-sol', 'high')]
		});
		expect(result).toEqual({ connectionId: 'codex', state: 'ok', testedAt: 42, billable: true, transport: 'port' });
		expect(steps).toEqual([['health', undefined], ['exec', 'fast'], ['exec', 'deep']]);
		expect(deps.health).toHaveBeenCalledWith('cli-codex', expect.objectContaining({ connectionId: 'codex' }));
		expect((deps.executeCli as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])).toEqual([
			{ kind: 'cli-codex', model: 'gpt-5.6-luna', effort: 'low', prompt: CLI_TEST_PROMPT },
			{ kind: 'cli-codex', model: 'gpt-5.6-sol', effort: 'high', prompt: CLI_TEST_PROMPT }
		]);
	});

	test('Codex stops at the first failing profile', async () => {
		const executeCli = vi.fn()
			.mockRejectedValueOnce(new AiError('provider-error', { nativeCode: 'cli-failed', detail: 'unknown model gpt-x' }))
			.mockResolvedValue('OK');
		const { run } = harness({ executeCli });
		const result = await run({ connection: CODEX, profiles: [profile('bad', 'codex', 'gpt-x'), profile('good', 'codex', 'gpt-5.6-sol')] });
		expect(result).toMatchObject({ state: 'failing', billable: true, error: { code: 'provider-error', detail: 'unknown model gpt-x' } });
		expect(executeCli).toHaveBeenCalledTimes(1);
	});

	test('a failed health check sends no exec', async () => {
		const health = vi.fn().mockRejectedValue(new AiError('host-missing', { detail: 'Specified native messaging host not found.' }));
		const { deps, run } = harness({ health });
		expect(await run({ connection: CODEX })).toMatchObject({ state: 'failing', billable: false, error: { code: 'host-missing' } });
		expect(deps.executeCli).not.toHaveBeenCalled();
	});

	test('Grok runs one exec without model or effort, one-shot over Safari messages', async () => {
		const health = vi.fn(async () => 'message' as const);
		const { deps, steps, run } = harness({ health });
		const result = await run({ connection: GROK, nativeMessaging: 'message', profiles: [profile('g', 'grok'), profile('g2', 'grok')] });
		expect(result).toEqual({ connectionId: 'grok', state: 'ok', testedAt: 42, billable: true, transport: 'message' });
		expect(steps).toEqual([['health', undefined], ['exec', 'g']]);
		expect(deps.executeCli).toHaveBeenCalledTimes(1);
		expect((deps.executeCli as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ kind: 'cli-grok', prompt: CLI_TEST_PROMPT });
	});

	test('a browser without Native Messaging is host-unsupported', async () => {
		const { deps, run } = harness();
		expect(await run({ connection: CODEX, nativeMessaging: 'none' })).toMatchObject({ state: 'failing', error: { code: 'host-unsupported' } });
		expect(deps.health).not.toHaveBeenCalled();
	});

	test('cancel between execs sends no further exec', async () => {
		const controller = new AbortController();
		const executeCli = vi.fn(async () => {
			controller.abort();
			return 'OK';
		});
		const { run } = harness({ executeCli });
		await expect(run({ connection: CODEX, profiles: [profile('a', 'codex', 'm1'), profile('b', 'codex', 'm2')] }, controller.signal))
			.rejects.toMatchObject({ code: 'cancelled' });
		expect(executeCli).toHaveBeenCalledTimes(1);
	});
});

describe('statusFromTestResult', () => {
	test('keeps a downgrade the Test did not probe, and a detected mode overwrites it', () => {
		expect(statusFromTestResult({ connectionId: 'a', state: 'ok', testedAt: 1, billable: false }, { structuredOutput: 'none' }))
			.toEqual({ state: 'ok', testedAt: 1, structuredOutput: 'none' });
		expect(statusFromTestResult({ connectionId: 'a', state: 'ok', testedAt: 1, billable: true, structuredOutput: 'json_object' }, { structuredOutput: 'none' }))
			.toEqual({ state: 'ok', testedAt: 1, structuredOutput: 'json_object' });
		expect(statusFromTestResult({
			connectionId: 'a',
			state: 'failing',
			testedAt: 2,
			billable: false,
			error: { code: 'auth', retryable: false, status: 401, detail: 'x'.repeat(600) }
		})).toEqual({ state: 'failing', testedAt: 2, code: 'auth', status: 401, detail: `${'x'.repeat(500)}…` });
	});
});
