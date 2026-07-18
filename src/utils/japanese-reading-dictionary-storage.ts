import browser from './browser-polyfill';
import type { JapaneseReadingDictionaryEntry } from './japanese-reading-dictionary';

const STORAGE_KEY = 'japaneseReadingDictionaryV1';
const MAX_ENTRIES = 1000;
const JAPANESE_KANJI = /[㐀-䶿一-鿿豈-﫿々]/;

function isEntry(value: unknown): value is JapaneseReadingDictionaryEntry {
	if (!value || typeof value !== 'object') return false;
	const entry = value as Partial<JapaneseReadingDictionaryEntry>;
	return typeof entry.surface === 'string'
		&& JAPANESE_KANJI.test(entry.surface)
		&& typeof entry.reading === 'string'
		&& Boolean(entry.reading.trim())
		&& typeof entry.updatedAt === 'number';
}

async function store(entries: JapaneseReadingDictionaryEntry[]): Promise<void> {
	await browser.storage.local.set({
		[STORAGE_KEY]: entries
			.filter(isEntry)
			.sort((left, right) => right.updatedAt - left.updatedAt)
			.slice(0, MAX_ENTRIES)
	});
}

export async function listJapaneseReadingDictionary(): Promise<JapaneseReadingDictionaryEntry[]> {
	const stored = await browser.storage.local.get(STORAGE_KEY) as Record<string, unknown>;
	const entries = stored[STORAGE_KEY];
	return Array.isArray(entries) ? entries.filter(isEntry) : [];
}

export const configuredJapaneseReadingDictionary = {
	listJapaneseReadingDictionary,

	async saveJapaneseReadingOverride(surface: string, reading: string): Promise<void> {
		const normalizedSurface = surface.trim();
		const normalizedReading = reading.trim();
		if (!JAPANESE_KANJI.test(normalizedSurface) || !normalizedReading) return;
		const entries = await listJapaneseReadingDictionary();
		const next = entries.filter(entry => entry.surface !== normalizedSurface);
		next.unshift({ surface: normalizedSurface, reading: normalizedReading, updatedAt: Date.now() });
		await store(next);
	},

	async removeJapaneseReadingOverride(surface: string): Promise<void> {
		await store((await listJapaneseReadingDictionary()).filter(entry => entry.surface !== surface));
	},

	async clearJapaneseReadingDictionary(): Promise<void> {
		await store([]);
	},

	async exportJapaneseReadingDictionary(): Promise<string> {
		return JSON.stringify({ version: 1, entries: await listJapaneseReadingDictionary() }, null, 2);
	},

	async importJapaneseReadingDictionary(json: string): Promise<number> {
		const parsed = JSON.parse(json) as { entries?: unknown } | unknown[];
		const candidates = Array.isArray(parsed) ? parsed : parsed.entries;
		if (!Array.isArray(candidates)) throw new Error('Invalid Japanese reading dictionary.');
		const imported = candidates.filter(isEntry);
		const bySurface = new Map((await listJapaneseReadingDictionary()).map(entry => [entry.surface, entry]));
		for (const entry of imported) bySurface.set(entry.surface, entry);
		await store([...bySurface.values()]);
		return imported.length;
	}
};
