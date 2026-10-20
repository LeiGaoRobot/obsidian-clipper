import { describe, expect, test } from 'vitest';
import { isCancellation, raceWithRequestCancellation, throwIfRequestAborted } from './abort';
import { AiError } from './errors';

function abortError(): Error {
	const error = new Error('The operation was aborted.');
	error.name = 'AbortError';
	return error;
}

describe('throwIfRequestAborted', () => {
	test('does nothing without a signal or before abort', () => {
		expect(() => throwIfRequestAborted()).not.toThrow();
		expect(() => throwIfRequestAborted(new AbortController().signal)).not.toThrow();
	});

	test('throws AiError cancelled after abort', () => {
		const controller = new AbortController();
		controller.abort();
		let thrown: unknown;
		try {
			throwIfRequestAborted(controller.signal);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AiError);
		expect(thrown).toMatchObject({ code: 'cancelled' });
	});
});

describe('isCancellation', () => {
	test.each([
		[new AiError('cancelled'), true],
		[abortError(), true],
		[new AiError('timeout'), false],
		[Object.assign(new Error('The request was cancelled.'), { name: 'RequestCancelledError' }), false],
		[new Error('The request was cancelled.'), false],
		[{ name: 'AbortError' }, false],
		['cancelled', false],
		[undefined, false]
	])('%s → %s', (error, expected) => {
		expect(isCancellation(error)).toBe(expected);
	});
});

describe('raceWithRequestCancellation', () => {
	test('returns the promise itself without a signal', () => {
		const promise = Promise.resolve('value');
		expect(raceWithRequestCancellation(promise)).toBe(promise);
	});

	test('rejects with AiError cancelled when the signal is already aborted', () => {
		const controller = new AbortController();
		controller.abort();
		expect(() => raceWithRequestCancellation(new Promise(() => {}), controller.signal))
			.toThrow(expect.objectContaining({ code: 'cancelled' }));
	});

	test('resolves and rejects with the promise before abort', async () => {
		const controller = new AbortController();
		await expect(raceWithRequestCancellation(Promise.resolve('value'), controller.signal)).resolves.toBe('value');
		const failure = new Error('host failed');
		await expect(raceWithRequestCancellation(Promise.reject(failure), controller.signal)).rejects.toBe(failure);
	});

	test('rejects with AiError cancelled on abort and ignores a later settlement', async () => {
		const controller = new AbortController();
		let resolve!: (value: string) => void;
		const race = raceWithRequestCancellation(new Promise<string>(done => { resolve = done; }), controller.signal);
		controller.abort();
		resolve('late');
		await expect(race).rejects.toBeInstanceOf(AiError);
		await expect(race).rejects.toMatchObject({ code: 'cancelled' });
	});
});
