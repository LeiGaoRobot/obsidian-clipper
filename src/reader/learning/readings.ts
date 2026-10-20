import { getMessage } from '../../utils/i18n';
import {
	TranscriptReadingSegments,
	isCompleteTranscriptReadings,
	isCompleteTranscriptTranslationSegment,
	isCompleteTranscriptTranslations
} from '../../utils/language-learning';
import { throwIfRequestAborted } from '../../ai/abort';
import type { AiActionProgress } from '../../ai/ui/action';
import {
	cacheJapaneseReadings,
	cacheJapaneseTranslations,
	cloneTranscriptReadings,
	getCachedJapaneseReadings,
	getCachedJapaneseTranslations,
	removeCachedJapaneseReadings
} from './cache';
import { readerIncompleteError } from './card';
import { isJapaneseTranscript, shouldOfferJapaneseReadings } from './japanese';
import { renderJapaneseTranslationReadings, renderTranscriptReadings } from './readings-render';
import type { TranscriptFeatureContext, TranscriptFlow } from './types';

// Japanese readings: ruby over a Japanese source, or over a fixed Japanese translation of a
// non-Japanese source (which is translated first), with edit, regenerate, and restore. Readings
// stay aligned to their source index, and a run that misses a segment is rejected.

export interface ReadingsFeature {
	button: HTMLButtonElement;
	editButton: HTMLButtonElement;
	regenerateButton: HTMLButtonElement;
	toggle(): Promise<void>;
	regenerate(): Promise<void>;
	/** Shows saved readings without model work. */
	restore(): Promise<void>;
}

