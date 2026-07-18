import { describe, expect, test } from 'vitest';
import {
	applyJapaneseReadingDictionary,
	resolveJapaneseReadingsFromDictionary
} from './japanese-reading-dictionary';

const dictionary = [
	{ surface: '日本語', reading: 'にほんご', updatedAt: 2 },
	{ surface: '勉強', reading: 'べんきょう', updatedAt: 1 }
];

describe('Japanese reading dictionary', () => {
	test('resolves complete segments locally and reports only unresolved segments', () => {
		const result = resolveJapaneseReadingsFromDictionary(
			['私は日本語を勉強します。', '漢字です。', 'かなだけ。'],
			dictionary
		);

		expect(result.unresolvedIndexes).toEqual([0, 1]);
		expect(result.readings[2]).toEqual([{ text: 'かなだけ。', reading: '' }]);
	});

	test('skips AI when every kanji occurrence has a local reading', () => {
		const result = resolveJapaneseReadingsFromDictionary(
			['日本語を勉強します。'],
			dictionary
		);

		expect(result.unresolvedIndexes).toEqual([]);
		expect(result.readings[0]).toEqual([
			{ text: '日本語', reading: 'にほんご' },
			{ text: 'を', reading: '' },
			{ text: '勉強', reading: 'べんきょう' },
			{ text: 'します。', reading: '' }
		]);
	});

	test('overrides and splits model tokens with personal readings', () => {
		const readings = applyJapaneseReadingDictionary(
			[[{ text: '日本語の勉強', reading: 'にほんごのべんきょう' }]],
			dictionary
		);

		expect(readings[0]).toEqual([
			{ text: '日本語', reading: 'にほんご' },
			{ text: 'の', reading: '' },
			{ text: '勉強', reading: 'べんきょう' }
		]);
	});

	test('applies one personal reading across multiple model tokens', () => {
		const readings = applyJapaneseReadingDictionary(
			[[{ text: '日本', reading: 'にほん' }, { text: '語', reading: 'ご' }]],
			[{ surface: '日本語', reading: 'にっぽんご', updatedAt: 3 }]
		);

		expect(readings[0]).toEqual([{ text: '日本語', reading: 'にっぽんご' }]);
	});

	test('keeps the remaining model reading when an override shares its token', () => {
		const readings = applyJapaneseReadingDictionary(
			[[{ text: '日本語漢字', reading: 'にほんごかんじ' }]],
			[{ surface: '日本語', reading: 'にっぽんご', updatedAt: 3 }]
		);

		expect(readings[0]).toEqual([
			{ text: '日本語', reading: 'にっぽんご' },
			{ text: '漢字', reading: 'かんじ' }
		]);
	});
});
