// @vitest-environment jsdom
// Tests for interpreter model variables ({{model}}, {{modelId}}, {{modelProvider}}).
// These are preserved through template compilation and filled in by the
// interpreter once a model has actually been used (issue #360).
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { compileTemplate } from './template-compiler';
import { replaceModelVariables, type ModelVariableValues } from './interpreter';

const values: ModelVariableValues = {
	model: 'Claude 5 Sonnet',
	modelId: 'claude-sonnet-5',
	modelProvider: 'Anthropic'
};
const keep = { keepPromptVariables: true };

describe('Model variables in templates', () => {
	test('are preserved through compilation when interpreter is enabled', async () => {
		const output = await compileTemplate(0, 'Summarized by {{model}} ({{modelId}}) from {{modelProvider}}', {}, 'https://example.com', keep);
		expect(output).toBe('Summarized by {{model}} ({{modelId}}) from {{modelProvider}}');
	});

	test('preserve their filter chains through compilation', async () => {
		const output = await compileTemplate(
			0,
			'{{model|lower|replace:" ":"-"}}',
			{},
			'https://example.com',
			keep,
		);
		expect(output).toBe('{{model|lower|replace:" ":"-"}}');
	});

	test('preserves prompt expressions for the interpreter', async () => {
		const output = await compileTemplate(
			0,
			'{{"Summarize this"|callout:("info","Summary",false)}}',
			{},
			'https://example.com',
			keep,
		);
		expect(output).toBe('{{"Summarize this"|callout:("info","Summary",false)}}');
	});

	test('normalizes whitespace before interpreter post-processing', async () => {
		const output = await compileTemplate(
			0,
			'{{ model }} / {{model | lower}} / {{ "Summarize this" | upper }}',
			{},
			'https://example.com',
			keep,
		);
		expect(output).toBe('{{model}} / {{model|lower}} / {{"Summarize this"|upper}}');
	});

	test('normalizes single-quoted prompts instead of rendering them immediately', async () => {
		const output = await compileTemplate(0, "{{'hello'|upper}}", {}, 'https://example.com', keep);
		expect(output).toBe('{{"hello"|upper}}');
	});

	test('preserves nested template syntax inside prompt text', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const output = await compileTemplate(
				0,
				'Head {{"Summarize {{title}} now"}} Tail',
				{},
				'https://example.com',
				keep,
			);
			expect(output).toBe('Head {{"Summarize {{title}} now"}} Tail');
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('are removed when prompt variables are not kept', async () => {
		const output = await compileTemplate(0, 'Summarized by {{model}}', {}, 'https://example.com');
		expect(output).toBe('Summarized by ');
	});
});

describe('replaceModelVariables', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	function addTextarea(id: string, value: string): HTMLTextAreaElement {
		const textarea = document.createElement('textarea');
		textarea.id = id;
		textarea.value = value;
		document.body.appendChild(textarea);
		return textarea;
	}

	test('replaces model variables in input fields', () => {
		const textarea = addTextarea('note-content-field', 'Summarized by {{model}} ({{modelId}}) from {{modelProvider}}');
		replaceModelVariables(values);
		expect(textarea.value).toBe('Summarized by Claude 5 Sonnet (claude-sonnet-5) from Anthropic');
	});

	test('applies filters to model variables', () => {
		const textarea = addTextarea('note-content-field', '{{model|lower|replace:" ":"-"}}');
		replaceModelVariables(values);
		expect(textarea.value).toBe('claude-5-sonnet');
	});

	test('replaces model variables after compilation normalizes whitespace', async () => {
		const compiled = await compileTemplate(0, '{{ model }} / {{model | lower}}', {}, 'https://example.com', keep);
		const textarea = addTextarea('note-content-field', compiled);
		replaceModelVariables(values);
		expect(textarea.value).toBe('Claude 5 Sonnet / claude 5 sonnet');
	});

	test('leaves other template syntax untouched', () => {
		const textarea = addTextarea('note-content-field', '{{model}} {{"a prompt"}} {{title}}');
		replaceModelVariables(values);
		expect(textarea.value).toBe('Claude 5 Sonnet {{"a prompt"}} {{title}}');
	});
});
