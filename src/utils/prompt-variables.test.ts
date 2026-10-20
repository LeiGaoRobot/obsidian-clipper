import { describe, expect, test } from 'vitest';
import { createPromptVariableRegex, PROMPT_VARIABLE_PATTERN, stringifyValue } from './prompt-variables';

function matches(text: string): Array<[string, string | undefined]> {
	return Array.from(text.matchAll(createPromptVariableRegex()), match => [match[1], match[2]]);
}

describe('PROMPT_VARIABLE_PATTERN', () => {
	test('matches both prompt forms with the prompt text and the filter chain', () => {
		expect(matches('{{"Summarize"}} {{prompt:"Tags"|split:","|join:" "}}')).toEqual([
			['Summarize', undefined],
			['Tags', '|split:","|join:" "']
		]);
	});

	test('matches prompt text and filters across lines', () => {
		expect(matches('{{"line one\nline two"|replace:("a\nb":"c")}}')).toEqual([
			['line one\nline two', '|replace:("a\nb":"c")']
		]);
	});

	test('ignores other variables', () => {
		expect(matches('{{title}} {{selector:h1}} {{schema:@Article:name}}')).toEqual([]);
		expect(PROMPT_VARIABLE_PATTERN.test('{{title|upper}}')).toBe(false);
	});

	test('is not global, and each created regex scans from the start', () => {
		expect(PROMPT_VARIABLE_PATTERN.global).toBe(false);
		const first = createPromptVariableRegex();
		first.exec('{{"a"}} {{"b"}}');
		expect(createPromptVariableRegex().lastIndex).toBe(0);
		expect(createPromptVariableRegex()).not.toBe(first);
	});
});

describe('stringifyValue', () => {
	test('keeps strings, empties nothing, and indents structured values as JSON', () => {
		expect(stringifyValue('text')).toBe('text');
		expect(stringifyValue(null)).toBe('');
		expect(stringifyValue(undefined)).toBe('');
		expect(stringifyValue(['a', 'b'])).toBe('[\n  "a",\n  "b"\n]');
		expect(stringifyValue({ a: 1 })).toBe('{\n  "a": 1\n}');
		expect(stringifyValue(3)).toBe('3');
	});

	test('falls back to String for values JSON cannot write', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(stringifyValue(circular)).toBe('[object Object]');
		expect(stringifyValue(() => 1)).toBe('() => 1');
	});
});
