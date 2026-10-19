// Pure language checks behind the Reader's Japanese readings and explanation kinds.

export const JAPANESE_KANJI = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々]/;
const JAPANESE_KANA = /[\u3040-\u30FF]/;
const JAPANESE_LANGUAGE_TOKEN = /(^|[-_])(?:ja|jpn)(?=$|[-_])/i;

export function isJapaneseTranscript(texts: string[], language?: string): boolean {
	const normalizedLanguage = language?.trim();
	if (normalizedLanguage) return JAPANESE_LANGUAGE_TOKEN.test(normalizedLanguage);
	return texts.some(text => JAPANESE_KANA.test(text));
}

export function shouldOfferJapaneseReadings(texts: string[], language?: string): boolean {
	if (!texts.some(text => text.trim())) return false;
	return !isJapaneseTranscript(texts, language)
		|| texts.some(text => JAPANESE_KANJI.test(text));
}

export function isSingleWord(text: string): boolean {
	const normalized = text.trim();
	if (!normalized || normalized.length > 80 || /\s/.test(normalized)) return false;
	if (/[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々]/.test(normalized)) {
		return Array.from(normalized).length <= 8
			&& !/[。！？、，,.!?]|(?:です|ます|でした|ません|でしょう|だった)$/.test(normalized);
	}
	return true;
}
