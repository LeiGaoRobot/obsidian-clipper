import type { TranscriptReadingSegments, TranscriptReadingToken } from './language-learning';

const JAPANESE_KANJI = /[㐀-䶿一-鿿豈-﫿々]/;

export interface JapaneseReadingDictionaryEntry {
	surface: string;
	reading: string;
	updatedAt: number;
}

interface DictionaryResolution {
	readings: TranscriptReadingSegments;
	unresolvedIndexes: number[];
}

function normalizedDictionary(entries: JapaneseReadingDictionaryEntry[]): JapaneseReadingDictionaryEntry[] {
	return entries
		.filter(entry => entry.surface && entry.reading && JAPANESE_KANJI.test(entry.surface))
		.sort((left, right) => right.surface.length - left.surface.length || right.updatedAt - left.updatedAt);
}

function tokenizeKnownReadings(
	text: string,
	entries: JapaneseReadingDictionaryEntry[]
): { tokens: TranscriptReadingToken[]; unresolved: boolean; matched: boolean } {
	const tokens: TranscriptReadingToken[] = [];
	let plainText = '';
	let unresolved = false;
	let matched = false;
	const flushPlainText = () => {
		if (!plainText) return;
		tokens.push({ text: plainText, reading: '' });
		plainText = '';
	};

	for (let index = 0; index < text.length;) {
		const entry = entries.find(item => text.startsWith(item.surface, index));
		if (entry) {
			flushPlainText();
			tokens.push({ text: entry.surface, reading: entry.reading });
			index += entry.surface.length;
			matched = true;
			continue;
		}
		const character = text[index];
		plainText += character;
		if (JAPANESE_KANJI.test(character)) unresolved = true;
		index += 1;
	}
	flushPlainText();
	return { tokens, unresolved, matched };
}

export function resolveJapaneseReadingsFromDictionary(
	segments: string[],
	dictionary: JapaneseReadingDictionaryEntry[]
): DictionaryResolution {
	const entries = normalizedDictionary(dictionary);
	const unresolvedIndexes: number[] = [];
	const readings = segments.map((segment, index) => {
		const result = tokenizeKnownReadings(segment, entries);
		if (result.unresolved) unresolvedIndexes.push(index);
		return result.tokens;
	});
	return { readings, unresolvedIndexes };
}

export function applyJapaneseReadingDictionary(
	readings: TranscriptReadingSegments,
	dictionary: JapaneseReadingDictionaryEntry[]
): TranscriptReadingSegments {
	const entries = normalizedDictionary(dictionary);
	return readings.map(tokens => {
		const source = tokens.map(token => token.text).join('');
		const matches: Array<{ start: number; end: number; entry: JapaneseReadingDictionaryEntry }> = [];
		for (let index = 0; index < source.length;) {
			const entry = entries.find(item => source.startsWith(item.surface, index));
			if (!entry) {
				index += 1;
				continue;
			}
			matches.push({ start: index, end: index + entry.surface.length, entry });
			index += entry.surface.length;
		}
		if (matches.length === 0) return tokens.map(token => ({ ...token }));

		const copyRange = (start: number, end: number): TranscriptReadingToken[] => {
			const copied: TranscriptReadingToken[] = [];
			let tokenStart = 0;
			for (const token of tokens) {
				const tokenEnd = tokenStart + token.text.length;
				const overlapStart = Math.max(start, tokenStart);
				const overlapEnd = Math.min(end, tokenEnd);
				if (overlapStart < overlapEnd) {
					const localStart = overlapStart - tokenStart;
					const localEnd = overlapEnd - tokenStart;
					const text = token.text.slice(localStart, localEnd);
					let reading = '';
					if (JAPANESE_KANJI.test(text) && token.reading) {
						if (localStart === 0 && localEnd === token.text.length) {
							reading = token.reading;
						} else {
							const readingStart = Math.round(token.reading.length * localStart / token.text.length);
							const readingEnd = Math.round(token.reading.length * localEnd / token.text.length);
							reading = token.reading.slice(readingStart, readingEnd);
						}
					}
					copied.push({ text, reading });
				}
				tokenStart = tokenEnd;
			}
			return copied;
		};

		const merged: TranscriptReadingToken[] = [];
		let cursor = 0;
		for (const match of matches) {
			merged.push(...copyRange(cursor, match.start));
			merged.push({ text: match.entry.surface, reading: match.entry.reading });
			cursor = match.end;
		}
		merged.push(...copyRange(cursor, source.length));
		return merged;
	});
}
