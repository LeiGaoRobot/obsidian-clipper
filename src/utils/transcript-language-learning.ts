import { getMessage } from './i18n';
import {
	LearningSelection,
	TranscriptReadingProgress,
	TranscriptReadingSegments,
	TranscriptReadingToken,
	isCompleteTranscriptReadings
} from './language-learning';

export interface TranscriptLanguageLearning {
	translateTranscript: (segments: string[]) => Promise<string[]>;
	annotateJapaneseTranscript: (
		segments: string[],
		onProgress?: (progress: TranscriptReadingProgress) => void
	) => Promise<TranscriptReadingSegments>;
	explainSelection: (selection: LearningSelection) => Promise<string>;
}

export interface TranscriptLanguageLearningController {
	toggleBilingual: () => Promise<void>;
	toggleJapaneseReadings: () => Promise<void>;
	explain: (selection: LearningSelection) => Promise<void>;
}

interface TranscriptLanguageLearningOptions {
	doc: Document;
	transcript: HTMLElement;
	segments: HTMLElement[];
	controls: HTMLElement;
	tools: TranscriptLanguageLearning;
	cancelPendingSeek: () => void;
}

const selectionControllers = new WeakMap<Document, AbortController>();
const MAX_JAPANESE_READING_CACHE_ENTRIES = 20;
const japaneseReadingCache = new Map<string, TranscriptReadingSegments>();

function getJapaneseReadingCacheKey(segments: string[]): string {
	return JSON.stringify(segments);
}

function cloneTranscriptReadings(readings: TranscriptReadingSegments): TranscriptReadingSegments {
	return readings.map(tokens => tokens.map(token => ({ ...token })));
}

function getCachedJapaneseReadings(segments: string[]): TranscriptReadingSegments | null {
	const cached = japaneseReadingCache.get(getJapaneseReadingCacheKey(segments));
	return cached ? cloneTranscriptReadings(cached) : null;
}

function cacheJapaneseReadings(segments: string[], readings: TranscriptReadingSegments): void {
	const key = getJapaneseReadingCacheKey(segments);
	if (japaneseReadingCache.has(key)) japaneseReadingCache.delete(key);
	japaneseReadingCache.set(key, cloneTranscriptReadings(readings));
	while (japaneseReadingCache.size > MAX_JAPANESE_READING_CACHE_ENTRIES) {
		const oldestKey = japaneseReadingCache.keys().next().value;
		if (oldestKey === undefined) break;
		japaneseReadingCache.delete(oldestKey);
	}
}

function removeCachedJapaneseReadings(segments: string[]): void {
	japaneseReadingCache.delete(getJapaneseReadingCacheKey(segments));
}

export function clearTranscriptLanguageLearningCache(): void {
	japaneseReadingCache.clear();
}

export function cleanupTranscriptLanguageLearning(doc: Document): void {
	selectionControllers.get(doc)?.abort();
	selectionControllers.delete(doc);
	doc.querySelector('.language-learning-selection-action')?.remove();
	doc.querySelectorAll('.player-learning-readings, .player-learning-readings-edit').forEach(element => element.remove());
	doc.querySelector('.language-learning-card')?.remove();
}

function getOriginalSegmentText(segment: HTMLElement): string {
	const textElement = segment.querySelector('.transcript-segment-text');
	const originalElement = textElement?.querySelector('.transcript-segment-original');
	const storedOriginalText = originalElement?.getAttribute('data-original-text');
	if (storedOriginalText != null) return storedOriginalText;
	if (originalElement) return originalElement.textContent?.trim() || '';
	return (textElement?.firstChild?.textContent || textElement?.textContent || '').trim();
}

const JAPANESE_KANJI = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々]/;
const JAPANESE_KANA = /[\u3040-\u30FF]/;

export function containsJapaneseKanji(texts: string[]): boolean {
	return texts.some(text => JAPANESE_KANA.test(text))
		&& texts.some(text => JAPANESE_KANJI.test(text));
}

