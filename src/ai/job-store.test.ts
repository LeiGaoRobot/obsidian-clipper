import { describe, expect, test } from 'vitest';
import {
	aiJobStorageKey,
	createAiJobStore,
	LEGACY_CHECKPOINT_KEY_PREFIX,
	MAX_JOB_RECORDS,
	type AiJobRecord,
	type AiJobStatus,
	type StorageAreaLike
} from './job-store';

function record(id: string, overrides: Partial<AiJobRecord> = {}): AiJobRecord {
	return {
		v: 1,
		id,
		task: 'translate',
		identity: { namespace: 'transcript-translation', scope: 'video:zh-CN' },
		segmentCount: 2,
		segmentHash: 'abc',
		status: 'completed',
		results: {},
		attempts: { requests: 0, retries: 0, splits: 0 },
		createdAt: 0,
		updatedAt: 0,
		...overrides
	};
}

interface FakeArea extends StorageAreaLike {
	values: Map<string, unknown>;
	calls: string[];
	/** Fails the next N `set` calls with a quota error. */
	failQuota: number;
}

// Mimics browser.storage.session: async, cloning, and yielding between operations.
function fakeArea(): FakeArea {
	const values = new Map<string, unknown>();
	const clone = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
	const area: FakeArea = {
		values,
		calls: [],
		failQuota: 0,
		async get(keys) {
			area.calls.push(`get:${keys === null || keys === undefined ? '*' : String(keys)}`);
			await new Promise(resolve => setTimeout(resolve, 0));
			const wanted = keys === null || keys === undefined
				? Array.from(values.keys())
				: (Array.isArray(keys) ? keys : [keys]).filter(key => values.has(key));
			return Object.fromEntries(wanted.map(key => [key, clone(values.get(key))]));
		},
		async set(entries) {
			const keys = Object.keys(entries);
			area.calls.push(`set:${keys.join(',')}`);
			await new Promise(resolve => setTimeout(resolve, 0));
			if (area.failQuota > 0) {
				area.failQuota -= 1;
				throw new Error('Session storage quota bytes exceeded. Values were not stored.');
			}
			Object.entries(entries).forEach(([key, value]) => values.set(key, clone(value)));
		},
		async remove(keys) {
			const list = Array.isArray(keys) ? keys : [keys];
			area.calls.push(`remove:${list.join(',')}`);
			await Promise.resolve();
			list.forEach(key => values.delete(key));
		}
	};
	return area;
}

async function seed(area: FakeArea, records: AiJobRecord[]) {
	records.forEach(entry => area.values.set(aiJobStorageKey(entry.id), entry));
}