export function createReadingsFeature(ctx: TranscriptFeatureContext): ReadingsFeature {
	const { doc, transcript, segments, originalTexts, tools, signal, taskBar, restore } = ctx;
	const transcriptLanguage = transcript.dataset.transcriptLanguage;
	const sourceIsJapanese = isJapaneseTranscript(originalTexts, transcriptLanguage);

	const createButton = (className: string, label: string, hidden: boolean) => {
		const button = doc.createElement('button');
		button.type = 'button';
		button.className = `player-learning-action ${className}`;
		button.textContent = label;
		button.hidden = hidden;
		return button;
	};
	const button = createButton(
		'player-learning-readings',
		getMessage('readerJapaneseReadings'),
		!shouldOfferJapaneseReadings(originalTexts, transcriptLanguage)
	);
	const editButton = createButton('player-learning-readings-edit', getMessage('readerEditReadings'), true);
	const regenerateButton = createButton('player-learning-readings-regenerate', getMessage('readerRegenerateReadings'), true);

	const flow: TranscriptFlow = {
		button,
		label: getMessage('readerJapaneseReadings'),
		title: getMessage('readerJapaneseReadings'),
		task: 'reading'
	};

	let japaneseTranslationValues = new Array<string>(originalTexts.length).fill('');
	let readings: TranscriptReadingSegments | null = null;
	let visible = false;
	let editMode = false;

	const getReadingSourceText = (index: number): string => sourceIsJapanese
		? originalTexts[index]
		: japaneseTranslationValues[index];
	const getAllReadingSourceTexts = (): string[] => originalTexts.map((_, index) => getReadingSourceText(index));
	const hasAllReadingSourceTexts = (): boolean => sourceIsJapanese
		|| isCompleteTranscriptTranslations(japaneseTranslationValues, originalTexts);
	const hasCompleteFullReadings = (value: TranscriptReadingSegments | null): value is TranscriptReadingSegments => {
		if (!value || !hasAllReadingSourceTexts()) return false;
		return isCompleteTranscriptReadings(value, getAllReadingSourceTexts());
	};
	const merge = (indexes: number[], scopedReadings: TranscriptReadingSegments): TranscriptReadingSegments => {
		if (scopedReadings.length !== indexes.length) {
			throw readerIncompleteError('readerReadingIncomplete', 'reading');
		}
		const merged = readings
			? cloneTranscriptReadings(readings)
			: originalTexts.map(() => []);
		indexes.forEach((sourceIndex, scopedIndex) => {
			merged[sourceIndex] = scopedReadings[scopedIndex].map(token => ({ ...token }));
		});
		return merged;
	};
	const hasCompleteReadings = (indexes: number[]) => Boolean(readings)
		&& indexes.every(index => {
			const sourceText = getReadingSourceText(index);
			if (!sourceIsJapanese && !isCompleteTranscriptTranslationSegment(sourceText, originalTexts[index])) return false;
			return isCompleteTranscriptReadings([readings?.[index] || []], [sourceText]);
		});
	const updateEditButtons = () => {
		const hasGeneratedReadings = Boolean(readings?.some(tokens => tokens.length > 0));
		editButton.hidden = !visible || !hasGeneratedReadings;
		regenerateButton.hidden = !visible || !hasGeneratedReadings;
		editButton.textContent = editMode
			? getMessage('readerFinishReadingEdit')
			: getMessage('readerEditReadings');
		editButton.classList.toggle('is-enabled', editMode);
	};
	const updateReading = (segmentIndex: number, tokenIndex: number, reading: string) => {
		const current = readings;
		const token = current?.[segmentIndex]?.[tokenIndex];
		if (!token || !current) return;
		token.reading = reading;
		if (reading) {
			void tools.saveJapaneseReadingOverride?.(token.text, reading);
		} else {
			void tools.removeJapaneseReadingOverride?.(token.text);
		}
		if (hasCompleteFullReadings(current)) {
			cacheJapaneseReadings(getAllReadingSourceTexts(), current);
		} else if (hasAllReadingSourceTexts()) {
			removeCachedJapaneseReadings(getAllReadingSourceTexts());
		}
		const taskIndexes = taskBar.getTaskIndexes();
		const checkpointIndexes = taskIndexes.includes(segmentIndex) && hasCompleteReadings(taskIndexes)
			? taskIndexes
			: [segmentIndex];
		void tools.saveJapaneseReadings?.(
			checkpointIndexes.map(index => getReadingSourceText(index)),
			cloneTranscriptReadings(checkpointIndexes.map(index => current[index]))
		);
	};
	const render = (show: boolean) => {
		if (!readings) return;
		if (!show) editMode = false;
		readings.forEach((tokens, index) => {
			if (tokens.length === 0) return;
			const textElement = segments[index].querySelector('.transcript-segment-text');
			const onReadingInput = (tokenIndex: number, reading: string) => updateReading(index, tokenIndex, reading);
			if (textElement && sourceIsJapanese) {
				renderTranscriptReadings(doc, textElement, tokens, show, editMode, onReadingInput);
			} else if (textElement) {
				renderJapaneseTranslationReadings(doc, textElement, tokens, show, editMode, onReadingInput);
			}
		});
		visible = show;
		transcript.classList.toggle('show-japanese-readings', show);
		transcript.classList.toggle('is-editing-japanese-readings', show && editMode);
		button.classList.toggle('is-enabled', show);
		updateEditButtons();
	};

	const ensureJapaneseTaskTexts = async (
		taskIndexes: number[],
		runSignal: AbortSignal,
		report: (progress: AiActionProgress) => void
	): Promise<string[]> => {
		if (sourceIsJapanese) return taskIndexes.map(index => originalTexts[index]);
		const existing = taskIndexes.map(index => japaneseTranslationValues[index]);
		const sourceTexts = taskIndexes.map(index => originalTexts[index]);
		if (isCompleteTranscriptTranslations(existing, sourceTexts)) return existing;
		if (taskBar.getTaskRange() === 'all') {
			const localTranslations = getCachedJapaneseTranslations(originalTexts)
				?? await tools.loadJapaneseTranscriptTranslations?.(originalTexts);
			if (localTranslations && isCompleteTranscriptTranslations(localTranslations, originalTexts)) {
				japaneseTranslationValues = [...localTranslations];
				cacheJapaneseTranslations(originalTexts, localTranslations);
				return taskIndexes.map(index => localTranslations[index]);
			}
		}
		if (!tools.translateTranscriptToJapanese) {
			throw readerIncompleteError('readerTranslationIncomplete', 'translate');
		}
		const translations = await tools.translateTranscriptToJapanese(sourceTexts, progress => {
			if (runSignal.aborted) return;
			report({ completed: progress.completed, total: progress.total });
			taskBar.setProgress(progress.completed, progress.total, getMessage('readerJapaneseTranslationProgress', [
				String(progress.completed),
				String(progress.total)
			]), progress.retry);
		}, runSignal);
		throwIfRequestAborted(runSignal);
		if (!isCompleteTranscriptTranslations(translations, sourceTexts)) {
			throw readerIncompleteError('readerTranslationIncomplete', 'translate');
		}
		taskIndexes.forEach((sourceIndex, scopedIndex) => {
			japaneseTranslationValues[sourceIndex] = translations[scopedIndex];
		});
		if (taskBar.getTaskRange() === 'all' && isCompleteTranscriptTranslations(japaneseTranslationValues, originalTexts)) {
			cacheJapaneseTranslations(originalTexts, japaneseTranslationValues);
		}
		return [...translations];
	};

	/** Generates readings for the selected range; `persistPreference` remembers a shown result. */
	const generate = (persistPreference: boolean) => {
		const taskIndexes = taskBar.getTaskIndexes();
		const sourceTaskTexts = taskIndexes.map(index => originalTexts[index]);
		return ctx.runTranscriptTask(flow, async (runSignal, report) => {
			try {
				throwIfRequestAborted(runSignal);
				await taskBar.loadExecutionInfo('reading', sourceTaskTexts);
				throwIfRequestAborted(runSignal);
				const taskTexts = await ensureJapaneseTaskTexts(taskIndexes, runSignal, report);
				throwIfRequestAborted(runSignal);
				const annotated = await tools.annotateJapaneseTranscript(taskTexts, progress => {
					if (runSignal.aborted) return;
					if (progress.readings?.some(tokens => tokens.length > 0)) {
						readings = merge(taskIndexes, progress.readings);
						render(true);
					}
					report({ completed: progress.completedSegments, total: progress.totalSegments });
					taskBar.setProgress(progress.completed, progress.total, getMessage('readerJapaneseReadingsProgress', [
						String(progress.completedSegments),
						String(progress.totalSegments)
					]), progress.retry);
				}, runSignal);
				throwIfRequestAborted(runSignal);
				if (!isCompleteTranscriptReadings(annotated, taskTexts)) {
					throw readerIncompleteError('readerReadingIncomplete', 'reading');
				}
				readings = merge(taskIndexes, annotated);
				if (hasCompleteFullReadings(readings)) cacheJapaneseReadings(getAllReadingSourceTexts(), readings);
				render(true);
			} finally {
				// Partial readings that are shown count too, as before the run settled.
				if (persistPreference && visible && !signal.aborted) ctx.onPreferenceChange?.('japaneseReadings', true);
			}
		});
	};

	const toggle = async () => {
		const wasRestoring = !restore.complete;
		if (wasRestoring) await restore.promise;
		if (signal.aborted) return;
		if (wasRestoring && visible) return;
		const taskIndexes = taskBar.getTaskIndexes();
		if (readings && hasCompleteReadings(taskIndexes)) {
			render(!visible);
			ctx.onPreferenceChange?.('japaneseReadings', visible);
			return;
		}
		const allReadingTexts = hasAllReadingSourceTexts() ? getAllReadingSourceTexts() : null;
		const cachedReadings = allReadingTexts ? getCachedJapaneseReadings(allReadingTexts) : null;
		if (cachedReadings && allReadingTexts && isCompleteTranscriptReadings(cachedReadings, allReadingTexts)) {
			readings = cachedReadings;
			render(true);
			ctx.onPreferenceChange?.('japaneseReadings', true);
			return;
		}
		if (cachedReadings && allReadingTexts) removeCachedJapaneseReadings(allReadingTexts);
		await generate(true);
	};

	const regenerate = async () => {
		if (!restore.complete) await restore.promise;
		if (signal.aborted) return;
		if (!readings || !visible) return;
		const taskIndexes = taskBar.getTaskIndexes();
		const taskTexts = taskIndexes.map(index => getReadingSourceText(index));
		const remainingReadings = cloneTranscriptReadings(readings);
		taskIndexes.forEach(index => {
			const tokens = remainingReadings[index];
			const textElement = segments[index].querySelector('.transcript-segment-text');
			if (textElement && sourceIsJapanese) {
				renderTranscriptReadings(doc, textElement, tokens, false, false);
			} else if (textElement) {
				renderJapaneseTranslationReadings(doc, textElement, tokens, false, false);
			}
			remainingReadings[index] = [];
		});
		const allReadingTexts = hasAllReadingSourceTexts() ? getAllReadingSourceTexts() : null;
		if (allReadingTexts) removeCachedJapaneseReadings(allReadingTexts);
		await tools.clearJapaneseReadings?.(taskTexts);
		// A saved record of the whole transcript still holds the old readings of this range.
		if (allReadingTexts && taskIndexes.length !== originalTexts.length) {
			await tools.clearJapaneseReadings?.(allReadingTexts);
		}
		readings = remainingReadings.some(tokens => tokens.length > 0) ? remainingReadings : null;
		visible = Boolean(readings);
		editMode = false;
		transcript.classList.toggle('show-japanese-readings', visible);
		transcript.classList.remove('is-editing-japanese-readings');
		button.classList.toggle('is-enabled', visible);
		updateEditButtons();
		await generate(false);
	};

	editButton.addEventListener('click', event => {
		event.preventDefault();
		event.stopPropagation();
		if (!readings || !visible) return;
		editMode = !editMode;
		render(true);
	});
	button.addEventListener('click', event => {
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		void toggle();
	});
	regenerateButton.addEventListener('click', event => {
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		if (!window.confirm(getMessage('readerRegenerateReadingsConfirm'))) return;
		void regenerate();
	});

	return {
		button,
		editButton,
		regenerateButton,
		toggle,
		regenerate,
		async restore() {
			if (!shouldOfferJapaneseReadings(originalTexts, transcriptLanguage)) return;
			let readingTexts: string[] | undefined;
			if (sourceIsJapanese) {
				readingTexts = originalTexts;
			} else {
				const savedTranslations = getCachedJapaneseTranslations(originalTexts)
					?? await tools.loadJapaneseTranscriptTranslations?.(originalTexts);
				if (savedTranslations && isCompleteTranscriptTranslations(savedTranslations, originalTexts)) {
					japaneseTranslationValues = [...savedTranslations];
					cacheJapaneseTranslations(originalTexts, savedTranslations);
					readingTexts = savedTranslations;
				}
			}
			if (!readingTexts) return;
			const savedReadings = getCachedJapaneseReadings(readingTexts)
				?? await tools.loadJapaneseReadings?.(readingTexts);
			if (!signal.aborted && savedReadings && isCompleteTranscriptReadings(savedReadings, readingTexts)) {
				readings = cloneTranscriptReadings(savedReadings);
				render(true);
			}
		}
	};
}
