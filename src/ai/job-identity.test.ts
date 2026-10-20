import { describe, expect, test } from 'vitest';
import { hashSegments, hasIndexIds, parseJobId, transcriptJobId } from './job-identity';

const identity = { namespace: 'transcript-translation', scope: 'video-1:zh-CN' };
const segments = (texts: string[]) => texts.map((text, id) => ({ id, text }));

describe('hashSegments', () => {
	test('is stable for equal input and sensitive to scope, text, and order', () => {
		const hash = hashSegments('s', ['a', 'b']);
		expect(hashSegments('s', ['a', 'b'])).toBe(hash);
		expect(hash).toMatch(/^[0-9a-z]+$/);
		expect(hashSegments('t', ['a', 'b'])).not.toBe(hash);
		expect(hashSegments('s', ['a', 'c'])).not.toBe(hash);
		expect(hashSegments('s', ['b', 'a'])).not.toBe(hash);
		// Segment boundaries are part of the input, not just the concatenated text.
		expect(hashSegments('s', ['ab'])).not.toBe(hashSegments('s', ['a', 'b']));
	});
});

describe('transcriptJobId', () => {
	test('builds job:task:namespace:hash', () => {
		const id = transcriptJobId('translate', identity, segments(['a', 'b']));
		expect(id).toBe(`job:translate:transcript-translation:${hashSegments(identity.scope, ['a', 'b'])}`);
		expect(transcriptJobId('translate', identity, segments(['a', 'b']))).toBe(id);
	});

	test('differs by task, scope, text, and order', () => {
		const id = transcriptJobId('translate', identity, segments(['a', 'b']));
		expect(transcriptJobId('reading', identity, segments(['a', 'b']))).not.toBe(id);
		expect(transcriptJobId('translate', { ...identity, scope: 'video-2:zh-CN' }, segments(['a', 'b']))).not.toBe(id);
		expect(transcriptJobId('translate', identity, segments(['a', 'B']))).not.toBe(id);
		expect(transcriptJobId('translate', identity, segments(['b', 'a']))).not.toBe(id);
	});

	test('requires every segment id to equal its index', () => {
		expect(hasIndexIds(segments(['a', 'b']))).toBe(true);
		expect(hasIndexIds([])).toBe(true);
		expect(hasIndexIds([{ id: 1, text: 'a' }])).toBe(false);
		expect(hasIndexIds([{ id: 0, text: 'a' }, { id: 0, text: 'b' }])).toBe(false);
		expect(() => transcriptJobId('reading', identity, [{ id: 0, text: 'a' }, { id: 2, text: 'b' }])).toThrow(RangeError);
	});

	test('stays within 200 characters for a 100-character namespace and scope', () => {
		const long = { namespace: 'n'.repeat(100), scope: 's'.repeat(100) };
		const id = transcriptJobId('translate', long, segments(Array.from({ length: 500 }, (_, index) => `line ${index}`)));
		expect(id.length).toBeLessThanOrEqual(200);
	});
});

describe('parseJobId', () => {
	test('round-trips a job id, including a namespace with colons', () => {
		for (const namespace of ['japanese-readings', 'a:b:c']) {
			const id = transcriptJobId('reading', { namespace, scope: 'shared' }, segments(['漢字']));
			expect(parseJobId(id)).toEqual({ task: 'reading', namespace, hash: hashSegments('shared', ['漢字']) });
		}
	});

	test.each([
		'',
		'job:',
		'job:translate',
		'job:translate:abc',
		'job:translate::abc',
		'job:explain:ns:abc',
		'job:translate:ns:ABC',
		'job:translate:ns:',
		'task:translate:ns:abc'
	])('rejects %j', id => {
		expect(parseJobId(id)).toBeUndefined();
	});
});
