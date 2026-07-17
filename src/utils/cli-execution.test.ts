import { describe, expect, test, vi } from 'vitest';
import {
	buildCliInvocation,
	collectPromptVariables,
	executePromptVariables,
	parsePromptResponses,
	replacePromptVariables
} from './cli-execution';

describe('CLI execution modes', () => {
	test('collects unique prompt variables in template order', () => {
		expect(collectPromptVariables([
			'{{"Summarize this"}}',
			'{{"Tag this"|lower}} {{"Summarize this"}}'
		])).toEqual([
			{ key: 'prompt_1', prompt: 'Summarize this', filters: '' },
			{ key: 'prompt_2', prompt: 'Tag this', filters: '|lower' }
		]);
	});

	test('replaces responses and preserves template filters', () => {
		const variables = collectPromptVariables(['{{"Title"|upper}}']);
		const output = replacePromptVariables(
			'Answer: {{"Title"|upper}}',
			variables,
			{ prompt_1: 'a useful title' },
			'https://example.com'
		);

		expect(output).toBe('Answer: A USEFUL TITLE');
	});

	test('builds a read-only Grok invocation', () => {
		expect(buildCliInvocation('grok', 'prompt', { cwd: '/tmp', timeoutMs: 5000 })).toEqual({
			command: 'grok',
			args: ['--single', 'prompt', '--output-format', 'plain', '--no-plan', '--no-subagents'],
			cwd: '/tmp',
			timeoutMs: 5000
		});
	});

	test('builds a read-only Codex invocation that reads the prompt from stdin', () => {
		expect(buildCliInvocation('codex', 'prompt', { cwd: '/tmp', timeoutMs: 5000 })).toEqual({
			command: 'codex',
			args: ['exec', '--ephemeral', '--color', 'never', '--sandbox', 'read-only', '--skip-git-repo-check', '-'],
			input: 'prompt',
			cwd: '/tmp',
			timeoutMs: 5000
		});
	});

	test('executes either mode with the shared JSON response contract', async () => {
		const runner = vi.fn().mockResolvedValue({
			stdout: '```json\n{"prompts_responses":{"prompt_1":"done"}}\n```',
			stderr: ''
		});

		const result = await executePromptVariables(
			'codex',
			'Article content',
			[{ key: 'prompt_1', prompt: 'Summarize this', filters: '' }],
			{ runner }
		);

		expect(result).toEqual({ prompt_1: 'done' });
		expect(runner).toHaveBeenCalledWith(expect.objectContaining({
			command: 'codex',
			input: expect.stringContaining('Article content')
		}));
	});

	test('rejects incomplete CLI responses', () => {
		expect(() => parsePromptResponses(
			'{"prompts_responses":{}}',
			[{ key: 'prompt_1', prompt: 'Summarize this', filters: '' }]
		)).toThrow('missing prompt_1');
	});

	test('skips unrelated JSON emitted before the final response', () => {
		expect(parsePromptResponses(
			'{"type":"status"}\n{"prompts_responses":{"prompt_1":"done"}}',
			[{ key: 'prompt_1', prompt: 'Summarize this', filters: '' }]
		)).toEqual({ prompt_1: 'done' });
	});
});
