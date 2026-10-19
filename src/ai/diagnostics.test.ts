import { describe, expect, test } from 'vitest';
import { createAiDiagnostics, decodeDiagnostics, MAX_DIAGNOSTIC_ENTRIES, sanitizeDiagnosticEntry } from './diagnostics';
import type { StorageAreaLike } from './job-store';
import type { AiDiagnosticEntry } from './types';

function memoryArea(): StorageAreaLike & { values: Map<string, unknown>; sets: number; failSets?: boolean } {
	const values = new Map<string, unknown>();
	const area = {
		values,
		sets: 0,
		failSets: false,
		async get(keys?: string | string[] | null) {
			const wanted = keys == null ? Array.from(values.keys()) : (Array.isArray(keys) ? keys : [keys]).filter(key => values.has(key));
			// A delay before every read makes unserialized read-modify-writes lose entries.
			await new Promise(resolve => setTimeout(resolve, 0));
			return Object.fromEntries(wanted.map(key => [key, JSON.parse(JSON.stringify(values.get(key)))]));
		},
		async set(entries: Record<string, unknown>) {
			if (area.failSets) throw new Error('QUOTA_BYTES quota exceeded');
			area.sets += 1;
			Object.entries(entries).forEach(([key, value]) => values.set(key, JSON.parse(JSON.stringify(value))));
		},
		async remove(keys: string | string[]) {
			(Array.isArray(keys) ? keys : [keys]).forEach(key => values.delete(key));
		}
	};
	return area;
}

function entry(index: number, overrides: Partial<AiDiagnosticEntry> = {}): AiDiagnosticEntry {
	return {
		at: 1000 + index,
		task: 'interpret',
		kind: 'openai-compatible',
		connectionId: 'openai',
		durationMs: index,
		outcome: 'ok',
		...overrides
	};
}

describe('AI diagnostics', () => {
	test('keeps the last 100 entries, newest last', async () => {
		const session = memoryArea();
		const diagnostics = createAiDiagnostics(session);
		for (let index = 0; index < MAX_DIAGNOSTIC_ENTRIES + 5; index += 1) void diagnostics.record(entry(index));
		const entries = await diagnostics.list();

		expect(MAX_DIAGNOSTIC_ENTRIES).toBe(100);
		expect(entries).toHaveLength(100);
		expect(entries[0].durationMs).toBe(5);
		expect(entries[99].durationMs).toBe(104);
		expect(session.values.get('ai_diagnostics')).toEqual({ v: 1, entries });
	});

	test('serializes concurrent writes so no entry is lost', async () => {
		const session = memoryArea();
		const diagnostics = createAiDiagnostics(session);
		await Promise.all([0, 1, 2, 3, 4].map(index => diagnostics.record(entry(index))));
		expect((await diagnostics.list()).map(item => item.durationMs)).toEqual([0, 1, 2, 3, 4]);
		expect(session.sets).toBe(5);
	});

	test('falls back to memory without storage.session, or after a failed write', async () => {
		const memory = createAiDiagnostics();
		await memory.record(entry(1));
		expect(await memory.list()).toEqual([entry(1)]);

		const session = memoryArea();
		session.failSets = true;
		const fallback = createAiDiagnostics(session);
		await expect(fallback.record(entry(2))).resolves.toBeUndefined();
		await fallback.record(entry(3));
		expect(await fallback.list()).toEqual([entry(2), entry(3)]);
	});

	test('entries carry no prompt, content, key, or job id fields', async () => {
		const diagnostics = createAiDiagnostics(memoryArea());
		await diagnostics.record({
			...entry(1, {
				task: 'translate',
				outcome: 'error',
				code: 'rate-limited',
				status: 429,
				structuredMode: 'json_schema',
				fallback: true,
				groups: 4,
				retries: 2
			}),
			prompt: 'Summarize',
			content: 'Page text',
			key: 'sk-secret',
			apiKey: 'sk-secret',
			jobId: 'job-1',
			detail: 'raw provider text'
		} as unknown as AiDiagnosticEntry);
		const [stored] = await diagnostics.list();

		expect(Object.keys(stored).sort()).toEqual([
			'at', 'code', 'connectionId', 'durationMs', 'fallback', 'groups', 'kind', 'outcome', 'retries', 'status', 'structuredMode', 'task'
		]);
		expect(JSON.stringify(stored)).not.toMatch(/sk-secret|Page text|Summarize|job-1|raw provider/);
	});

	test('drops invalid entries and clears', async () => {
		expect(sanitizeDiagnosticEntry({ ...entry(1), task: 'bogus' })).toBeUndefined();
		expect(sanitizeDiagnosticEntry({ ...entry(1), kind: 'gpt' })).toBeUndefined();
		expect(sanitizeDiagnosticEntry({ ...entry(1), connectionId: '' })).toBeUndefined();
		expect(sanitizeDiagnosticEntry({ ...entry(1), code: 'nope' })).toEqual(entry(1));
		expect(decodeDiagnostics({ v: 1, entries: [entry(1), { at: 'x' }, null] })).toEqual([entry(1)]);
		expect(decodeDiagnostics('corrupt')).toEqual([]);

		const session = memoryArea();
		const diagnostics = createAiDiagnostics(session);
		await diagnostics.record(entry(1, { task: 'test' }));
		await diagnostics.clear();
		expect(await diagnostics.list()).toEqual([]);
		expect(session.values.has('ai_diagnostics')).toBe(false);
	});
});
