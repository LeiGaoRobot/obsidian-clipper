import { describe, expect, test } from 'vitest';
import { isJapaneseTranscript, isSingleWord, shouldOfferJapaneseReadings } from './japanese';

describe('Japanese transcript checks', () => {
	test.each([
		{ language: 'ja', texts: ['東京です。'], expected: true },
		{ language: 'ja-JP', texts: ['東京です。'], expected: true },
		{ language: 'ai-ja', texts: ['東京です。'], expected: true },
		{ language: 'ai-zh', texts: ['これは日本語です。'], expected: false },
		{ language: undefined, texts: ['これは日本語です。'], expected: true },
		{ language: undefined, texts: ['Hello world.'], expected: false },
		{ language: undefined, texts: ['東京'], expected: false }
	])('classifies transcript language from metadata before text fallback', ({ language, texts, expected }) => {
		expect(isJapaneseTranscript(texts, language)).toBe(expected);
	});

	test('offers Japanese readings for non-Japanese text and Japanese text with kanji', () => {
		expect(shouldOfferJapaneseReadings(['Hello world.'])).toBe(true);
		expect(shouldOfferJapaneseReadings(['日本語です。'])).toBe(true);
		expect(shouldOfferJapaneseReadings(['こんにちは。'])).toBe(false);
		expect(shouldOfferJapaneseReadings(['   '])).toBe(false);
	});

	test('treats short words as words and longer or punctuated text as sentences', () => {
		expect(isSingleWord('Hello')).toBe(true);
		expect(isSingleWord('Hello world')).toBe(false);
		expect(isSingleWord('日本語')).toBe(true);
		expect(isSingleWord('勉強します')).toBe(false);
		expect(isSingleWord('日本語を勉強します')).toBe(false);
		expect(isSingleWord('   ')).toBe(false);
	});
});
