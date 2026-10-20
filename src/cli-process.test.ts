// @vitest-environment jsdom
// The fill cases clip through the API with linkedom; createMarkdownContent needs a DOM, as in the CLI.
import { describe, expect, test, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { clip, createAsyncResolver, createSelectorProcessor, type DocumentParser } from './api';
import type { Template } from './types/types';
import { collectPromptVariables } from './utils/cli-execution-contract';
import { compileTemplate } from './utils/template-compiler';
import {
	executePromptVariables,
	fillPromptResponses,
	promptContextOf,
	runCliProcess,
	type CliProcessInvocation
} from './cli-process';

function nodeScript(source: string, overrides: Partial<CliProcessInvocation> = {}): CliProcessInvocation {
	return { command: process.execPath, args: ['-e', source], cwd: process.cwd(), timeoutMs: 10_000, ...overrides };
}

describe('runCliProcess', () => {
	test('writes the input to stdin and resolves with stdout and stderr', async () => {
		const result = await runCliProcess(nodeScript(
			"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{process.stdout.write(s.toUpperCase());process.stderr.write('note')})",
			{ input: 'prompt' }
		));

		expect(result).toEqual({ stdout: 'PROMPT', stderr: 'note' });
	});

	test('rejects with the captured stderr when the CLI fails', async () => {
		await expect(runCliProcess(nodeScript("process.stderr.write('  quota exceeded\\n');process.exit(3)")))
			.rejects.toThrow(`${process.execPath} CLI failed: quota exceeded`);
	});

	test('names the exit code when a failing CLI writes no stderr', async () => {
		await expect(runCliProcess(nodeScript('process.exit(4)')))
			.rejects.toThrow('CLI failed: process exited with code 4');
	});

	test('kills a CLI that runs past the timeout', async () => {
		const started = Date.now();
		await expect(runCliProcess(nodeScript('setInterval(() => {}, 1000)', { timeoutMs: 200 })))
			.rejects.toThrow(`${process.execPath} CLI timed out after 1 seconds.`);
		expect(Date.now() - started).toBeLessThan(5000);
	});

	test('explains a CLI that is not on PATH', async () => {
		await expect(runCliProcess({ command: 'obsidian-clipper-missing-cli', args: [], cwd: process.cwd(), timeoutMs: 5000 }))
			.rejects.toThrow('Could not find obsidian-clipper-missing-cli CLI.');
	});
});

describe('executePromptVariables', () => {
	const prompts = [{ key: 'prompt_1', prompt: 'Summarize this', filters: '' }];

	test('runs the CLI once with the shared prompt and parses its reply', async () => {
		const runner = vi.fn().mockResolvedValue({ stdout: '```json\n{"prompt_1":"done"}\n```', stderr: '' });

		const result = await executePromptVariables('codex', 'Article content', prompts, { runner, cwd: '/tmp', timeoutMs: 5000 });

		expect(result).toEqual({ prompt_1: 'done' });
		expect(runner).toHaveBeenCalledTimes(1);
		expect(runner).toHaveBeenCalledWith(expect.objectContaining({
			command: 'codex',
			cwd: '/tmp',
			timeoutMs: 5000,
			input: expect.stringContaining('Article content')
		}));
	});

	test('defaults to the shared two-minute timeout', async () => {
		const runner = vi.fn().mockResolvedValue({ stdout: '{"prompt_1":"done"}', stderr: '' });

		await executePromptVariables('grok', 'Article content', prompts, { runner });

		expect(runner.mock.calls[0][0].timeoutMs).toBe(120_000);
	});

	test('passes Codex model and effort, and ignores them for Grok', async () => {
		const runner = vi.fn().mockResolvedValue({ stdout: '{"prompt_1":"done"}', stderr: '' });

		await executePromptVariables('codex', 'c', prompts, { runner, model: 'gpt-codex', effort: 'high' });
		await executePromptVariables('grok', 'c', prompts, { runner, model: 'gpt-codex', effort: 'high' });
		await executePromptVariables('grok', 'c', prompts, { runner });

		expect(runner.mock.calls[0][0].args).toEqual(expect.arrayContaining(['--model', 'gpt-codex', 'model_reasoning_effort="high"']));
		expect(runner.mock.calls[1][0].args).toEqual(runner.mock.calls[2][0].args);
	});

	test('runs nothing without prompts', async () => {
		const runner = vi.fn();

		expect(await executePromptVariables('codex', 'c', [], { runner })).toEqual({});
		expect(runner).not.toHaveBeenCalled();
	});
});

describe('filling a clip with the CLI answers', () => {
	const parser: DocumentParser = { parseFromString: html => parseHTML(html).document };
	const url = 'https://example.com/a';
	const html = '<html><head><title>Fixture</title></head><body><article><p>Body text for the prompts.</p></article></body></html>';
	const baseTemplate: Template = {
		id: 't',
		name: 'T',
		behavior: 'create',
		noteNameFormat: '{{"name"|upper}} note',
		path: '',
		noteContentFormat: 'Body: {{"x"}}',
		properties: [
			{ id: 'p1', name: 'summary', value: '{{"y"}}', type: 'text' },
			{ id: 'p2', name: 'tags', value: '{{"tags"}}', type: 'multitext' },
			{ id: 'p3', name: 'site', value: '{{domain}}', type: 'text' }
		]
	};

	const template = baseTemplate;

	// What `src/cli.ts` does with `--execution-mode`.
	async function clipAndFill(responses: Record<string, unknown>, template: Template = baseTemplate) {
		const doc = parser.parseFromString(html, 'text/html');
		const result = await clip({ html, url, template, documentParser: parser, parsedDocument: doc, keepPromptVariables: true });
		const compiledNoteName = await compileTemplate(0, template.noteNameFormat, result.variables, url, {
			asyncResolver: createAsyncResolver(doc),
			selectorProcessor: createSelectorProcessor(doc),
			keepPromptVariables: true
		});
		const prompts = collectPromptVariables([
			template.noteContentFormat,
			...template.properties.map(property => property.value),
			template.noteNameFormat
		]);
		return { result, filled: fillPromptResponses({ ...result, template, compiledNoteName }, prompts, responses, url) };
	}

	test('answers the prompts from the page content', async () => {
		const result = await clip({ html, url, template, documentParser: parser, keepPromptVariables: true });

		expect(promptContextOf(result.variables)).toContain('Body text for the prompts.');
		expect(promptContextOf({ '{{content}}': 'Markdown', '{{fullHtml}}': '<p>raw</p>' })).toBe('Markdown');
		expect(promptContextOf({ '{{content}}': '', '{{fullHtml}}': '<p>raw</p>' })).toBe('<p>raw</p>');
	});

	test('fills placeholders in properties, the note name and the content', async () => {
		const { result, filled } = await clipAndFill({
			prompt_1: 'Ex',
			prompt_2: 'He said "hi"',
			prompt_3: 'one, two',
			prompt_4: 'daily'
		});

		// The frontmatter escaped the placeholders, so filling `fullContent` alone could not reach them.
		expect(result.frontmatter).toContain('summary: "{{\\"y\\"}}"');
		expect(filled.fullContent).toBe([
			'---',
			'summary: "He said \\"hi\\""',
			'tags:',
			'  - "one"',
			'  - "two"',
			'site: "example.com"',
			'---',
			'Body: Ex'
		].join('\n'));
		expect(filled.noteName).toBe('DAILY note');
	});

	test('formats number and checkbox properties after they are filled', async () => {
		const typed: Template = {
			...baseTemplate,
			noteNameFormat: '{{domain}}',
			noteContentFormat: 'Body',
			properties: [
				{ id: 'p1', name: 'count', value: '{{"Top 3 things"}}', type: 'number' },
				{ id: 'p2', name: 'done', value: '{{"Is it done?"}}', type: 'checkbox' },
				{ id: 'p3', name: 'words', value: '{{"Word count"}}', type: 'number' }
			]
		};

		const { result, filled } = await clipAndFill({ prompt_1: '7', prompt_2: 'true', prompt_3: 'about 1200 words' }, typed);

		// Kept for the fill, not formatted into `3` and `false` before it.
		expect(result.properties.map(property => property.value))
			.toEqual(['{{"Top 3 things"}}', '{{"Is it done?"}}', '{{"Word count"}}']);
		expect(filled.fullContent).toBe(['---', 'count: 7', 'done: true', 'words: 1200', '---', 'Body'].join('\n'));
	});

	test('keeps the clip as it is where nothing was asked', async () => {
		const plain = { ...template, properties: [], noteNameFormat: '{{domain}}' };
		const result = await clip({ html, url, template: plain, documentParser: parser, keepPromptVariables: true });

		expect(fillPromptResponses(
			{ ...result, template: plain },
			[{ key: 'prompt_1', prompt: 'x', filters: '' }],
			{ prompt_1: 'Ex' },
			url
		)).toEqual({ fullContent: 'Body: Ex', noteName: 'example.com' });
	});
});
