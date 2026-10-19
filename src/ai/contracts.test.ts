import { describe, expect, test } from 'vitest';
import {
	outputSpec,
	parseJsonCandidates,
	parseOutput,
	renderCliPrompt,
	renderMessages,
	type JsonSchema
} from './contracts';

const interpret = {
	context: 'Page body',
	prompts: [{ key: 'prompt_1', prompt: 'Tags' }, { key: 'prompt_2', prompt: 'Summary' }]
};
const segments = [{ id: 3, text: '今日は' }, { id: 4, text: '雨です' }];
const translate = { instruction: 'Translate each transcript segment into English.', segments };
const reading = { instruction: 'Annotate every kanji with hiragana.', segments };

function expectStrict(schema: JsonSchema) {
	if (schema.type === 'object') {
		const properties = schema.properties as Record<string, JsonSchema>;
		expect(schema.additionalProperties).toBe(false);
		expect(schema.required).toEqual(Object.keys(properties));
		Object.values(properties).forEach(expectStrict);
	} else if (schema.type === 'array') {
		expectStrict(schema.items as JsonSchema);
	}
}

describe('renderMessages', () => {
	test('asks interpret for a bare object keyed by prompt key, with no envelope', () => {
		const { system, user } = renderMessages('interpret', interpret);
		expect(system).toContain('keys are exactly: prompt_1, prompt_2');
		expect(system).not.toContain('prompts_responses');
		expect(user).toContain('Page body');
		expect(user).toContain('"prompt_2": "Summary"');
	});

	test('sends text tasks the instruction as system and the content as user', () => {
		expect(renderMessages('edit', { instruction: 'Fix grammar.', content: '# Note' })).toEqual({
			system: 'Fix grammar.\nReply with the result only, without an introduction or closing remarks.',
			user: '# Note'
		});
	});

	test('sends transcript segments as JSON with their stable ids', () => {
		const { system, user } = renderMessages('translate', translate);
		expect(system.startsWith('Translate each transcript segment into English.')).toBe(true);
		expect(system).toContain('{"translations":[{"id":0,"text":"…"}]}');
		expect(JSON.parse(user)).toEqual({ segments });
		expect(renderMessages('reading', reading).system).toContain('"tokens":[{"text":"…","reading":"…"}]');
	});

	test('joins system and user for CLIs', () => {
		const { system, user } = renderMessages('interpret', interpret);
		expect(renderCliPrompt('interpret', interpret)).toBe(`${system}\n\n${user}`);
	});
});

describe('outputSpec', () => {
	test('gives JSON tasks strict-subset schemas and text tasks none', () => {
		const interpretSpec = outputSpec('interpret', interpret);
		expect(interpretSpec?.schema).toEqual({
			type: 'object',
			properties: { prompt_1: { type: 'string' }, prompt_2: { type: 'string' } },
			required: ['prompt_1', 'prompt_2'],
			additionalProperties: false
		});
		for (const spec of [interpretSpec, outputSpec('translate', translate), outputSpec('reading', reading)]) {
			expect(spec?.name).toMatch(/^[a-z_]+$/);
			expectStrict(spec!.schema);
		}
		expect(outputSpec('edit', { instruction: 'x', content: 'y' })).toBeUndefined();
		expect(outputSpec('explain', { instruction: 'x', content: 'y' })).toBeUndefined();
	});
});

describe('parseJsonCandidates', () => {
	test('reads plain, fenced, and prose-wrapped JSON', () => {
		expect(parseJsonCandidates('{"a":1}')).toEqual([{ a: 1 }]);
		expect(parseJsonCandidates('```json\n{"a":1}\n```')).toEqual([{ a: 1 }]);
		expect(parseJsonCandidates('Sure! {"a":"}"} done {"b":2}')).toEqual([{ a: '}' }, { b: 2 }]);
		expect(parseJsonCandidates('no json')).toEqual([]);
	});
});