function renderTranscriptReadings(
	doc: Document,
	textElement: Element,
	tokens: TranscriptReadingToken[],
	showReadings: boolean,
	editable: boolean,
	onReadingInput?: (tokenIndex: number, reading: string) => void
): void {
	const originalElement = doc.createElement('span');
	originalElement.className = 'transcript-segment-original';
	originalElement.setAttribute('data-original-text', tokens.map(token => token.text).join(''));
	if (showReadings) {
		tokens.forEach((token, tokenIndex) => {
			if (!token.reading && !JAPANESE_KANJI.test(token.text)) {
				originalElement.appendChild(doc.createTextNode(token.text));
				return;
			}
			const ruby = doc.createElement('ruby');
			const base = doc.createElement('span');
			const reading = doc.createElement('rt');
			base.textContent = token.text;
			reading.textContent = token.reading;
			reading.setAttribute('contenteditable', editable ? 'true' : 'false');
			if (editable) {
				reading.addEventListener('input', () => {
					onReadingInput?.(tokenIndex, reading.textContent?.trim() || '');
				});
			}
			ruby.append(base, reading);
			originalElement.appendChild(ruby);
		});
	} else {
		originalElement.textContent = tokens.map(token => token.text).join('');
	}

	const translationElement = textElement.querySelector('.transcript-segment-translation');
	Array.from(textElement.childNodes).forEach(node => {
		if (node !== translationElement) node.remove();
	});
	if (translationElement) {
		textElement.insertBefore(originalElement, translationElement);
	} else {
		textElement.appendChild(originalElement);
	}
}

function isSingleWord(text: string): boolean {
	const normalized = text.trim();
	return normalized.length > 0 && normalized.length <= 80 && !/\s/.test(normalized);
}

export function getTranscriptLearningSelection(
	doc: Document,
	transcript: HTMLElement,
	segments: HTMLElement[],
	originalTexts: string[]
): LearningSelection | null {
	const selection = doc.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
	const text = selection.toString().trim();
	if (!text) return null;
	const range = selection.getRangeAt(0);
	const findSegment = (node: Node): HTMLElement | null => {
		const element = node.nodeType === Node.ELEMENT_NODE
			? node as Element
			: node.parentElement;
		const textElement = element?.closest('.transcript-segment-text');
		const segment = textElement?.closest('.transcript-segment') as HTMLElement | null;
		return segment && transcript.contains(segment) ? segment : null;
	};
	const startSegment = findSegment(range.startContainer);
	const endSegment = findSegment(range.endContainer);
	if (!startSegment || !endSegment) return null;
	const startIndex = segments.indexOf(startSegment);
	const endIndex = segments.indexOf(endSegment);
	if (startIndex < 0 || endIndex < 0) return null;
	const firstIndex = Math.min(startIndex, endIndex);
	const lastIndex = Math.max(startIndex, endIndex);
	return {
		kind: isSingleWord(text) ? 'word' : 'sentence',
		text,
		context: originalTexts.slice(firstIndex, lastIndex + 1).join(' ').trim() || text
	};
}

