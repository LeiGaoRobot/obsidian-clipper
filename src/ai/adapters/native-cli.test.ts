import { describe, expect, test, vi } from 'vitest';

vi.mock('../../utils/native-cli-service', async importOriginal => ({
	...await importOriginal<typeof import('../../utils/native-cli-service')>(),
	sendNativeCliRequest: vi.fn()
}));

import { RequestCancelledError } from '../../utils/request-cancellation';
import { NativeCliExecutionError, NativeCliUnavailableError } from '../../utils/native-cli-service';
import { checkCliHealth, runCliPrompt } from './native-cli';

describe('runCliPrompt errors', () => {
	test.each([
		[new NativeCliExecutionError('timeout', 'codex CLI timed out after 120 seconds.'), 'timeout'],
		[new NativeCliExecutionError('protocol-mismatch', 'old host'), 'host-outdated'],
		[new NativeCliExecutionError('config', 'not configured'), 'cli-missing'],
		[new NativeCliUnavailableError('Specified native messaging host not found.'), 'host-missing'],
		[new RequestCancelledError(), 'cancelled']
	])('maps %s to %s', async (error, code) => {
		const send = vi.fn().mockRejectedValue(error);
		await expect(runCliPrompt({ kind: 'cli-codex', prompt: 'Page' }, { send, connectionId: 'cli' }))
			.rejects.toMatchObject({ code, connectionId: 'cli' });
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

describe('checkCliHealth', () => {
	test('checks the CLI kind and returns the transport', async () => {
		const check = vi.fn().mockResolvedValue({ health: { protocolVersion: 5, mode: 'grok', command: 'grok' }, transport: 'message' });
		await expect(checkCliHealth('cli-grok', { check })).resolves.toBe('message');
		expect(check).toHaveBeenCalledWith('grok', undefined);
	});

	test('maps a missing Host to host-missing', async () => {
		const check = vi.fn().mockRejectedValue(new NativeCliUnavailableError('Specified native messaging host not found.'));
		await expect(checkCliHealth('cli-codex', { check, connectionId: 'cli' })).rejects.toMatchObject({ code: 'host-missing', connectionId: 'cli' });
	});
});
