import { beforeEach, describe, expect, test } from 'vitest';
import {
	cacheExplanation,
	cacheJapaneseReadings,
	cacheJapaneseTranslations,
	cacheTranslations,
	clearTranscriptLanguageLearningCache,
	getCachedExplanation,
	getCachedJapaneseReadings,
	getCachedJapaneseTranslations,
	getCachedTranslations,
	removeCachedJapaneseReadings,
	removeCachedTranslations
} from './cache';

const selection = (text: string) => ({ kind: 'word' as const, text, context: `${text} context.` });

describe('Reader session caches', () => {
	beforeEach(() => clearTranscriptLanguageLearningCache());

	test('keys translations by response language and returns copies', () => {
		cacheTranslations(['Hello.'], 'Chinese', ['你好。']);

		const cached = getCachedTranslations(['Hello.'], 'Chinese');
		expect(cached).toEqual(['你好。']);
		expect(getCachedTranslations(['Hello.'], 'Japanese')).toBeNull();
		cached?.splice(0, 1, 'changed');
		expect(getCachedTranslations(['Hello.'], 'Chinese')).toEqual(['你好。']);

		removeCachedTranslations(['Hello.'], 'Chinese');
		expect(getCachedTranslations(['Hello.'], 'Chinese')).toBeNull();
	});

	test('returns deep copies of cached readings', () => {
		cacheJapaneseReadings(['東京'], [[{ text: '東京', reading: 'とうきょう' }]]);

		const cached = getCachedJapaneseReadings(['東京']);
		if (!cached) throw new Error('Missing cached readings');
		cached[0][0].reading = 'changed';
		expect(getCachedJapaneseReadings(['東京'])).toEqual([[{ text: '東京', reading: 'とうきょう' }]]);

		removeCachedJapaneseReadings(['東京']);
		expect(getCachedJapaneseReadings(['東京'])).toBeNull();
	});

	test('keys explanations by response language, kind, text, and context', () => {
		cacheExplanation(selection('Hello'), 'English', 'a greeting');

		expect(getCachedExplanation(selection('Hello'), 'English')).toBe('a greeting');
		expect(getCachedExplanation(selection('Hello'), 'Chinese')).toBeNull();
		expect(getCachedExplanation({ ...selection('Hello'), kind: 'sentence' }, 'English')).toBeNull();
		expect(getCachedExplanation({ ...selection('Hello'), context: 'Other.' }, 'English')).toBeNull();
	});

	test('keeps the 20 most recently written entries of each cache', () => {
		for (let index = 0; index < 21; index++) {
			cacheTranslations([`Line ${index}.`], 'English', [`译 ${index}`]);
			cacheJapaneseTranslations([`Line ${index}.`], [`訳 ${index}`]);
			cacheExplanation(selection(`Word${index}`), 'English', `explanation ${index}`);
		}

		expect(getCachedTranslations(['Line 0.'], 'English')).toBeNull();
		expect(getCachedTranslations(['Line 1.'], 'English')).toEqual(['译 1']);
		expect(getCachedJapaneseTranslations(['Line 0.'])).toBeNull();
		expect(getCachedJapaneseTranslations(['Line 20.'])).toEqual(['訳 20']);
		expect(getCachedExplanation(selection('Word0'), 'English')).toBeNull();
		expect(getCachedExplanation(selection('Word20'), 'English')).toBe('explanation 20');
	});

	test('rewriting an entry makes it the most recent', () => {
		for (let index = 0; index < 20; index++) {
			cacheTranslations([`Line ${index}.`], 'English', [`译 ${index}`]);
		}
		cacheTranslations(['Line 0.'], 'English', ['译 0 again']);
		cacheTranslations(['Line 20.'], 'English', ['译 20']);

		expect(getCachedTranslations(['Line 0.'], 'English')).toEqual(['译 0 again']);
		expect(getCachedTranslations(['Line 1.'], 'English')).toBeNull();
	});

	test('clearTranscriptLanguageLearningCache empties every cache', () => {
		cacheTranslations(['Hello.'], 'English', ['你好。']);
		cacheJapaneseTranslations(['Hello.'], ['こんにちは。']);
		cacheJapaneseReadings(['東京'], [[{ text: '東京', reading: 'とうきょう' }]]);
		cacheExplanation(selection('Hello'), 'English', 'a greeting');

		clearTranscriptLanguageLearningCache();

		expect(getCachedTranslations(['Hello.'], 'English')).toBeNull();
		expect(getCachedJapaneseTranslations(['Hello.'])).toBeNull();
		expect(getCachedJapaneseReadings(['東京'])).toBeNull();
		expect(getCachedExplanation(selection('Hello'), 'English')).toBeNull();
	});
});
