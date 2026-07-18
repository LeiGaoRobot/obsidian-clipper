// @vitest-environment jsdom

import { describe, expect, test, vi } from 'vitest';
import { renderLanguageLearningCenter } from './language-learning-center';

const vocabulary = [
	{
		id: 'word-1',
		kind: 'word' as const,
		text: 'encounter',
		context: 'An encounter.',
		explanation: '相遇',
		responseLanguage: 'Chinese',
		createdAt: 2
	},
	{
		id: 'sentence-1',
		kind: 'sentence' as const,
		text: 'How are you?',
		context: 'How are you?',
		explanation: '你好吗？',
		responseLanguage: 'Chinese',
		createdAt: 1
	}
];

describe('Language Learning Center', () => {
	test('searches, filters, selects, and removes vocabulary in bulk', async () => {
		document.body.innerHTML = '<div id="center"></div>';
		const removeVocabularyMany = vi.fn().mockResolvedValue(undefined);
		const controller = renderLanguageLearningCenter({
			doc: document,
			container: document.getElementById('center') as HTMLElement,
			tools: {
				listVocabulary: vi.fn().mockResolvedValue(vocabulary),
				removeVocabularyMany,
				listJapaneseReadingDictionary: vi.fn().mockResolvedValue([])
			}
		});
		await controller.ready;

		const search = document.querySelector('.language-learning-center-search') as HTMLInputElement;
		search.value = 'encounter';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		expect(document.querySelectorAll('.language-learning-center-entry')).toHaveLength(1);

		const checkbox = document.querySelector('.language-learning-center-entry input') as HTMLInputElement;
		checkbox.click();
		(document.querySelector('.language-learning-center-remove-selected') as HTMLButtonElement).click();
		await Promise.resolve();
		await Promise.resolve();

		expect(removeVocabularyMany).toHaveBeenCalledWith(['word-1']);
	});

	test('adds a personal Japanese reading from the readings tab', async () => {
		document.body.innerHTML = '<div id="center"></div>';
		const saveJapaneseReadingOverride = vi.fn().mockResolvedValue(undefined);
		const controller = renderLanguageLearningCenter({
			doc: document,
			container: document.getElementById('center') as HTMLElement,
			tools: {
				listVocabulary: vi.fn().mockResolvedValue([]),
				listJapaneseReadingDictionary: vi.fn().mockResolvedValue([]),
				saveJapaneseReadingOverride
			}
		});
		await controller.ready;
		(document.querySelector('[data-learning-center-tab="readings"]') as HTMLButtonElement).click();
		const surface = document.querySelector('.language-learning-center-surface') as HTMLInputElement;
		const reading = document.querySelector('.language-learning-center-reading') as HTMLInputElement;
		surface.value = '会話';
		reading.value = 'かいわ';
		(document.querySelector('.language-learning-center-add-reading') as HTMLButtonElement).click();
		await Promise.resolve();
		await Promise.resolve();

		expect(saveJapaneseReadingOverride).toHaveBeenCalledWith('会話', 'かいわ');
	});

	test('rejects synthetic page events that could open Obsidian', async () => {
		document.body.innerHTML = '<div id="center"></div>';
		const saveVocabularyToObsidian = vi.fn().mockResolvedValue(undefined);
		const controller = renderLanguageLearningCenter({
			doc: document,
			container: document.getElementById('center') as HTMLElement,
			tools: {
				listVocabulary: vi.fn().mockResolvedValue(vocabulary),
				listJapaneseReadingDictionary: vi.fn().mockResolvedValue([]),
				saveVocabularyToObsidian
			}
		});
		await controller.ready;

		(document.querySelector('.language-learning-vocabulary-save') as HTMLButtonElement).click();
		const checkbox = document.querySelector('.language-learning-center-entry input') as HTMLInputElement;
		checkbox.click();
		(document.querySelector('.language-learning-center-save-selected') as HTMLButtonElement).click();
		await Promise.resolve();

		expect(saveVocabularyToObsidian).not.toHaveBeenCalled();
	});
});
