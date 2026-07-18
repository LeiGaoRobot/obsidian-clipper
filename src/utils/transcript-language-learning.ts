import { getMessage } from './i18n';
import {
	LearningSelection,
	LearningVocabularyEntry,
	TranscriptReadingProgress,
	TranscriptReadingSegments,
	TranscriptReadingToken,
	TranscriptTranslationProgress,
	isCompleteTranscriptReadings
} from './language-learning';
import {
	isRequestCancelled,
	throwIfRequestAborted
} from './request-cancellation';
import { renderLanguageLearningCenter } from './language-learning-center';

export interface TranscriptLanguageLearning {
	translateTranscript: (
		segments: string[],
		onProgress?: (progress: TranscriptTranslationProgress) => void,
		signal?: AbortSignal
	) => Promise<string[]>;
	annotateJapaneseTranscript: (
		segments: string[],
		onProgress?: (progress: TranscriptReadingProgress) => void,
		signal?: AbortSignal
	) => Promise<TranscriptReadingSegments>;
	explainSelection: (selection: LearningSelection, signal?: AbortSignal) => Promise<string>;
	getExecutionInfo?: () => Promise<TranscriptExecutionInfo>;
	saveTranscriptTranslations?: (segments: string[], translations: string[]) => Promise<void>;
	saveJapaneseReadings?: (segments: string[], readings: TranscriptReadingSegments) => Promise<void>;
	clearJapaneseReadings?: (segments: string[]) => Promise<void>;
	isVocabularyFavorite?: (selection: LearningSelection) => Promise<boolean>;
	toggleVocabularyFavorite?: (selection: LearningSelection, explanation: string) => Promise<boolean>;
	copyLearningText?: (text: string) => Promise<boolean>;
	saveVocabularyToObsidian?: (selection: LearningSelection, explanation: string) => Promise<void>;
	listVocabulary?: () => Promise<LearningVocabularyEntry[]>;
	removeVocabulary?: (id: string) => Promise<void>;
	removeVocabularyMany?: (ids: string[]) => Promise<void>;
	clearVocabulary?: () => Promise<void>;
	exportVocabulary?: () => Promise<string>;
	importVocabulary?: (json: string) => Promise<number>;
	saveJapaneseReadingOverride?: (surface: string, reading: string) => Promise<void>;
	listJapaneseReadingDictionary?: () => Promise<Array<{ surface: string; reading: string; updatedAt: number }>>;
	removeJapaneseReadingOverride?: (surface: string) => Promise<void>;
	clearJapaneseReadingDictionary?: () => Promise<void>;
	exportJapaneseReadingDictionary?: () => Promise<string>;
	importJapaneseReadingDictionary?: (json: string) => Promise<number>;
	setExecutionMode?: (mode: 'api' | 'grok' | 'codex') => Promise<void>;
}

export type TranscriptTaskRange = 'current' | 'next-five-minutes' | 'all';

export interface TranscriptExecutionInfo {
	mode: 'api' | 'grok' | 'codex';
	label: string;
	promptCharLimit: number;
}

export interface TranscriptLanguageLearningController {
	toggleBilingual: () => Promise<void>;
	toggleJapaneseReadings: () => Promise<void>;
	regenerateJapaneseReadings: () => Promise<void>;
	cancelActiveRequest: () => void;
	explain: (selection: LearningSelection, returnFocus?: HTMLElement) => Promise<void>;
	setTaskRange: (range: TranscriptTaskRange) => void;
	showVocabulary: () => Promise<void>;
}

interface TranscriptLanguageLearningOptions {
	doc: Document;
	transcript: HTMLElement;
	segments: HTMLElement[];
	controls: HTMLElement;
	tools: TranscriptLanguageLearning;
	responseLanguage?: string;
	cancelPendingSeek: () => void;
}

const selectionControllers = new WeakMap<Document, AbortController>();
const activeLearningRequests = new WeakMap<Document, AbortController>();
const MAX_SESSION_CACHE_ENTRIES = 20;
const japaneseReadingCache = new Map<string, TranscriptReadingSegments>();
const transcriptTranslationCache = new Map<string, string[]>();
const explanationCache = new Map<string, string>();

function getJapaneseReadingCacheKey(segments: string[]): string {
	return JSON.stringify(segments);
}

function getTranscriptTranslationCacheKey(segments: string[], responseLanguage: string): string {
	return JSON.stringify([responseLanguage, segments]);
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
	while (japaneseReadingCache.size > MAX_SESSION_CACHE_ENTRIES) {
		const oldestKey = japaneseReadingCache.keys().next().value;
		if (oldestKey === undefined) break;
		japaneseReadingCache.delete(oldestKey);
	}
}

function getCachedTranslations(segments: string[], responseLanguage: string): string[] | null {
	const cached = transcriptTranslationCache.get(getTranscriptTranslationCacheKey(segments, responseLanguage));
	return cached ? [...cached] : null;
}

function cacheTranslations(segments: string[], responseLanguage: string, translations: string[]): void {
	const key = getTranscriptTranslationCacheKey(segments, responseLanguage);
	if (transcriptTranslationCache.has(key)) transcriptTranslationCache.delete(key);
	transcriptTranslationCache.set(key, [...translations]);
	while (transcriptTranslationCache.size > MAX_SESSION_CACHE_ENTRIES) {
		const oldestKey = transcriptTranslationCache.keys().next().value;
		if (oldestKey === undefined) break;
		transcriptTranslationCache.delete(oldestKey);
	}
}

function getExplanationCacheKey(selection: LearningSelection, responseLanguage: string): string {
	return `${responseLanguage}\n${selection.kind}\n${selection.text}\n${selection.context}`;
}

function getCachedExplanation(selection: LearningSelection, responseLanguage: string): string | null {
	return explanationCache.get(getExplanationCacheKey(selection, responseLanguage)) || null;
}

