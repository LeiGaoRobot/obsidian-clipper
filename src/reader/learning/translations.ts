import { getMessage } from '../../utils/i18n';
import {
	isCompleteTranscriptTranslationSegment,
	isCompleteTranscriptTranslations
} from '../../utils/language-learning';
import { throwIfRequestAborted } from '../../ai/abort';
import { cacheTranslations, getCachedTranslations, removeCachedTranslations } from './cache';
import { readerIncompleteError } from './card';
import type { TranscriptFeatureContext, TranscriptFlow } from './types';

// Bilingual subtitles: aligned translations rendered under each source segment, edit mode, and the
// restore of saved translations. Each translation stays attached to its source index, and a
// translation run that misses a segment is rejected instead of shown as complete.

export interface TranslationsFeature {
	bilingualButton: HTMLButtonElement;
	editButton: HTMLButtonElement;
	toggle(): Promise<void>;
	/** Shows saved translations without model work; incomplete saved work is ignored. */
	restore(): Promise<void>;
}

export function createTranslationsFeature(ctx: TranscriptFeatureContext): TranslationsFeature {
	const { doc, transcript, segments, originalTexts, tools, responseLanguage, signal, taskBar, restore } = ctx;

	const bilingualButton = doc.createElement('button');
	bilingualButton.type = 'button';
	bilingualButton.className = 'player-learning-action player-learning-bilingual';
	bilingualButton.textContent = getMessage('readerBilingualSubtitles');

	const editButton = doc.createElement('button');
	editButton.type = 'button';
	editButton.className = 'player-learning-action player-learning-translations-edit';
	editButton.textContent = getMessage('readerEditTranslations');
	editButton.hidden = true;

	const flow: TranscriptFlow = {
		button: bilingualButton,
		label: getMessage('readerBilingualSubtitles'),
		title: getMessage('readerBilingualSubtitles'),
		task: 'translate'
	};

	let visible = false;
	let editMode = false;
	let values = new Array<string>(originalTexts.length).fill('');

	const persist = () => {
		if (isCompleteTranscriptTranslations(values, originalTexts)) {
			cacheTranslations(originalTexts, responseLanguage, values);
		}
		void tools.saveTranscriptTranslations?.(originalTexts, [...values]);
	};
	const updateEditButton = () => {
		editButton.hidden = !visible || !values.some(translation => translation.trim());
		editButton.textContent = editMode
			? getMessage('readerFinishTranslationEdit')
			: getMessage('readerEditTranslations');
		editButton.classList.toggle('is-enabled', editMode);
	};
	const updateEditing = () => {
		segments.forEach((segment, index) => {
			const translationElement = segment.querySelector<HTMLElement>('.transcript-segment-translation');
			if (!translationElement) return;
			translationElement.setAttribute('contenteditable', editMode ? 'true' : 'false');
			if (editMode) {
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
		transcript.classList.toggle('is-editing-translations', editMode);
		updateEditButton();
	};
	const render = (translations: string[], complete: boolean) => {
		if (translations.length !== originalTexts.length) {
			throw readerIncompleteError('readerTranslationIncomplete', 'translate');
		}
		translations.forEach((translation, index) => {
			if (!translation.trim()) return;
			const textElement = segments[index].querySelector('.transcript-segment-text');
			if (!textElement) throw readerIncompleteError('readerTranslationIncomplete', 'translate');
			let translationElement = textElement.querySelector('.transcript-segment-translation') as HTMLElement | null;
			if (!translationElement) {
				translationElement = doc.createElement('div');
				translationElement.className = 'transcript-segment-translation';
				translationElement.addEventListener('input', () => {
					values[index] = translationElement?.textContent?.trim() || '';
					persist();
				});
				const japaneseElement = textElement.querySelector('.transcript-segment-japanese');
				if (japaneseElement) {
					textElement.insertBefore(translationElement, japaneseElement);
				} else {
					textElement.appendChild(translationElement);
				}
			}
			translationElement.textContent = translation;
		});
		values = [...translations];
		visible = true;
		transcript.classList.add('show-bilingual-transcript');
		transcript.classList.toggle('has-partial-bilingual-transcript', !complete);
		bilingualButton.classList.add('is-enabled');
		updateEditing();
	};
	const apply = (translations: string[]) => {
		if (!isCompleteTranscriptTranslations(translations, originalTexts)) {
			throw readerIncompleteError('readerTranslationIncomplete', 'translate');
		}
		render(translations, true);
	};
	const merge = (indexes: number[], scopedTranslations: string[]): string[] => {
		if (scopedTranslations.length !== indexes.length) {
			throw readerIncompleteError('readerTranslationIncomplete', 'translate');
		}
		const merged = [...values];
		indexes.forEach((sourceIndex, scopedIndex) => {
			merged[sourceIndex] = scopedTranslations[scopedIndex] || '';
		});
		return merged;
	};

	const toggle = async () => {
		const wasRestoring = !restore.complete;
		if (wasRestoring) await restore.promise;
		if (signal.aborted) return;
		if (wasRestoring && visible) return;
		const taskIndexes = taskBar.getTaskIndexes();
		const selectedRangeLoaded = taskIndexes.every(index => (
			isCompleteTranscriptTranslationSegment(values[index], originalTexts[index])
		));
		if (selectedRangeLoaded) {
			visible = !visible;
			if (!visible) editMode = false;
			transcript.classList.toggle('show-bilingual-transcript', visible);
			bilingualButton.classList.toggle('is-enabled', visible);
			updateEditing();
			ctx.onPreferenceChange?.('bilingualSubtitles', visible);
			return;
		}

		const cachedTranslations = taskBar.getTaskRange() === 'all'
			? getCachedTranslations(originalTexts, responseLanguage)
			: null;
		if (cachedTranslations) {
			try {
				apply(cachedTranslations);
				ctx.onPreferenceChange?.('bilingualSubtitles', true);
				return;
			} catch {
				removeCachedTranslations(originalTexts, responseLanguage);
			}
		}

		const taskTexts = taskIndexes.map(index => originalTexts[index]);
		await ctx.runTranscriptTask(flow, async (runSignal, report) => {
			throwIfRequestAborted(runSignal);
			await taskBar.loadExecutionInfo('translate', taskTexts);
			throwIfRequestAborted(runSignal);
			const translations = await tools.translateTranscript(taskTexts, progress => {
				if (runSignal.aborted) return;
				if (progress.translations?.some(translation => translation.trim())) {
					render(merge(taskIndexes, progress.translations), false);
				}
				report({ completed: progress.completed, total: progress.total });
				taskBar.setProgress(
					progress.completedSegments,
					progress.totalSegments,
					getMessage('readerTaskPhaseTranslate'),
					progress.retry
				);
			}, runSignal);
			throwIfRequestAborted(runSignal);
			if (!isCompleteTranscriptTranslations(translations, taskTexts)) {
				throw readerIncompleteError('readerTranslationIncomplete', 'translate');
			}
			const merged = merge(taskIndexes, translations);
			const complete = isCompleteTranscriptTranslations(merged, originalTexts);
			render(merged, complete);
			if (complete) cacheTranslations(originalTexts, responseLanguage, merged);
			ctx.onPreferenceChange?.('bilingualSubtitles', true);
		});
	};

	bilingualButton.addEventListener('click', event => {
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		void toggle();
	});
	editButton.addEventListener('click', event => {
		event.preventDefault();
		event.stopPropagation();
		if (!visible) return;
		editMode = !editMode;
		updateEditing();
		if (!editMode) persist();
	});

	return {
		bilingualButton,
		editButton,
		toggle,
		async restore() {
			const saved = getCachedTranslations(originalTexts, responseLanguage)
				?? await tools.loadTranscriptTranslations?.(originalTexts);
			if (signal.aborted || !saved) return;
			try {
				apply(saved);
			} catch {
				// Ignore incomplete saved work; a user action can retry it explicitly.
			}
		}
	};
}
