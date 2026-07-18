import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	get: vi.fn(),
	set: vi.fn(),
	remove: vi.fn()
}));

vi.mock('./browser-polyfill', () => ({
	default: {
		storage: {
			session: {
				get: mocks.get,
				set: mocks.set,
				remove: mocks.remove
			}
		}
	}
}));

import { createSessionTranscriptCheckpointStore } from './transcript-checkpoint-storage';

describe('Session transcript checkpoint storage', () => {
	beforeEach(() => {
		Object.keys(mocks.state).forEach(key => delete mocks.state[key]);
		mocks.get.mockReset();
		mocks.set.mockReset();
		mocks.remove.mockReset();
		mocks.get.mockImplementation(async (key?: string | null) => {
			if (key == null) return { ...mocks.state };
			return { [key]: mocks.state[key] };
		});
		mocks.set.mockImplementation(async (values: Record<string, unknown>) => {
			Object.assign(mocks.state, values);
		});
		mocks.remove.mockImplementation(async (keys: string | string[]) => {
			(Array.isArray(keys) ? keys : [keys]).forEach(key => delete mocks.state[key]);
		});
	});

	test('preserves concurrent checkpoints written by separate Reader tasks', async () => {
		const store = createSessionTranscriptCheckpointStore<string[]>(
			'translations',
			'Simplified Chinese',
			value => [...value]
		);

		await Promise.all([
			store.save(['First.'], ['第一段']),
			store.save(['Second.'], ['第二段'])
		]);

		await expect(store.load(['First.'])).resolves.toEqual(['第一段']);
		await expect(store.load(['Second.'])).resolves.toEqual(['第二段']);
	});

	test('clears larger checkpoints that overlap a regenerated range', async () => {
		const store = createSessionTranscriptCheckpointStore<string[]>(
			'japanese-readings',
			'shared',
			value => [...value]
		);
		await store.save(['First.', 'Second.'], ['one', 'two']);

		await store.clear(['First.']);

		await expect(store.load(['First.', 'Second.'])).resolves.toBeUndefined();
	});
});