describe('parseOutput', () => {
	test('returns interpret responses by key and stringifies non-string values', () => {
		expect(parseOutput('interpret', interpret, '{"prompt_1":"a, b","prompt_2":["x","y"]}')).toEqual({
			responses: { prompt_1: 'a, b', prompt_2: '[\n  "x",\n  "y"\n]' },
			missing: []
		});
	});

	test('skips an unrelated object before the answer', () => {
		expect(parseOutput('interpret', interpret, 'Plan: {"step":1}\n{"prompt_1":"t","prompt_2":"s"}'))
			.toEqual({ responses: { prompt_1: 't', prompt_2: 's' }, missing: [] });
	});

	test('keeps a partial interpret answer and lists the missing keys in prompt order', () => {
		const three = { ...interpret, prompts: [...interpret.prompts, { key: 'prompt_3', prompt: 'Title' }] };
		expect(parseOutput('interpret', three, '{"prompt_2":"s","extra":"x"}'))
			.toEqual({ responses: { prompt_2: 's' }, missing: ['prompt_1', 'prompt_3'] });
	});

	test('prefers the object that answers the most prompts', () => {
		expect(parseOutput('interpret', interpret, '{"prompt_1":"draft"} then {"prompt_1":"t","prompt_2":"s"}'))
			.toEqual({ responses: { prompt_1: 't', prompt_2: 's' }, missing: [] });
		expect(parseOutput('interpret', interpret, '{"prompt_1":"first"} {"prompt_2":"second"}'))
			.toEqual({ responses: { prompt_1: 'first' }, missing: ['prompt_2'] });
	});

	test('reports a reply that answers no prompt or has no JSON as a bad response', () => {
		expect(() => parseOutput('interpret', interpret, 'I cannot help'))
			.toThrow(expect.objectContaining({ code: 'bad-response' }));
		expect(() => parseOutput('interpret', interpret, '{"other":1}'))
			.toThrow(expect.objectContaining({ code: 'bad-response' }));
	});

	test('trims text and rejects an empty reply', () => {
		expect(parseOutput('explain', { instruction: 'x', content: 'y' }, '  Meaning\n')).toBe('Meaning');
		expect(() => parseOutput('edit', { instruction: 'x', content: 'y' }, '  '))
			.toThrow(expect.objectContaining({ code: 'bad-response' }));
	});

	test('keeps only requested, first-seen, non-empty translations', () => {
		const reply = JSON.stringify({
			translations: [
				{ id: 4, text: ' It is raining ' },
				{ id: 9, text: 'unrequested' },
				{ id: 4, text: 'duplicate' },
				{ id: 3, text: '' },
				{ id: '3', text: 'Today' }
			]
		});
		expect(parseOutput('translate', translate, reply)).toEqual([
			{ id: 4, text: 'It is raining' },
			{ id: 3, text: 'Today' }
		]);
	});

	test('accepts a bare translations array and rejects a reply with no usable item', () => {
		expect(parseOutput('translate', translate, '[{"id":3,"text":"Today"}]')).toEqual([{ id: 3, text: 'Today' }]);
		expect(() => parseOutput('translate', translate, '{"translations":[{"id":7,"text":"x"}]}'))
			.toThrow(expect.objectContaining({ code: 'bad-response' }));
		expect(() => parseOutput('translate', translate, 'nothing'))
			.toThrow(expect.objectContaining({ code: 'bad-response' }));
	});

	test('validates reading tokens per segment and accepts legacy tuples', () => {
		const reply = JSON.stringify({
			readings: [
				{ id: 3, tokens: [{ text: '今日', reading: 'きょう' }, { text: 'は', reading: '' }] },
				{ id: 4, tokens: [['雨', 'あめ'], ['です', '']] }
			]
		});
		expect(parseOutput('reading', reading, reply)).toEqual([
			{ id: 3, tokens: [{ text: '今日', reading: 'きょう' }, { text: 'は', reading: '' }] },
			{ id: 4, tokens: [{ text: '雨', reading: 'あめ' }, { text: 'です', reading: '' }] }
		]);
	});

	test('drops readings with malformed tokens', () => {
		const reply = JSON.stringify({
			readings: [
				{ id: 3, tokens: [{ text: '', reading: 'x' }] },
				{ id: 4, tokens: [{ text: '雨', reading: 'あめ' }] }
			]
		});
		expect(parseOutput('reading', reading, reply)).toEqual([{ id: 4, tokens: [{ text: '雨', reading: 'あめ' }] }]);
	});

	test('salvages complete items from a reply cut off by the output limit', () => {
		const cut = '{"readings":[{"id":3,"tokens":[{"text":"今日","reading":"きょう"},{"text":"は","reading":""}]},{"id":4,"tokens":[{"text":"雨';
		expect(parseOutput('reading', reading, cut)).toEqual([
			{ id: 3, tokens: [{ text: '今日', reading: 'きょう' }, { text: 'は', reading: '' }] }
		]);
		expect(parseOutput('translate', translate, '[{"id":3,"text":"Today"},{"id":4,"te'))
			.toEqual([{ id: 3, text: 'Today' }]);
	});

	test('prefers the answer over an echoed shape example', () => {
		const reply = 'Shape: {"translations":[{"id":3,"text":"…"}]}\nAnswer: {"translations":[{"id":3,"text":"Today"},{"id":4,"text":"Rain"}]}';
		expect(parseOutput('translate', translate, reply)).toEqual([{ id: 3, text: 'Today' }, { id: 4, text: 'Rain' }]);
	});

	test('rejects ids that are not integers or digit strings', () => {
		const reply = JSON.stringify({
			translations: [{ id: null, text: 'a' }, { id: true, text: 'b' }, { id: [4], text: 'c' }, { id: 3.5, text: 'd' }, { id: 4, text: 'Rain' }]
		});
		expect(parseOutput('translate', translate, reply)).toEqual([{ id: 4, text: 'Rain' }]);
		expect(() => parseOutput('translate', { ...translate, segments: [{ id: 0, text: 'x' }, { id: 1, text: 'y' }] },
			JSON.stringify({ translations: [{ id: null, text: 'a' }, { id: true, text: 'b' }] })))
			.toThrow(expect.objectContaining({ code: 'bad-response' }));
	});

	test('finds JSON after a stray quote in leading prose', () => {
		expect(parseOutput('interpret', interpret, 'He said "hi. {"prompt_1":"A","prompt_2":"B"}'))
			.toEqual({ responses: { prompt_1: 'A', prompt_2: 'B' }, missing: [] });
	});
});
