// @vitest-environment jsdom
// The CLI clips through the API with linkedom; createMarkdownContent needs a DOM, as in the CLI.
import { describe, expect, test } from 'vitest';
import { parseHTML } from 'linkedom';
import { clip, type DocumentParser } from '../api';
import type { Template } from '../types/types';
import { buildExecutionPrompt, collectPromptVariables, parsePromptResponses, replacePromptVariables } from './cli-execution-contract';

const parser: DocumentParser = { parseFromString: html => parseHTML(html).document };
const html = '<html><head><title>Fixture</title></head><body><article><p>Body text for the prompts.</p></article></body></html>';
const template: Template = {
	id: 't',
	name: 'T',
	behavior: 'create',
	noteNameFormat: '{{title}}',
	path: '',
	noteContentFormat: 'Before {{"x"}} after {{"y"|upper}} end',
	properties: []
};

// What `src/cli.ts` does with `--execution-mode`: prompts come from the template, answers are
// written into the clipped content.
function promptsOf(value: Template) {
	return collectPromptVariables([value.noteContentFormat, ...value.properties.map(property => property.value), value.noteNameFormat]);
}

describe('CLI prompt execution over a clip', () => {
	test('the clipped content keeps the placeholders the execution prompt asks about', async () => {
		const result = await clip({ html, url: 'https://example.com/a', template, documentParser: parser, keepPromptVariables: true });
		const prompts = promptsOf(template);

		expect(result.content).toBe('Before {{"x"}} after {{"y"|upper}} end');
		expect(prompts).toEqual([
			{ key: 'prompt_1', prompt: 'x', filters: '' },
			{ key: 'prompt_2', prompt: 'y', filters: '|upper' }
		]);
		expect(buildExecutionPrompt('Body text', prompts)).toContain('"prompt_1": "x"');
		expect(replacePromptVariables(result.content, prompts, { prompt_1: 'Ex', prompt_2: 'why' }, 'https://example.com/a'))
			.toBe('Before Ex after WHY end');
	});

	test('without keepPromptVariables the clip drops them', async () => {
		const result = await clip({ html, url: 'https://example.com/a', template, documentParser: parser });

		expect(result.content).toBe('Before  after  end');
	});
});

describe('CLI execution contract', () => {
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

	test('rejects incomplete CLI responses', () => {
		expect(() => parsePromptResponses(
			'{"prompt_2":"other"}',
			[{ key: 'prompt_1', prompt: 'Summarize this', filters: '' }]
		)).toThrow('did not answer any of: prompt_1');
	});

	test('rejects a CLI response that leaves out some prompts', () => {
		expect(() => parsePromptResponses(
			'{"prompt_1":"done"}',
			[
				{ key: 'prompt_1', prompt: 'Summarize this', filters: '' },
				{ key: 'prompt_2', prompt: 'Tag this', filters: '' }
			]
		)).toThrow(expect.objectContaining({ code: 'incomplete', message: 'The reply did not answer: prompt_2.' }));
	});

	test('skips unrelated JSON emitted before the final response', () => {
		expect(parsePromptResponses(
			'{"type":"status"}\n{"prompt_1":"done"}',
			[{ key: 'prompt_1', prompt: 'Summarize this', filters: '' }]
		)).toEqual({ prompt_1: 'done' });
	});
});
