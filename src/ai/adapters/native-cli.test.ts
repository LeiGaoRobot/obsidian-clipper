import { describe, expect, test, vi } from 'vitest';

vi.mock('../../utils/native-cli-service', async importOriginal => ({
	...await importOriginal<typeof import('../../utils/native-cli-service')>(),
	sendNativeCliRequest: vi.fn()
}));

import { RequestCancelledError } from '../../utils/request-cancellation';
import { NativeCliExecutionError, NativeCliUnavailableError } from '../../utils/native-cli-service';
import { executeCliCall, runCliPrompt } from './native-cli';

const prompts = [{ key: 'prompt_1', prompt: 'Summarize' }];

describe('executeCliCall', () => {
	test('sends Codex model and effort, forwards heartbeats, and parses responses', async () => {
		const send = vi.fn(async (_request: unknown, _signal?: AbortSignal, onHeartbeat?: (heartbeat: { type: 'heartbeat'; requestId: string; elapsedMs: number }) => void) => {
			onHeartbeat?.({ type: 'heartbeat', requestId: 'r', elapsedMs: 10000 });
			return { ok: true, stdout: '{"prompts_responses":{"prompt_1":"Done"}}' };
		});
		const heartbeats: number[] = [];
		const result = await executeCliCall(
			{ kind: 'cli-codex', model: 'gpt-codex', effort: 'high', context: 'Page', prompts },
			{ send, onHeartbeat: elapsed => heartbeats.push(elapsed) }
		);
		expect(result).toEqual({ prompt_1: 'Done' });
		expect(send.mock.calls[0][0]).toMatchObject({ mode: 'codex', model: 'gpt-codex', effort: 'high' });
		expect(heartbeats).toEqual([10000]);
	});

	test('never sends Codex options for Grok', async () => {
		const send = vi.fn().mockResolvedValue({ ok: true, stdout: '{"prompt_1":"x"}' });
		await executeCliCall({ kind: 'cli-grok', model: 'gpt-codex', effort: 'high', context: 'Page', prompts }, { send });
		const request = send.mock.calls[0][0];
		expect(request.mode).toBe('grok');
		expect(request).not.toHaveProperty('model');
		expect(request).not.toHaveProperty('effort');
	});

	test.each([
		[new NativeCliExecutionError('timeout', 'codex CLI timed out after 120 seconds.'), 'timeout'],
		[new NativeCliExecutionError('protocol-mismatch', 'old host'), 'host-outdated'],
		[new NativeCliExecutionError('config', 'not configured'), 'cli-missing'],
		[new NativeCliUnavailableError('Specified native messaging host not found.'), 'host-missing'],
		[new RequestCancelledError(), 'cancelled']
	])('maps %s to %s', async (error, code) => {
		const send = vi.fn().mockRejectedValue(error);
		await expect(executeCliCall({ kind: 'cli-codex', context: 'Page', prompts }, { send, connectionId: 'cli' }))
			.rejects.toMatchObject({ code, connectionId: 'cli' });
	});

	test('reports unparseable CLI output as a bad response', async () => {
		const send = vi.fn().mockResolvedValue({ ok: true, stdout: 'I could not do that.' });
		await expect(executeCliCall({ kind: 'cli-grok', context: 'Page', prompts }, { send }))
			.rejects.toMatchObject({ code: 'bad-response' });
	});
});

describe('runCliPrompt', () => {
	const outputSchema = { type: 'object', properties: { answer: { type: 'string' } } };

	test('sends the rendered prompt with Codex options and output schema, and returns raw stdout', async () => {
		const send = vi.fn().mockResolvedValue({ ok: true, stdout: '{"answer":"Done"}' });
		await expect(runCliPrompt(
			{ kind: 'cli-codex', model: 'gpt-codex', effort: 'high', prompt: 'Rendered', outputSchema },
			{ send }
		)).resolves.toBe('{"answer":"Done"}');
		expect(send.mock.calls[0][0]).toMatchObject({
			type: 'executeCli',
			mode: 'codex',
			prompt: 'Rendered',
			model: 'gpt-codex',
			effort: 'high',
			outputSchema
		});
	});

	test('never sends Codex options or an output schema for Grok', async () => {
		const send = vi.fn().mockResolvedValue({ ok: true, stdout: 'plain' });
		await expect(runCliPrompt(
			{ kind: 'cli-grok', model: 'gpt-codex', effort: 'high', prompt: 'Rendered', outputSchema },
			{ send }
		)).resolves.toBe('plain');
		const request = send.mock.calls[0][0];
		expect(request).toMatchObject({ mode: 'grok', prompt: 'Rendered' });
		expect(request).not.toHaveProperty('model');
		expect(request).not.toHaveProperty('effort');
		expect(request).not.toHaveProperty('outputSchema');
	});

	test('returns an empty string when the Host reports no stdout', async () => {
		const send = vi.fn().mockResolvedValue({ ok: true });
		await expect(runCliPrompt({ kind: 'cli-codex', prompt: 'Rendered' }, { send })).resolves.toBe('');
	});

	test.each([
		[new NativeCliExecutionError('timeout', 'codex CLI timed out after 120 seconds.'), 'timeout'],
		[new NativeCliExecutionError('protocol-mismatch', 'old host'), 'host-outdated'],
		[new NativeCliUnavailableError('Specified native messaging host not found.'), 'host-missing'],
		[new RequestCancelledError(), 'cancelled']
	])('maps %s to %s', async (error, code) => {
		const send = vi.fn().mockRejectedValue(error);
		await expect(runCliPrompt({ kind: 'cli-codex', prompt: 'Rendered', outputSchema }, { send, connectionId: 'cli' }))
			.rejects.toMatchObject({ code, connectionId: 'cli' });
	});
});
