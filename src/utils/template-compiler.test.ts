import { describe, expect, test } from 'vitest';
import { compileTemplate } from './template-compiler';

const variables = { '{{title}}': 'Page title' };

function compile(text: string, options?: Parameters<typeof compileTemplate>[4]): Promise<string> {
	return compileTemplate(0, text, variables, 'https://example.com/page', options);
}

describe('prompt variables in compileTemplate', () => {
	test('are dropped by default and with keepPromptVariables false', async () => {
		await expect(compile('{{title}}: {{"x"}} and {{prompt:"y"}}.')).resolves.toBe('Page title:  and .');
		await expect(compile('{{"x"}}', { keepPromptVariables: false })).resolves.toBe('');
	});

	test('are kept with keepPromptVariables, next to compiled variables', async () => {
		await expect(compile('{{title}}: {{"x"}} and {{"y"}}.', { keepPromptVariables: true }))
			.resolves.toBe('Page title: {{"x"}} and {{"y"}}.');
	});

	test('keep their filters unapplied when kept', async () => {
		await expect(compile('{{"x"|upper}} {{"Tags"|split:","|join:" "}}', { keepPromptVariables: true }))
			.resolves.toBe('{{"x"|upper}} {{"Tags"|split:","|join:" "}}');
	});

	test('keep multi-line prompt text when kept', async () => {
		await expect(compile('{{"line one\nline two"}}', { keepPromptVariables: true }))
			.resolves.toBe('{{"line one\nline two"}}');
	});
});