describe('createAiJobStore', () => {
	test('reads back a written record under the aiJob: key', async () => {
		const area = fakeArea();
		const store = createAiJobStore(area);
		const entry = record('job:translate:ns:1', { results: { 0: 'hola' } });
		await store.put(entry);
		expect(area.values.has('aiJob:job:translate:ns:1')).toBe(true);
		expect(await store.get(entry.id)).toEqual(entry);
		expect(await store.get('job:translate:ns:missing')).toBeUndefined();
	});

	test('applies concurrent puts on one job in call order', async () => {
		const area = fakeArea();
		const store = createAiJobStore(area);
		const id = 'job:translate:ns:1';
		const writes = [1, 2, 3, 4].map(count => store.put(record(id, {
			status: 'running',
			results: Object.fromEntries(Array.from({ length: count }, (_, index) => [index, `t${index}`])),
			updatedAt: count
		})));
		// A read queued behind the writes sees the last one.
		const read = store.get(id);
		await Promise.all(writes);
		expect((await read)?.updatedAt).toBe(4);
		expect(Object.keys((await store.get(id))!.results)).toEqual(['0', '1', '2', '3']);
		expect(area.calls.filter(call => call.startsWith('set:'))).toHaveLength(4);
	});

	test('keeps the queue of a job moving after a failed write', async () => {
		const area = fakeArea();
		const store = createAiJobStore(area);
		const set = area.set;
		area.set = async () => {
			area.set = set;
			throw new Error('disk on fire');
		};
		const first = store.put(record('a', { updatedAt: 1 }));
		const second = store.put(record('a', { updatedAt: 2 }));
		await expect(first).rejects.toThrow('disk on fire');
		await second;
		expect((await store.get('a'))?.updatedAt).toBe(2);
	});

	test('prunes to 20 records by updatedAt, skipping running records', async () => {
		const area = fakeArea();
		const store = createAiJobStore(area);
		const statuses: AiJobStatus[] = ['completed', 'incomplete', 'failed', 'cancelled'];
		// The two oldest records are running; they survive while non-running ones go.
		await seed(area, Array.from({ length: MAX_JOB_RECORDS }, (_, index) => record(`old-${index}`, {
			status: index < 2 ? 'running' : statuses[index % statuses.length],
			updatedAt: index
		})));
		await store.put(record('new-1', { updatedAt: 100 }));
		await store.put(record('new-2', { updatedAt: 101 }));
		const ids = (await store.list()).map(entry => entry.id).sort();
		expect(ids).toHaveLength(MAX_JOB_RECORDS);
		expect(ids).toEqual(expect.arrayContaining(['old-0', 'old-1', 'new-1', 'new-2']));
		expect(ids).not.toContain('old-2');
		expect(ids).not.toContain('old-3');
	});

	test('evicts the oldest running records only when more than 20 are running', async () => {
		const area = fakeArea();
		const store = createAiJobStore(area);
		await seed(area, Array.from({ length: MAX_JOB_RECORDS }, (_, index) => record(`run-${index}`, {
			status: 'running',
			updatedAt: index + 10
		})));
		await store.put(record('run-new', { status: 'running', updatedAt: 1 }));
		const ids = (await store.list()).map(entry => entry.id);
		expect(ids).toHaveLength(MAX_JOB_RECORDS);
		// The record just written is never its own eviction victim, even when it is the oldest.
		expect(ids).toContain('run-new');
		expect(ids).not.toContain('run-0');
	});

	test('prunes on the first write of a job, not on every checkpoint', async () => {
		const area = fakeArea();
		const store = createAiJobStore(area);
		await store.put(record('a', { status: 'running' }));
		await store.put(record('a', { status: 'running', updatedAt: 1 }));
		await store.put(record('a', { updatedAt: 2 }));
		expect(area.calls.filter(call => call === 'get:*')).toHaveLength(1);
	});

	test('evicts the oldest non-running record on a quota error and retries once', async () => {
		const area = fakeArea();
		const store = createAiJobStore(area);
		await seed(area, [
			record('running-old', { status: 'running', updatedAt: 1 }),
			record('done-old', { status: 'completed', updatedAt: 2 }),
			record('done-new', { status: 'failed', updatedAt: 3 })
		]);
		area.failQuota = 1;
		await store.put(record('big', { status: 'running', updatedAt: 10 }));
		expect(area.calls).toContain('remove:aiJob:done-old');
		const ids = (await store.list()).map(entry => entry.id).sort();
		expect(ids).toEqual(['big', 'done-new', 'running-old']);
	});

	test('rejects when the retry after eviction also exceeds the quota', async () => {
		const area = fakeArea();
		const store = createAiJobStore(area);
		await seed(area, [record('done', { updatedAt: 1 })]);
		area.failQuota = 2;
		await expect(store.put(record('big', { updatedAt: 10 }))).rejects.toThrow(/quota/);
		expect(area.calls.filter(call => call.startsWith('set:'))).toHaveLength(2);
	});

	test('rejects a quota error when only running records could be evicted', async () => {
		const area = fakeArea();
		const store = createAiJobStore(area);
		await seed(area, [record('running', { status: 'running' })]);
		area.failQuota = 1;
		await expect(store.put(record('big'))).rejects.toThrow(/quota/);
		expect(area.values.has(aiJobStorageKey('running'))).toBe(true);
	});

	test('falls back to memory without a storage area', async () => {
		const store = createAiJobStore();
		const entry = record('job:reading:japanese-readings:1', {
			task: 'reading',
			results: { 0: [{ text: '漢字', reading: 'かんじ' }] }
		});
		await store.put(entry);
		// Stored copies are isolated from later mutation by the caller.
		(entry.results[0] as { text: string; reading: string }[]).push({ text: 'x', reading: '' });
		expect((await store.get(entry.id))?.results[0]).toEqual([{ text: '漢字', reading: 'かんじ' }]);
		expect((await store.list()).map(item => item.id)).toEqual([entry.id]);
		await store.remove(entry.id);
		expect(await store.get(entry.id)).toBeUndefined();
	});

	test('lists only valid aiJob: records', async () => {
		const area = fakeArea();
		const store = createAiJobStore(area);
		await seed(area, [record('a'), record('b')]);
		area.values.set('aiJob:broken', { v: 2, id: 'broken' });
		area.values.set('ai_structured_output', {});
		area.values.set(aiJobStorageKey('mismatch'), record('other'));
		expect((await store.list()).map(entry => entry.id).sort()).toEqual(['a', 'b', 'other']);
		expect(await store.get('broken')).toBeUndefined();
		expect(await store.get('mismatch')).toBeUndefined();
	});

	test('removes a record after its queued writes', async () => {
		const area = fakeArea();
		const store = createAiJobStore(area);
		void store.put(record('a'));
		await store.remove('a');
		expect(area.values.has(aiJobStorageKey('a'))).toBe(false);
		expect(area.calls[area.calls.length - 1]).toBe('remove:aiJob:a');
	});

	test('removeLegacyCheckpoints removes only the old checkpoint prefix', async () => {
		const area = fakeArea();
		const store = createAiJobStore(area);
		await seed(area, [record('a')]);
		area.values.set(`${LEGACY_CHECKPOINT_KEY_PREFIX}japanese:1`, { id: 'x' });
		area.values.set(`${LEGACY_CHECKPOINT_KEY_PREFIX}translation:2`, { id: 'y' });
		area.values.set('languageLearningOther', 1);
		await store.removeLegacyCheckpoints();
		expect(Array.from(area.values.keys()).sort()).toEqual(['aiJob:a', 'languageLearningOther']);
		area.calls.length = 0;
		await store.removeLegacyCheckpoints();
		expect(area.calls).toEqual(['get:*']);
	});
});
