import type { LearningSelection, TranscriptReadingSegments } from '../../utils/language-learning';

// Session-local caches of completed Reader work, each a 20-entry LRU. They never start model work;
// they only let an explicit action or a Reader rewire reuse a result. Explanations are keyed by
// response language, selection kind, selected text, and context.

const MAX_SESSION_CACHE_ENTRIES = 20;
const japaneseReadingCache = new Map<string, TranscriptReadingSegments>();
const transcriptTranslationCache = new Map<string, string[]>();
const japaneseTranslationCache = new Map<string, string[]>();
const explanationCache = new Map<string, string>();

function getJapaneseReadingCacheKey(segments: string[]): string {
	return JSON.stringify(segments);
}

function getTranscriptTranslationCacheKey(segments: string[], responseLanguage: string): string {
	return JSON.stringify([responseLanguage, segments]);
}

export function cloneTranscriptReadings(readings: TranscriptReadingSegments): TranscriptReadingSegments {
	return readings.map(tokens => tokens.map(token => ({ ...token })));
}

export function getCachedJapaneseReadings(segments: string[]): TranscriptReadingSegments | null {
	const cached = japaneseReadingCache.get(getJapaneseReadingCacheKey(segments));
	return cached ? cloneTranscriptReadings(cached) : null;
}

export function cacheJapaneseReadings(segments: string[], readings: TranscriptReadingSegments): void {
	const key = getJapaneseReadingCacheKey(segments);
	if (japaneseReadingCache.has(key)) japaneseReadingCache.delete(key);
	japaneseReadingCache.set(key, cloneTranscriptReadings(readings));
	while (japaneseReadingCache.size > MAX_SESSION_CACHE_ENTRIES) {
		const oldestKey = japaneseReadingCache.keys().next().value;
		if (oldestKey === undefined) break;
		japaneseReadingCache.delete(oldestKey);
	}
}

export function getCachedTranslations(segments: string[], responseLanguage: string): string[] | null {
	const cached = transcriptTranslationCache.get(getTranscriptTranslationCacheKey(segments, responseLanguage));
	return cached ? [...cached] : null;
}

export function cacheTranslations(segments: string[], responseLanguage: string, translations: string[]): void {
	const key = getTranscriptTranslationCacheKey(segments, responseLanguage);
	if (transcriptTranslationCache.has(key)) transcriptTranslationCache.delete(key);
	transcriptTranslationCache.set(key, [...translations]);
	while (transcriptTranslationCache.size > MAX_SESSION_CACHE_ENTRIES) {
		const oldestKey = transcriptTranslationCache.keys().next().value;
		if (oldestKey === undefined) break;
		transcriptTranslationCache.delete(oldestKey);
	}
}

export function getCachedJapaneseTranslations(segments: string[]): string[] | null {
	const cached = japaneseTranslationCache.get(JSON.stringify(segments));
	return cached ? [...cached] : null;
}

export function cacheJapaneseTranslations(segments: string[], translations: string[]): void {
	const key = JSON.stringify(segments);
	if (japaneseTranslationCache.has(key)) japaneseTranslationCache.delete(key);
	japaneseTranslationCache.set(key, [...translations]);
	while (japaneseTranslationCache.size > MAX_SESSION_CACHE_ENTRIES) {
		const oldestKey = japaneseTranslationCache.keys().next().value;
		if (oldestKey === undefined) break;
		japaneseTranslationCache.delete(oldestKey);
	}
}

function getExplanationCacheKey(selection: LearningSelection, responseLanguage: string): string {
	return `${responseLanguage}\n${selection.kind}\n${selection.text}\n${selection.context}`;
}

export function getCachedExplanation(selection: LearningSelection, responseLanguage: string): string | null {
	return explanationCache.get(getExplanationCacheKey(selection, responseLanguage)) || null;
}

export function cacheExplanation(selection: LearningSelection, responseLanguage: string, explanation: string): void {
	const key = getExplanationCacheKey(selection, responseLanguage);
	if (explanationCache.has(key)) explanationCache.delete(key);
	explanationCache.set(key, explanation);
	while (explanationCache.size > MAX_SESSION_CACHE_ENTRIES) {
		const oldestKey = explanationCache.keys().next().value;
		if (oldestKey === undefined) break;
		explanationCache.delete(oldestKey);
	}
}

export function removeCachedJapaneseReadings(segments: string[]): void {
	japaneseReadingCache.delete(getJapaneseReadingCacheKey(segments));
}

export function removeCachedTranslations(segments: string[], responseLanguage: string): void {
	transcriptTranslationCache.delete(getTranscriptTranslationCacheKey(segments, responseLanguage));
}

export function clearTranscriptLanguageLearningCache(): void {
	japaneseReadingCache.clear();
	transcriptTranslationCache.clear();
	japaneseTranslationCache.clear();
	explanationCache.clear();
}