export function wireTranscriptLanguageLearning({
	doc,
	transcript,
	segments,
	controls,
	tools,
	cancelPendingSeek
}: TranscriptLanguageLearningOptions): TranscriptLanguageLearningController {
	cleanupTranscriptLanguageLearning(doc);
	const controller = new AbortController();
	selectionControllers.set(doc, controller);
	const { signal } = controller;

	const originalTexts = segments.map(getOriginalSegmentText);
	const explanationCache = new Map<string, string>();

	const card = doc.createElement('aside');
	card.className = 'language-learning-card';
	card.setAttribute('role', 'dialog');
	card.setAttribute('aria-live', 'polite');
	card.style.display = 'none';

	const cardHeader = doc.createElement('div');
	cardHeader.className = 'language-learning-card-header';
	const cardTitle = doc.createElement('strong');
	const closeButton = doc.createElement('button');
	closeButton.type = 'button';
	closeButton.className = 'language-learning-card-close';
	closeButton.textContent = '×';
	closeButton.setAttribute('aria-label', getMessage('close'));
	closeButton.addEventListener('click', () => {
		card.style.display = 'none';
	});
	cardHeader.appendChild(cardTitle);
	cardHeader.appendChild(closeButton);

	const cardBody = doc.createElement('div');
	cardBody.className = 'language-learning-card-body';
	card.appendChild(cardHeader);
	card.appendChild(cardBody);
	doc.body.appendChild(card);

	let explanationRequest = 0;
	const explain = async (selection: LearningSelection) => {
		const request = ++explanationRequest;
		const cacheKey = `${selection.kind}\n${selection.text}\n${selection.context}`;
		cardTitle.textContent = selection.text;
		cardBody.textContent = getMessage('thinking');
		card.classList.remove('is-error');
		card.style.display = 'block';

		try {
			let explanation = explanationCache.get(cacheKey);
			if (!explanation) {
				explanation = await tools.explainSelection(selection);
				if (explanation) explanationCache.set(cacheKey, explanation);
			}
			if (request !== explanationRequest) return;
			cardBody.textContent = explanation || getMessage('emptyResponse');
		} catch (error) {
			if (request !== explanationRequest) return;
			card.classList.add('is-error');
			cardBody.textContent = error instanceof Error ? error.message : getMessage('error');
		}
	};

	const bilingualButton = doc.createElement('button');
	bilingualButton.type = 'button';
	bilingualButton.className = 'player-learning-action';
	bilingualButton.textContent = getMessage('readerBilingualSubtitles');
	controls.appendChild(bilingualButton);

	let translationsLoaded = false;
	let translationsVisible = false;
	const toggleBilingual = async () => {
		if (translationsLoaded) {
			translationsVisible = !translationsVisible;
			transcript.classList.toggle('show-bilingual-transcript', translationsVisible);
			bilingualButton.classList.toggle('is-enabled', translationsVisible);
			return;
		}

		bilingualButton.disabled = true;
		bilingualButton.classList.add('is-loading');
		bilingualButton.textContent = getMessage('thinking');
		try {
			const translations = await tools.translateTranscript(originalTexts);
			if (translations.length !== originalTexts.length || translations.some(translation => !translation.trim())) {
				throw new Error(getMessage('readerTranslationIncomplete'));
			}
			const translationElements = translations.map((translation, index) => {
				const textElement = segments[index].querySelector('.transcript-segment-text');
				if (!textElement) throw new Error(getMessage('readerTranslationIncomplete'));
				const translationElement = doc.createElement('div');
				translationElement.className = 'transcript-segment-translation';
				translationElement.textContent = translation;
				return { textElement, translationElement };
			});
			translationElements.forEach(({ textElement, translationElement }) => {
				textElement.appendChild(translationElement);
			});
			translationsLoaded = true;
			translationsVisible = true;
			transcript.classList.add('show-bilingual-transcript');
			bilingualButton.classList.add('is-enabled');
		} catch (error) {
			cardTitle.textContent = getMessage('readerBilingualSubtitles');
			cardBody.textContent = error instanceof Error ? error.message : getMessage('error');
			card.classList.add('is-error');
			card.style.display = 'block';
		} finally {
			bilingualButton.disabled = false;
			bilingualButton.classList.remove('is-loading');
			bilingualButton.textContent = getMessage('readerBilingualSubtitles');
		}
	};
	bilingualButton.addEventListener('click', (event) => {
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		void toggleBilingual();
	});

	const readingsButton = doc.createElement('button');
	readingsButton.type = 'button';
	readingsButton.className = 'player-learning-action player-learning-readings';
	readingsButton.textContent = getMessage('readerJapaneseReadings');
	readingsButton.hidden = !containsJapaneseKanji(originalTexts);
	controls.appendChild(readingsButton);

	const readingsEditButton = doc.createElement('button');
	readingsEditButton.type = 'button';
	readingsEditButton.className = 'player-learning-action player-learning-readings-edit';
	readingsEditButton.textContent = getMessage('readerEditReadings');
	readingsEditButton.hidden = true;
	controls.appendChild(readingsEditButton);

	let japaneseReadings: TranscriptReadingSegments | null = null;
	let readingsVisible = false;
	let readingEditMode = false;
	const updateReadingsEditButton = () => {
		readingsEditButton.hidden = !japaneseReadings || !readingsVisible;
		readingsEditButton.textContent = readingEditMode
			? getMessage('readerFinishReadingEdit')
			: getMessage('readerEditReadings');
		readingsEditButton.classList.toggle('is-enabled', readingEditMode);
	};
	const updateReading = (segmentIndex: number, tokenIndex: number, reading: string) => {
		const token = japaneseReadings?.[segmentIndex]?.[tokenIndex];
		if (!token || !japaneseReadings) return;
		token.reading = reading;
		if (isCompleteTranscriptReadings(japaneseReadings, originalTexts)) {
			cacheJapaneseReadings(originalTexts, japaneseReadings);
		} else {
			removeCachedJapaneseReadings(originalTexts);
		}
	};
	const renderReadings = (show: boolean) => {
		if (!japaneseReadings) return;
		if (!show) readingEditMode = false;
		japaneseReadings.forEach((tokens, index) => {
			const textElement = segments[index].querySelector('.transcript-segment-text');
			if (textElement) {
				renderTranscriptReadings(
					doc,
					textElement,
					tokens,
					show,
					readingEditMode,
					(tokenIndex, reading) => updateReading(index, tokenIndex, reading)
				);
			}
		});
		readingsVisible = show;
		transcript.classList.toggle('show-japanese-readings', show);
		transcript.classList.toggle('is-editing-japanese-readings', show && readingEditMode);
		readingsButton.classList.toggle('is-enabled', show);
		updateReadingsEditButton();
	};
	const setReadingProgress = (progress: TranscriptReadingProgress) => {
		readingsButton.textContent = getMessage('readerJapaneseReadingsProgress', [
			String(progress.completed),
			String(progress.total)
		]);
	};
	const toggleJapaneseReadings = async () => {
		if (japaneseReadings) {
			renderReadings(!readingsVisible);
			return;
		}
		const cachedReadings = getCachedJapaneseReadings(originalTexts);
		if (cachedReadings && isCompleteTranscriptReadings(cachedReadings, originalTexts)) {
			japaneseReadings = cachedReadings;
			renderReadings(true);
			return;
		}
		if (cachedReadings) removeCachedJapaneseReadings(originalTexts);

		readingsButton.disabled = true;
		readingsButton.classList.add('is-loading');
		readingsButton.textContent = getMessage('thinking');
		try {
			const readings = await tools.annotateJapaneseTranscript(originalTexts, setReadingProgress);
			if (!isCompleteTranscriptReadings(readings, originalTexts)) {
				throw new Error(getMessage('readerReadingIncomplete'));
			}
			japaneseReadings = readings;
			cacheJapaneseReadings(originalTexts, readings);
			renderReadings(true);
		} catch (error) {
			cardTitle.textContent = getMessage('readerJapaneseReadings');
			cardBody.textContent = error instanceof Error ? error.message : getMessage('error');
			card.classList.add('is-error');
			card.style.display = 'block';
		} finally {
			readingsButton.disabled = false;
			readingsButton.classList.remove('is-loading');
			readingsButton.textContent = getMessage('readerJapaneseReadings');
		}
	};
	readingsEditButton.addEventListener('click', event => {
		event.preventDefault();
		event.stopPropagation();
		if (!japaneseReadings || !readingsVisible) return;
		readingEditMode = !readingEditMode;
		renderReadings(true);
	});
	readingsButton.addEventListener('click', (event) => {
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		void toggleJapaneseReadings();
	});

	const selectionButton = doc.createElement('button');
	selectionButton.type = 'button';
	selectionButton.className = 'obsidian-selection-action language-learning-selection-action';
	selectionButton.textContent = getMessage('readerExplainWithAi');
	selectionButton.style.display = 'none';
	doc.body.appendChild(selectionButton);

	let pendingSelection: LearningSelection | null = null;
	let pressedSelection: LearningSelection | null = null;
	selectionButton.addEventListener('pointerdown', () => {
		pressedSelection = pendingSelection;
	});
	selectionButton.addEventListener('mousedown', event => event.preventDefault());
	const hideSelectionButton = () => {
		selectionButton.style.display = 'none';
		pendingSelection = null;
	};

	const readSelection = () => getTranscriptLearningSelection(doc, transcript, segments, originalTexts);

	const updateSelectionButton = () => {
		const selection = readSelection();
		const browserSelection = doc.getSelection();
		if (!selection || !browserSelection || browserSelection.rangeCount === 0) {
			hideSelectionButton();
			return;
		}
		const rects = browserSelection.getRangeAt(0).getClientRects();
		if (rects.length === 0) {
			hideSelectionButton();
			return;
		}
		pendingSelection = selection;
		const lastRect = rects[rects.length - 1];
		selectionButton.style.display = 'flex';
		const buttonWidth = selectionButton.offsetWidth || 110;
		const left = Math.min(lastRect.right + 2, window.innerWidth - buttonWidth - 4);
		selectionButton.style.left = `${Math.max(4, left) + window.scrollX}px`;
		selectionButton.style.top = `${lastRect.bottom + window.scrollY - 6}px`;
	};

	selectionButton.addEventListener('click', async (event) => {
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		const selection = pendingSelection || pressedSelection;
		pressedSelection = null;
		if (!selection) return;
		hideSelectionButton();
		await explain(selection);
	});

	transcript.addEventListener('dblclick', (event) => {
		if (!event.isTrusted) return;
		cancelPendingSeek();
		event.stopPropagation();
		window.setTimeout(() => {
			const selection = readSelection();
			if (!selection || selection.kind !== 'word') return;
			hideSelectionButton();
			explain(selection);
		}, 0);
	}, { signal });

	transcript.addEventListener('pointerup', () => {
		window.setTimeout(updateSelectionButton, 0);
	}, { signal });

	let selectionChangeTimer: number | undefined;
	doc.addEventListener('selectionchange', () => {
		if (selectionChangeTimer) window.clearTimeout(selectionChangeTimer);
		const selection = doc.getSelection();
		if (!selection || selection.isCollapsed) {
			hideSelectionButton();
			return;
		}
		selectionChangeTimer = window.setTimeout(updateSelectionButton, 200);
	}, { signal });

	return { toggleBilingual, toggleJapaneseReadings, explain };
}
