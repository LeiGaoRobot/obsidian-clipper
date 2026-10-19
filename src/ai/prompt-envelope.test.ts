import { describe, expect, test } from 'vitest';
import { buildEnvelopePayload, parseEnvelopeResponse } from './prompt-envelope';

const prompts = [
	{ key: 'prompt_1', prompt: 'Tags' },
	{ key: 'prompt_2', prompt: 'Summary' }
];

describe('prompt envelope', () => {
	test('serializes prompts by key', () => {
		expect(buildEnvelopePayload(prompts)).toBe('{"prompts":{"prompt_1":"Tags","prompt_2":"Summary"}}');
	});

	test('maps envelope responses back to prompts', () => {
		const result = parseEnvelopeResponse(
			'{"prompts_responses":{"prompt_1":"a, b","prompt_2":"- one\\n- two"}}',
			prompts
		);
		expect(result.promptResponses).toEqual([
			{ key: 'prompt_1', prompt: 'Tags', user_response: 'a, b' },
			{ key: 'prompt_2', prompt: 'Summary', user_response: '- one\n- two' }
		]);
	});

	test('recovers an envelope wrapped in prose', () => {
		const result = parseEnvelopeResponse('Sure! {"prompts_responses":{"prompt_1":"x","prompt_2":"y"}} Done.', prompts);
		expect(result.promptResponses.map(item => item.user_response)).toEqual(['x', 'y']);
	});

	test('returns no responses when there is no envelope', () => {
		expect(parseEnvelopeResponse('nothing here', prompts).promptResponses).toEqual([]);
	});
});
