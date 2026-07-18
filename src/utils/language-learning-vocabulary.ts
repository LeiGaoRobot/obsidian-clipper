import browser from './browser-polyfill';
import type { LearningSelection, LearningVocabularyEntry } from './language-learning';
import { copyToClipboard } from './clipboard-utils';
import { saveToObsidian } from './obsidian-note-creator';
import { loadSettings } from './storage-utils';

const MAX_VOCABULARY_ENTRIES = 500;
const VOCABULARY_STORAGE_KEY = 'languageLearningVocabularyV1';

function vocabularyId(selection: LearningSelection, responseLanguage: string): string {
	const source = JSON.stringify([selection.kind, selection.text, selection.context, responseLanguage]);
	let hash = 2166136261;
	for (let index = 0; index < source.length; index += 1) {
		hash ^= source.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return `vocabulary-${(hash >>> 0).toString(36)}`;
}

function isVocabularyEntry(value: unknown): value is LearningVocabularyEntry {
	if (!value || typeof value !== 'object') return false;
	const entry = value as Partial<LearningVocabularyEntry>;
	return typeof entry.id === 'string'
		&& (entry.kind === 'word' || entry.kind === 'sentence')
		&& typeof entry.text === 'string'
		&& typeof entry.context === 'string'
		&& typeof entry.explanation === 'string'
		&& typeof entry.responseLanguage === 'string'
		&& typeof entry.createdAt === 'number';
}

async function loadVocabulary(): Promise<LearningVocabularyEntry[]> {
	const result = await browser.storage.local.get(VOCABULARY_STORAGE_KEY) as Record<string, unknown>;
	const entries = result[VOCABULARY_STORAGE_KEY];
	return Array.isArray(entries) ? entries.filter(isVocabularyEntry) : [];
}

async function storeVocabulary(entries: LearningVocabularyEntry[]): Promise<void> {
	await browser.storage.local.set({
		[VOCABULARY_STORAGE_KEY]: [...entries]
			.sort((left, right) => right.createdAt - left.createdAt)
			.slice(0, MAX_VOCABULARY_ENTRIES)
	});
}

async function getResponseLanguage(): Promise<string> {
	const settings = await loadSettings();
	return settings.readerSettings.learningResponseLanguage.trim()
		|| navigator.language
		|| 'English';
}

export const configuredLanguageLearningVocabulary = {
	async isVocabularyFavorite(selection: LearningSelection): Promise<boolean> {
		const id = vocabularyId(selection, await getResponseLanguage());
		return (await loadVocabulary()).some(entry => entry.id === id);
	},

	async toggleVocabularyFavorite(
		selection: LearningSelection,
		explanation: string
	): Promise<boolean> {
		const responseLanguage = await getResponseLanguage();
		const id = vocabularyId(selection, responseLanguage);
		const entries = await loadVocabulary();
		const existingIndex = entries.findIndex(entry => entry.id === id);
		if (existingIndex >= 0) {
			entries.splice(existingIndex, 1);
			await storeVocabulary(entries);
			return false;
		}
		entries.unshift({
			...selection,
			id,
			explanation,
			responseLanguage,
			createdAt: Date.now()
		});
		await storeVocabulary(entries);
		return true;
	},

	async listVocabulary(): Promise<LearningVocabularyEntry[]> {
		return loadVocabulary();
	},

	async removeVocabulary(id: string): Promise<void> {
		const entries = await loadVocabulary();
		await storeVocabulary(entries.filter(entry => entry.id !== id));
	},

	async copyLearningText(text: string): Promise<boolean> {
		return copyToClipboard(text);
	},

	async saveVocabularyToObsidian(
		selection: LearningSelection,
		explanation: string
	): Promise<void> {
		const settings = await loadSettings();
		const content = [
			`# ${selection.text}`,
			'',
			`> ${selection.context}`,
			'',
			explanation
		].join('\n');
		await saveToObsidian(
			content,
			selection.text,
			'Language Learning',
			settings.vaults[0] || '',
			'create'
		);
	}
};