function cacheExplanation(selection: LearningSelection, responseLanguage: string, explanation: string): void {
	const key = getExplanationCacheKey(selection, responseLanguage);
	if (explanationCache.has(key)) explanationCache.delete(key);
	explanationCache.set(key, explanation);
	while (explanationCache.size > MAX_SESSION_CACHE_ENTRIES) {
		const oldestKey = explanationCache.keys().next().value;
		if (oldestKey === undefined) break;
		explanationCache.delete(oldestKey);
	}
}

function removeCachedJapaneseReadings(segments: string[]): void {
	japaneseReadingCache.delete(getJapaneseReadingCacheKey(segments));
}

export function clearTranscriptLanguageLearningCache(): void {
	japaneseReadingCache.clear();
	transcriptTranslationCache.clear();
	explanationCache.clear();
}

export function cleanupTranscriptLanguageLearning(doc: Document): void {
	selectionControllers.get(doc)?.abort();
	selectionControllers.delete(doc);
	activeLearningRequests.get(doc)?.abort();
	activeLearningRequests.delete(doc);
	doc.querySelector('.language-learning-selection-action')?.remove();
	doc.querySelectorAll('.player-learning-bilingual, .player-learning-translations-edit, .player-learning-vocabulary, .player-learning-range, .player-learning-task, .player-learning-readings, .player-learning-readings-edit, .player-learning-readings-regenerate').forEach(element => element.remove());
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
				reading.setAttribute('role', 'textbox');
				reading.setAttribute('aria-label', getMessage('readerReadingEditLabel', token.text));
				reading.setAttribute('aria-multiline', 'false');
				reading.setAttribute('tabindex', '0');
				reading.setAttribute('spellcheck', 'false');
				reading.addEventListener('input', () => {
					onReadingInput?.(tokenIndex, reading.textContent?.trim() || '');
				});
			}
			ruby.append(base, reading);
			if (!editable) {
				ruby.className = 'transcript-reading-token';
				ruby.setAttribute('role', 'button');
				ruby.setAttribute('tabindex', '0');
				ruby.setAttribute('aria-pressed', 'false');
				ruby.setAttribute('aria-label', getMessage('readerToggleReading', token.text));
				const toggleReading = () => {
					const hidden = ruby.classList.toggle('is-reading-hidden');
					ruby.setAttribute('aria-pressed', String(hidden));
				};
				ruby.addEventListener('click', event => {
					event.preventDefault();
					event.stopPropagation();
					toggleReading();
				});
				ruby.addEventListener('keydown', event => {
					if (event.key !== 'Enter' && event.key !== ' ') return;
					event.preventDefault();
					event.stopPropagation();
					toggleReading();
				});
			}
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
	if (!normalized || normalized.length > 80 || /\s/.test(normalized)) return false;
	if (/[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々]/.test(normalized)) {
		return Array.from(normalized).length <= 8
			&& !/[。！？、，,.!?]|(?:です|ます|でした|ません|でしょう|だった)$/.test(normalized);
	}
	return true;
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
	responseLanguage,
	cancelPendingSeek
}: TranscriptLanguageLearningOptions): TranscriptLanguageLearningController {
	cleanupTranscriptLanguageLearning(doc);
	const controller = new AbortController();
	selectionControllers.set(doc, controller);
	const { signal } = controller;

	const originalTexts = segments.map(getOriginalSegmentText);
	const resolvedResponseLanguage = responseLanguage?.trim() || navigator.language || 'English';

	const card = doc.createElement('aside');
	card.className = 'language-learning-card';
	card.setAttribute('role', 'dialog');
	card.setAttribute('tabindex', '-1');
	card.style.display = 'none';

	const cardHeader = doc.createElement('div');
	cardHeader.className = 'language-learning-card-header';
	const cardTitle = doc.createElement('strong');
	cardTitle.id = `language-learning-card-title-${Math.random().toString(36).slice(2)}`;
	card.setAttribute('aria-labelledby', cardTitle.id);
	const closeButton = doc.createElement('button');
	closeButton.type = 'button';
	closeButton.className = 'language-learning-card-close';
	closeButton.textContent = '×';
	closeButton.setAttribute('aria-label', getMessage('close'));
	cardHeader.appendChild(cardTitle);
	cardHeader.appendChild(closeButton);

	const cardBody = doc.createElement('div');
	cardBody.className = 'language-learning-card-body';
	cardBody.setAttribute('aria-live', 'polite');
	const cardErrorDetails = doc.createElement('details');
	cardErrorDetails.className = 'language-learning-card-error-details';
	cardErrorDetails.hidden = true;
	const retryButton = doc.createElement('button');
	retryButton.type = 'button';
	retryButton.className = 'language-learning-card-retry';
	retryButton.textContent = getMessage('readerRetry');
	retryButton.hidden = true;
	const cardActions = doc.createElement('div');
	cardActions.className = 'language-learning-card-actions';
	const favoriteButton = doc.createElement('button');
	favoriteButton.type = 'button';
	favoriteButton.className = 'language-learning-card-action language-learning-card-favorite';
	favoriteButton.textContent = getMessage('readerFavorite');
	favoriteButton.hidden = true;
	const copyButton = doc.createElement('button');
	copyButton.type = 'button';
	copyButton.className = 'language-learning-card-action language-learning-card-copy';
	copyButton.textContent = getMessage('copyToClipboard');
	copyButton.hidden = true;
	const saveButton = doc.createElement('button');
	saveButton.type = 'button';
	saveButton.className = 'language-learning-card-action language-learning-card-save';
	saveButton.textContent = getMessage('addToObsidian');
	saveButton.hidden = true;
	const cardFeedback = doc.createElement('span');
	cardFeedback.className = 'language-learning-card-feedback';
	cardFeedback.setAttribute('role', 'status');
	cardFeedback.setAttribute('aria-live', 'polite');
	const engineRecovery = doc.createElement('div');
	engineRecovery.className = 'language-learning-card-engine-recovery';
	engineRecovery.hidden = true;
	const engineSelect = doc.createElement('select');
	engineSelect.className = 'language-learning-card-engine-select';
	[
		['api', 'interpreterExecutionModeApi'],
		['grok', 'interpreterExecutionModeGrok'],
		['codex', 'interpreterExecutionModeCodex']
	].forEach(([value, label]) => {
		const option = doc.createElement('option');
		option.value = value;
		option.textContent = getMessage(label);
		engineSelect.appendChild(option);
	});
	engineSelect.setAttribute('aria-label', getMessage('interpreterExecutionMode'));
	const applyEngineButton = doc.createElement('button');
	applyEngineButton.type = 'button';
	applyEngineButton.className = 'language-learning-card-action language-learning-card-engine-apply';
	applyEngineButton.textContent = getMessage('readerSwitchAndRetry');
	engineRecovery.append(engineSelect, applyEngineButton);
	cardActions.append(cardFeedback, engineRecovery, favoriteButton, copyButton, saveButton, retryButton);
	card.appendChild(cardHeader);
	card.appendChild(cardBody);
	card.appendChild(cardErrorDetails);
	card.appendChild(cardActions);
	doc.body.appendChild(card);

	let retryAction: (() => void) | null = null;
	let currentExplanation: { selection: LearningSelection; explanation: string } | null = null;
	let currentExecutionInfo: TranscriptExecutionInfo = {
		mode: 'api',
		label: getMessage('interpreterExecutionModeApi'),
		promptCharLimit: 6000
	};
	let cardReturnFocus: HTMLElement | null = null;
	let lastTaskProgress: { completed: number; total: number } | null = null;
	const rememberCardReturnFocus = (preferred?: HTMLElement | null) => {
		if (card.style.display !== 'none') return;
		if (preferred?.isConnected) {
			cardReturnFocus = preferred;
			return;
		}
		const activeElement = doc.activeElement;
		cardReturnFocus = activeElement instanceof HTMLElement && activeElement !== doc.body
			? activeElement
			: null;
	};
	const hideCard = () => {
		const returnFocus = cardReturnFocus;
		card.style.display = 'none';
		card.classList.remove('is-error');
		retryAction = null;
		retryButton.hidden = true;
		retryButton.textContent = getMessage('readerRetry');
		cardErrorDetails.replaceChildren();
		cardErrorDetails.hidden = true;
		engineRecovery.hidden = true;
		cardFeedback.textContent = '';
		favoriteButton.hidden = true;
		copyButton.hidden = true;
		saveButton.hidden = true;
		cardReturnFocus = null;
		if (returnFocus?.isConnected) returnFocus.focus();
	};
	const showCardError = (title: string, error: unknown, retry?: () => void) => {
		rememberCardReturnFocus();
		cardTitle.textContent = title;
		currentExplanation = null;
		favoriteButton.hidden = true;
		copyButton.hidden = true;
		saveButton.hidden = true;
		cardErrorDetails.replaceChildren();
		cardErrorDetails.hidden = true;
		const structuredError = error && typeof error === 'object'
			? error as { code?: string; details?: Record<string, unknown>; message?: string }
			: null;
		const errorMode = String(structuredError?.details?.mode || currentExecutionInfo.mode);
		const localizedErrorKeys: Record<string, string> = {
			unavailable: 'readerCliUnavailable',
			config: 'readerCliConfig',
			'protocol-mismatch': 'readerCliProtocolMismatch',
			'launch-failed': 'readerCliLaunchFailed',
			'cli-failed': 'readerCliFailed',
			'response-too-large': 'readerCliResponseTooLarge',
			invalid: 'readerCliInvalid'
		};
		if (structuredError?.code === 'timeout') {
			const timeoutSeconds = String(structuredError.details?.timeoutSeconds || '');
			cardBody.textContent = getMessage('readerCliTimeout', [errorMode, timeoutSeconds]);
		} else if (structuredError?.code && localizedErrorKeys[structuredError.code]) {
			cardBody.textContent = getMessage(localizedErrorKeys[structuredError.code], errorMode);
		} else {
			cardBody.textContent = error instanceof Error ? error.message : getMessage('error');
		}
		const technicalMessage = error instanceof Error
			? error.message
			: structuredError?.message;
		if (technicalMessage && structuredError?.code) {
			const summary = doc.createElement('summary');
			summary.textContent = getMessage('readerTechnicalDetails');
			const detail = doc.createElement('div');
			detail.className = 'language-learning-card-error-detail';
			detail.textContent = technicalMessage;
			cardErrorDetails.append(summary, detail);
			cardErrorDetails.hidden = false;
		}
		const canSwitchEngine = Boolean(
			structuredError?.code
			&& structuredError.code !== 'cancelled'
			&& tools.setExecutionMode
		);
		engineRecovery.hidden = !canSwitchEngine;
		if (canSwitchEngine) {
			const selectedErrorMode = structuredError?.details?.mode;
			engineSelect.value = selectedErrorMode === 'grok' || selectedErrorMode === 'codex' || selectedErrorMode === 'api'
				? selectedErrorMode
				: currentExecutionInfo.mode;
		}
		card.classList.add('is-error');
		card.style.display = 'block';
		retryAction = retry || null;
		retryButton.hidden = !retryAction;
		retryButton.textContent = lastTaskProgress && lastTaskProgress.completed > 0
			? getMessage('readerContinueRemaining', [
				String(lastTaskProgress.completed),
				String(lastTaskProgress.total)
			])
			: getMessage('readerRetry');
		card.focus();
	};
	const showExplanationActions = async (selection: LearningSelection, explanation: string) => {
		currentExplanation = { selection, explanation };
		copyButton.hidden = !tools.copyLearningText;
		saveButton.hidden = !tools.saveVocabularyToObsidian;
		favoriteButton.hidden = !tools.toggleVocabularyFavorite;
		if (tools.isVocabularyFavorite && tools.toggleVocabularyFavorite) {
			const favorite = await tools.isVocabularyFavorite(selection);
			if (currentExplanation?.selection !== selection) return;
			favoriteButton.textContent = getMessage(favorite ? 'readerUnfavorite' : 'readerFavorite');
		}
	};
	let explanationRequest = 0;
	let activeRequest: AbortController | null = null;
	const startActiveRequest = (): AbortController => {
		activeRequest?.abort();
		const nextRequest = new AbortController();
		activeRequest = nextRequest;
		activeLearningRequests.set(doc, nextRequest);
		return nextRequest;
	};
	const finishActiveRequest = (request: AbortController) => {
		if (activeRequest !== request) return;
		activeRequest = null;
		if (activeLearningRequests.get(doc) === request) activeLearningRequests.delete(doc);
	};
	const cancelActiveRequest = () => {
		activeLearningRequests.get(doc)?.abort();
	};
	const explain = async (selection: LearningSelection, returnFocus?: HTMLElement) => {
		if (signal.aborted) return;
		const request = ++explanationRequest;
		rememberCardReturnFocus(returnFocus);
		currentExplanation = null;
		cardTitle.textContent = selection.text;
		cardBody.textContent = getMessage('thinking');
		card.classList.remove('is-error');
		favoriteButton.hidden = true;
		copyButton.hidden = true;
		saveButton.hidden = true;
		cardErrorDetails.replaceChildren();
		cardErrorDetails.hidden = true;
		engineRecovery.hidden = true;
		cardFeedback.textContent = '';
		retryAction = null;
		retryButton.hidden = true;
		card.style.display = 'block';
		card.focus();

		const cachedExplanation = getCachedExplanation(selection, resolvedResponseLanguage);
		if (cachedExplanation) {
			cardBody.textContent = cachedExplanation;
			await showExplanationActions(selection, cachedExplanation);
			return;
		}
		const requestController = startActiveRequest();
		cancelRequestButton.hidden = false;
		setProgressStatus(getMessage('thinking'));
		try {
			const explanation = await tools.explainSelection(selection, requestController.signal);
			throwIfRequestAborted(requestController.signal);
			if (explanation) cacheExplanation(selection, resolvedResponseLanguage, explanation);
			if (request !== explanationRequest) return;
			const resolvedExplanation = explanation || getMessage('emptyResponse');
			cardBody.textContent = resolvedExplanation;
			await showExplanationActions(selection, resolvedExplanation);
		} catch (error) {
			if (request !== explanationRequest) return;
			if (isRequestCancelled(error) || requestController.signal.aborted) {
				if (activeRequest !== requestController) return;
				setProgressStatus(getMessage('readerAiCancelled'));
				hideCard();
				return;
			}
			card.classList.add('is-error');
			showCardError(selection.text, error, () => { void explain(selection); });
		} finally {
			if (activeRequest === requestController) {
				cancelRequestButton.hidden = true;
				if (!requestController.signal.aborted) clearProgressStatus();
			}
			finishActiveRequest(requestController);
		}
	};
	retryButton.addEventListener('click', event => {
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		retryAction?.();
	});
	favoriteButton.addEventListener('click', async event => {
		if (!event.isTrusted || !currentExplanation || !tools.toggleVocabularyFavorite) return;
		const favorite = await tools.toggleVocabularyFavorite(
			currentExplanation.selection,
			currentExplanation.explanation
		);
		favoriteButton.textContent = getMessage(favorite ? 'readerUnfavorite' : 'readerFavorite');
		cardFeedback.textContent = getMessage(favorite ? 'readerFavoriteSaved' : 'readerFavoriteRemoved');
	});
	copyButton.addEventListener('click', async event => {
		if (!event.isTrusted || !currentExplanation || !tools.copyLearningText) return;
		const copied = await tools.copyLearningText([
			currentExplanation.selection.text,
			currentExplanation.explanation
		].join('\n\n'));
		cardFeedback.textContent = getMessage(copied ? 'copied' : 'error');
	});
	saveButton.addEventListener('click', async event => {
		if (!event.isTrusted || !currentExplanation || !tools.saveVocabularyToObsidian) return;
		await tools.saveVocabularyToObsidian(
			currentExplanation.selection,
			currentExplanation.explanation
		);
		cardFeedback.textContent = getMessage('readerSavedToObsidian');
	});
	applyEngineButton.addEventListener('click', async event => {
		if (!event.isTrusted || !tools.setExecutionMode || !retryAction) return;
		const mode = engineSelect.value as 'api' | 'grok' | 'codex';
		applyEngineButton.disabled = true;
		try {
			await tools.setExecutionMode(mode);
			currentExecutionInfo = {
				mode,
				label: getMessage(mode === 'api'
					? 'interpreterExecutionModeApi'
					: mode === 'grok'
						? 'interpreterExecutionModeGrok'
						: 'interpreterExecutionModeCodex'),
				promptCharLimit: mode === 'grok' ? 1600 : mode === 'codex' ? 2500 : 6000
			};
			const retry = retryAction;
			hideCard();
			retry?.();
		} finally {
			applyEngineButton.disabled = false;
		}
	});

	const showVocabulary = async () => {
		rememberCardReturnFocus();
		cardTitle.textContent = getMessage('readerLearningCenter');
		cardBody.replaceChildren();
		card.classList.remove('is-error');
		cardErrorDetails.hidden = true;
		engineRecovery.hidden = true;
		retryButton.hidden = true;
		favoriteButton.hidden = true;
		copyButton.hidden = true;
		saveButton.hidden = true;
		currentExplanation = null;
		const center = renderLanguageLearningCenter({
			doc,
			container: cardBody,
			tools,
			onFeedback: message => { cardFeedback.textContent = message; }
		});
		await center.ready;
		card.style.display = 'block';
		card.focus();
	};
	closeButton.addEventListener('click', () => {
		hideCard();
	});
	doc.addEventListener('keydown', event => {
		if (event.key !== 'Escape' || card.style.display === 'none') return;
		event.preventDefault();
		hideCard();
	}, { signal });

	const rangeControl = doc.createElement('label');
	rangeControl.className = 'player-learning-range';
	const rangeLabel = doc.createElement('span');
	rangeLabel.textContent = getMessage('readerTaskRange');
	const rangeSelect = doc.createElement('select');
	const rangeOptions: Array<{ value: TranscriptTaskRange; label: string }> = [
		{ value: 'current', label: getMessage('readerTaskRangeCurrent') },
		{ value: 'next-five-minutes', label: getMessage('readerTaskRangeNextFiveMinutes') },
		{ value: 'all', label: getMessage('readerTaskRangeAll') }
	];
	rangeOptions.forEach(({ value, label }) => {
		const option = doc.createElement('option');
		option.value = value;
		option.textContent = label;
		rangeSelect.appendChild(option);
	});
	rangeSelect.value = 'all';
	rangeControl.append(rangeLabel, rangeSelect);
	controls.appendChild(rangeControl);

	const getTaskRange = (): TranscriptTaskRange => rangeSelect.value as TranscriptTaskRange;
	const setTaskRange = (range: TranscriptTaskRange) => {
		rangeSelect.value = range;
	};
	const getActiveSegmentIndex = () => {
		const activeIndex = segments.findIndex(segment => segment.classList.contains('is-active'));
		return activeIndex >= 0 ? activeIndex : 0;
	};
	const getSegmentTimestamp = (segment: HTMLElement): number | null => {
		const timestamp = segment.querySelector<HTMLElement>('.timestamp[data-timestamp]')?.dataset.timestamp;
		if (timestamp == null) return null;
		const parsed = Number(timestamp);
		return Number.isFinite(parsed) ? parsed : null;
	};
	const getTaskIndexes = (): number[] => {
		const range = getTaskRange();
		if (range === 'all') return originalTexts.map((_, index) => index);
		const activeIndex = getActiveSegmentIndex();
		if (range === 'current') return [activeIndex];
		const startTime = getSegmentTimestamp(segments[activeIndex]);
		if (startTime == null) return [activeIndex];
		return segments
			.map((segment, index) => ({ index, timestamp: getSegmentTimestamp(segment) }))
			.filter(({ index, timestamp }) => index >= activeIndex && timestamp != null && timestamp <= startTime + 300)
			.map(({ index }) => index);
	};

	const bilingualButton = doc.createElement('button');
	bilingualButton.type = 'button';
	bilingualButton.className = 'player-learning-action player-learning-bilingual';
	bilingualButton.textContent = getMessage('readerBilingualSubtitles');
	controls.appendChild(bilingualButton);
	const vocabularyButton = doc.createElement('button');
	vocabularyButton.type = 'button';
	vocabularyButton.className = 'player-learning-action player-learning-vocabulary';
	vocabularyButton.textContent = getMessage('readerSavedVocabulary');
	vocabularyButton.hidden = !tools.listVocabulary;
	vocabularyButton.addEventListener('click', event => {
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		void showVocabulary();
	});
	controls.appendChild(vocabularyButton);

	const translationsEditButton = doc.createElement('button');
	translationsEditButton.type = 'button';
	translationsEditButton.className = 'player-learning-action player-learning-translations-edit';
	translationsEditButton.textContent = getMessage('readerEditTranslations');
	translationsEditButton.hidden = true;
	controls.appendChild(translationsEditButton);

	const taskBar = doc.createElement('div');
	taskBar.className = 'player-learning-task';
	taskBar.hidden = true;
	taskBar.setAttribute('aria-busy', 'false');
	const taskEngine = doc.createElement('span');
	taskEngine.className = 'player-learning-task-engine';
	taskEngine.textContent = getMessage('interpreterExecutionModeApi');
	const taskEstimate = doc.createElement('span');
	taskEstimate.className = 'player-learning-task-estimate';
	const taskElapsed = doc.createElement('span');
	taskElapsed.className = 'player-learning-task-elapsed';
	taskElapsed.setAttribute('aria-hidden', 'true');
	const taskProgress = doc.createElement('progress');
	taskProgress.className = 'player-learning-task-progress';
	taskProgress.max = 1;
	taskProgress.value = 0;
	taskBar.append(taskEngine, taskEstimate, taskElapsed, taskProgress);
	controls.appendChild(taskBar);

	const cancelRequestButton = doc.createElement('button');
	cancelRequestButton.type = 'button';
	cancelRequestButton.className = 'player-learning-action player-learning-cancel';
	cancelRequestButton.textContent = getMessage('cancel');
	cancelRequestButton.hidden = true;
	cancelRequestButton.addEventListener('click', event => {
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		cancelActiveRequest();
	});
	taskBar.appendChild(cancelRequestButton);

	const progressStatus = doc.createElement('span');
	progressStatus.className = 'player-learning-progress';
	progressStatus.setAttribute('role', 'status');
	progressStatus.setAttribute('aria-live', 'polite');
	progressStatus.hidden = true;
	taskBar.appendChild(progressStatus);

	const clearProgressStatus = () => {
		progressStatus.textContent = '';
		progressStatus.hidden = true;
	};
	const setProgressStatus = (message: string) => {
		progressStatus.textContent = message;
		progressStatus.hidden = false;
	};
	let elapsedTimer: number | undefined;
	const updateExecutionInfo = async (taskTexts: string[]) => {
		try {
			if (tools.getExecutionInfo) currentExecutionInfo = await tools.getExecutionInfo();
		} catch {
			// Execution errors are reported by the requested task itself.
		}
		taskEngine.textContent = currentExecutionInfo.label;
		const sourceChars = taskTexts.reduce((total, text) => total + text.length, 0);
		const estimatedBatches = Math.max(1, Math.ceil(sourceChars / currentExecutionInfo.promptCharLimit));
		taskEstimate.textContent = getMessage('readerTaskEstimate', [
			String(taskTexts.length),
			String(estimatedBatches)
		]);
	};
	const beginRequestUi = async (button: HTMLButtonElement, label: string, taskTexts: string[]) => {
		hideCard();
		lastTaskProgress = null;
		await updateExecutionInfo(taskTexts);
		taskBar.hidden = false;
		taskBar.setAttribute('aria-busy', 'true');
		taskProgress.value = 0;
		taskProgress.max = 1;
		const startedAt = Date.now();
		const updateElapsed = () => {
			taskElapsed.textContent = getMessage('readerTaskElapsed', String(Math.floor((Date.now() - startedAt) / 1000)));
		};
		updateElapsed();
		if (elapsedTimer) window.clearInterval(elapsedTimer);
		elapsedTimer = window.setInterval(updateElapsed, 1000);
		button.disabled = true;
		button.setAttribute('aria-busy', 'true');
		button.classList.add('is-loading');
		button.textContent = label;
		cancelRequestButton.hidden = false;
		clearProgressStatus();
	};
	const finishRequestUi = (request: AbortController, button: HTMLButtonElement, label: string, cancelled: boolean) => {
		button.disabled = false;
		button.removeAttribute('aria-busy');
		button.classList.remove('is-loading');
		button.textContent = label;
		if (activeRequest && activeRequest !== request) return;
		if (elapsedTimer) window.clearInterval(elapsedTimer);
		elapsedTimer = undefined;
		taskBar.setAttribute('aria-busy', 'false');
		cancelRequestButton.hidden = true;
		if (!cancelled) clearProgressStatus();
	};

	let translationsVisible = false;
	let translationEditMode = false;
	let translationValues = new Array<string>(originalTexts.length).fill('');
	const persistTranslations = () => {
		if (translationValues.every(translation => translation.trim())) {
			cacheTranslations(originalTexts, resolvedResponseLanguage, translationValues);
		}
		void tools.saveTranscriptTranslations?.(originalTexts, [...translationValues]);
	};
	const updateTranslationEditButton = () => {
		translationsEditButton.hidden = !translationsVisible
			|| !translationValues.some(translation => translation.trim());
		translationsEditButton.textContent = translationEditMode
			? getMessage('readerFinishTranslationEdit')
			: getMessage('readerEditTranslations');
		translationsEditButton.classList.toggle('is-enabled', translationEditMode);
	};
	const updateTranslationEditing = () => {
		segments.forEach((segment, index) => {
			const translationElement = segment.querySelector<HTMLElement>('.transcript-segment-translation');
			if (!translationElement) return;
			translationElement.setAttribute('contenteditable', translationEditMode ? 'true' : 'false');
			if (translationEditMode) {
				translationElement.setAttribute('role', 'textbox');
				translationElement.setAttribute('aria-label', getMessage('readerTranslationEditLabel', String(index + 1)));
				translationElement.setAttribute('aria-multiline', 'true');
				translationElement.setAttribute('spellcheck', 'true');
			} else {
				translationElement.removeAttribute('role');
				translationElement.removeAttribute('aria-label');
				translationElement.removeAttribute('aria-multiline');
				translationElement.removeAttribute('spellcheck');
			}
		});
		transcript.classList.toggle('is-editing-translations', translationEditMode);
		updateTranslationEditButton();
	};
	const renderTranslations = (translations: string[], complete: boolean) => {
		if (translations.length !== originalTexts.length) {
			throw new Error(getMessage('readerTranslationIncomplete'));
		}
		translations.forEach((translation, index) => {
			if (!translation.trim()) return;
			const textElement = segments[index].querySelector('.transcript-segment-text');
			if (!textElement) throw new Error(getMessage('readerTranslationIncomplete'));
			let translationElement = textElement.querySelector('.transcript-segment-translation') as HTMLElement | null;
			if (!translationElement) {
				translationElement = doc.createElement('div');
				translationElement.className = 'transcript-segment-translation';
				translationElement.addEventListener('input', () => {
					translationValues[index] = translationElement?.textContent?.trim() || '';
					persistTranslations();
				});
				textElement.appendChild(translationElement);
			}
			translationElement.textContent = translation;
		});
		translationValues = [...translations];
		translationsVisible = true;
		transcript.classList.add('show-bilingual-transcript');
		transcript.classList.toggle('has-partial-bilingual-transcript', !complete);
		bilingualButton.classList.add('is-enabled');
		updateTranslationEditing();
	};
	const applyTranslations = (translations: string[]) => {
		if (translations.some(translation => !translation.trim())) {
			throw new Error(getMessage('readerTranslationIncomplete'));
		}
		renderTranslations(translations, true);
	};
	const mergeTranslations = (indexes: number[], scopedTranslations: string[]): string[] => {
		if (scopedTranslations.length !== indexes.length) {
			throw new Error(getMessage('readerTranslationIncomplete'));
		}
		const merged = [...translationValues];
		indexes.forEach((sourceIndex, scopedIndex) => {
			merged[sourceIndex] = scopedTranslations[scopedIndex] || '';
		});
		return merged;
	};
	const toggleBilingual = async () => {
		const taskIndexes = getTaskIndexes();
		const selectedRangeLoaded = taskIndexes.every(index => translationValues[index]?.trim());
		if (selectedRangeLoaded) {
			translationsVisible = !translationsVisible;
			if (!translationsVisible) translationEditMode = false;
			transcript.classList.toggle('show-bilingual-transcript', translationsVisible);
			bilingualButton.classList.toggle('is-enabled', translationsVisible);
			updateTranslationEditing();
			return;
		}

		const cachedTranslations = getTaskRange() === 'all'
			? getCachedTranslations(originalTexts, resolvedResponseLanguage)
			: null;
		if (cachedTranslations) {
			try {
				applyTranslations(cachedTranslations);
				return;
			} catch {
				transcriptTranslationCache.delete(getTranscriptTranslationCacheKey(originalTexts, resolvedResponseLanguage));
			}
		}

		const taskTexts = taskIndexes.map(index => originalTexts[index]);
		const requestController = startActiveRequest();
		await beginRequestUi(bilingualButton, getMessage('thinking'), taskTexts);
		const setTranslationProgress = (progress: TranscriptTranslationProgress) => {
			if (progress.translations?.some(translation => translation.trim())) {
				renderTranslations(mergeTranslations(taskIndexes, progress.translations), false);
			}
			lastTaskProgress = { completed: progress.completed, total: progress.total };
			taskProgress.max = Math.max(1, progress.total);
			taskProgress.value = progress.completed;
			const label = getMessage('readerTranslationProgress', [
				String(progress.completed),
				String(progress.total)
			]);
			setProgressStatus(label);
		};
		try {
			throwIfRequestAborted(requestController.signal);
			const translations = await tools.translateTranscript(taskTexts, setTranslationProgress, requestController.signal);
			throwIfRequestAborted(requestController.signal);
			if (translations.some(translation => !translation.trim())) {
				throw new Error(getMessage('readerTranslationIncomplete'));
			}
			const merged = mergeTranslations(taskIndexes, translations);
			const complete = merged.every(translation => translation.trim());
			renderTranslations(merged, complete);
			if (complete) cacheTranslations(originalTexts, resolvedResponseLanguage, merged);
		} catch (error) {
			if (isRequestCancelled(error) || requestController.signal.aborted) {
				if (activeRequest !== requestController) return;
				setProgressStatus(getMessage('readerAiCancelled'));
				return;
			}
			showCardError(getMessage('readerBilingualSubtitles'), error, () => { void toggleBilingual(); });
		} finally {
			finishRequestUi(
				requestController,
				bilingualButton,
				getMessage('readerBilingualSubtitles'),
				requestController.signal.aborted
			);
			finishActiveRequest(requestController);
		}
	};
	bilingualButton.addEventListener('click', (event) => {
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		void toggleBilingual();
	});
	translationsEditButton.addEventListener('click', event => {
		event.preventDefault();
		event.stopPropagation();
		if (!translationsVisible) return;
		translationEditMode = !translationEditMode;
		updateTranslationEditing();
		if (!translationEditMode) persistTranslations();
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

	const readingsRegenerateButton = doc.createElement('button');
	readingsRegenerateButton.type = 'button';
	readingsRegenerateButton.className = 'player-learning-action player-learning-readings-regenerate';
	readingsRegenerateButton.textContent = getMessage('readerRegenerateReadings');
	readingsRegenerateButton.hidden = true;
	controls.appendChild(readingsRegenerateButton);

	let japaneseReadings: TranscriptReadingSegments | null = null;
	let readingsVisible = false;
	let readingEditMode = false;
	let readingsComplete = false;
	const mergeReadings = (indexes: number[], scopedReadings: TranscriptReadingSegments): TranscriptReadingSegments => {
		if (scopedReadings.length !== indexes.length) {
			throw new Error(getMessage('readerReadingIncomplete'));
		}
		const merged = japaneseReadings
			? cloneTranscriptReadings(japaneseReadings)
			: originalTexts.map(() => []);
		indexes.forEach((sourceIndex, scopedIndex) => {
			merged[sourceIndex] = scopedReadings[scopedIndex].map(token => ({ ...token }));
		});
		return merged;
	};
	const hasCompleteReadings = (indexes: number[]) => Boolean(japaneseReadings)
		&& indexes.every(index => isCompleteTranscriptReadings(
			[japaneseReadings?.[index] || []],
			[originalTexts[index]]
		));
	const updateReadingsEditButton = () => {
		const hasGeneratedReadings = Boolean(japaneseReadings?.some(tokens => tokens.length > 0));
		readingsEditButton.hidden = !readingsVisible || !hasGeneratedReadings;
		readingsRegenerateButton.hidden = !readingsVisible || !hasGeneratedReadings;
		readingsEditButton.textContent = readingEditMode
			? getMessage('readerFinishReadingEdit')
			: getMessage('readerEditReadings');
		readingsEditButton.classList.toggle('is-enabled', readingEditMode);
	};
	const updateReading = (segmentIndex: number, tokenIndex: number, reading: string) => {
		const readings = japaneseReadings;
		const token = readings?.[segmentIndex]?.[tokenIndex];
		if (!token || !readings) return;
		token.reading = reading;
		if (reading) {
			void tools.saveJapaneseReadingOverride?.(token.text, reading);
		} else {
			void tools.removeJapaneseReadingOverride?.(token.text);
		}
		if (isCompleteTranscriptReadings(readings, originalTexts)) {
			cacheJapaneseReadings(originalTexts, readings);
		} else {
			removeCachedJapaneseReadings(originalTexts);
		}
		const taskIndexes = getTaskIndexes();
		const checkpointIndexes = taskIndexes.includes(segmentIndex) && hasCompleteReadings(taskIndexes)
			? taskIndexes
			: [segmentIndex];
		void tools.saveJapaneseReadings?.(
			checkpointIndexes.map(index => originalTexts[index]),
			cloneTranscriptReadings(checkpointIndexes.map(index => readings[index]))
		);
	};
	const renderReadings = (show: boolean) => {
		if (!japaneseReadings) return;
		if (!show) readingEditMode = false;
		japaneseReadings.forEach((tokens, index) => {
			if (tokens.length === 0) return;
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
	const generateJapaneseReadings = async () => {
		const taskIndexes = getTaskIndexes();
		const taskTexts = taskIndexes.map(index => originalTexts[index]);
		const requestController = startActiveRequest();
		await beginRequestUi(readingsButton, getMessage('thinking'), taskTexts);
		const setReadingProgress = (progress: TranscriptReadingProgress) => {
			if (progress.readings?.some(tokens => tokens.length > 0)) {
				japaneseReadings = mergeReadings(taskIndexes, progress.readings);
				readingsComplete = isCompleteTranscriptReadings(japaneseReadings, originalTexts);
				renderReadings(true);
			}
			lastTaskProgress = {
				completed: progress.completedSegments,
				total: progress.totalSegments
			};
			taskProgress.max = Math.max(1, progress.total);
			taskProgress.value = progress.completed;
			const label = getMessage('readerJapaneseReadingsProgress', [
				String(progress.completedSegments),
				String(progress.totalSegments)
			]);
			setProgressStatus(label);
		};
		try {
			throwIfRequestAborted(requestController.signal);
			const readings = await tools.annotateJapaneseTranscript(taskTexts, setReadingProgress, requestController.signal);
			throwIfRequestAborted(requestController.signal);
			if (!isCompleteTranscriptReadings(readings, taskTexts)) {
				throw new Error(getMessage('readerReadingIncomplete'));
			}
			japaneseReadings = mergeReadings(taskIndexes, readings);
			readingsComplete = isCompleteTranscriptReadings(japaneseReadings, originalTexts);
			if (readingsComplete) cacheJapaneseReadings(originalTexts, japaneseReadings);
			renderReadings(true);
		} catch (error) {
			if (isRequestCancelled(error) || requestController.signal.aborted) {
				if (activeRequest !== requestController) return;
				setProgressStatus(getMessage('readerAiCancelled'));
				return;
			}
			showCardError(getMessage('readerJapaneseReadings'), error, () => { void toggleJapaneseReadings(); });
		} finally {
			finishRequestUi(
				requestController,
				readingsButton,
				getMessage('readerJapaneseReadings'),
				requestController.signal.aborted
			);
			finishActiveRequest(requestController);
		}
	};
	const toggleJapaneseReadings = async () => {
		const taskIndexes = getTaskIndexes();
		if (japaneseReadings && hasCompleteReadings(taskIndexes)) {
			renderReadings(!readingsVisible);
			return;
		}
		const cachedReadings = getCachedJapaneseReadings(originalTexts);
		if (cachedReadings && isCompleteTranscriptReadings(cachedReadings, originalTexts)) {
			japaneseReadings = cachedReadings;
			readingsComplete = true;
			renderReadings(true);
			return;
		}
		if (cachedReadings) removeCachedJapaneseReadings(originalTexts);

		await generateJapaneseReadings();
	};
	const regenerateJapaneseReadings = async () => {
		if (!japaneseReadings || !readingsVisible) return;
		const taskIndexes = getTaskIndexes();
		const taskTexts = taskIndexes.map(index => originalTexts[index]);
		const remainingReadings = cloneTranscriptReadings(japaneseReadings);
		taskIndexes.forEach(index => {
			const tokens = remainingReadings[index];
			const textElement = segments[index].querySelector('.transcript-segment-text');
			if (textElement) renderTranscriptReadings(doc, textElement, tokens, false, false);
			remainingReadings[index] = [];
		});
		removeCachedJapaneseReadings(originalTexts);
		await tools.clearJapaneseReadings?.(taskTexts);
		japaneseReadings = remainingReadings.some(tokens => tokens.length > 0)
			? remainingReadings
			: null;
		readingsVisible = Boolean(japaneseReadings);
		readingEditMode = false;
		readingsComplete = false;
		transcript.classList.toggle('show-japanese-readings', readingsVisible);
		transcript.classList.remove('is-editing-japanese-readings');
		readingsButton.classList.toggle('is-enabled', readingsVisible);
		updateReadingsEditButton();
		await generateJapaneseReadings();
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
	readingsRegenerateButton.addEventListener('click', event => {
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		if (!window.confirm(getMessage('readerRegenerateReadingsConfirm'))) return;
		void regenerateJapaneseReadings();
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
	const getSelectionFocusTarget = (): HTMLElement | null => {
		const selectionNode = doc.getSelection()?.anchorNode;
		const selectionElement = selectionNode?.nodeType === 1
			? selectionNode as Element
			: selectionNode?.parentElement;
		const sourceSegment = selectionElement?.closest('.transcript-segment') as HTMLElement | null;
		if (sourceSegment && !sourceSegment.hasAttribute('tabindex')) {
			sourceSegment.setAttribute('tabindex', '-1');
		}
		return sourceSegment;
	};

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
		const returnFocus = getSelectionFocusTarget();
		hideSelectionButton();
		await explain(selection, returnFocus || undefined);
	});

	transcript.addEventListener('dblclick', (event) => {
		if (!event.isTrusted) return;
		cancelPendingSeek();
		event.stopPropagation();
		window.setTimeout(() => {
			if (signal.aborted) return;
			const selection = readSelection();
			if (!selection || selection.kind !== 'word') return;
			const returnFocus = getSelectionFocusTarget();
			hideSelectionButton();
			explain(selection, returnFocus || undefined);
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

	return {
		toggleBilingual,
		toggleJapaneseReadings,
		regenerateJapaneseReadings,
		cancelActiveRequest,
		explain,
		setTaskRange,
		showVocabulary
	};
}
