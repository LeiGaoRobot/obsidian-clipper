import { getMessage } from '../../utils/i18n';
import { createAiAction, type AiActionRun, type AiActionStatus } from '../../ai/ui/action';
import { createLearningCard } from './card';
import { createExplainFeature } from './explain';
import { createReadingsFeature } from './readings';
import { getOriginalSegmentText, wireSelectionTrigger } from './selection';
import { createTaskBar } from './task-bar';
import { createTranslationsFeature } from './translations';
import type {
	TranscriptFeatureContext,
	TranscriptFlow,
	TranscriptLanguageLearningController,
	TranscriptLanguageLearningOptions,
	TranscriptRestoreState
} from './types';

// Reader transcript learning: composes the task bar, the learning card, bilingual subtitles,
// Japanese readings, explanations and the selection trigger for one transcript. Two action
// controllers carry the model work: one per transcript (bilingual and readings share it, so a new
// transcript task aborts the previous one) and one for explanations. Nothing here starts model
// work on its own: only trusted user actions and the returned controller's methods do.

export type {
	ReaderAiTask,
	TranscriptExecutionInfo,
	TranscriptLanguageLearning,
	TranscriptLanguageLearningController,
	TranscriptLanguageLearningOptions,
	TranscriptProfileOption,
	TranscriptTaskRange
} from './types';
export { clearTranscriptLanguageLearningCache } from './cache';
export { isJapaneseTranscript, shouldOfferJapaneseReadings } from './japanese';
export { getTranscriptLearningSelection } from './selection';

/** Disposes a document's wiring: listeners, timers, and both controllers with their requests. */
const wiredDocuments = new WeakMap<Document, () => void>();

const LEARNING_CONTROL_SELECTOR = [
	'.player-learning-bilingual',
	'.player-learning-translations-edit',
	'.player-learning-vocabulary',
	'.player-learning-range',
	'.player-learning-task',
	'.player-learning-readings',
	'.player-learning-readings-edit',
	'.player-learning-readings-regenerate'
].join(', ');

export function cleanupTranscriptLanguageLearning(doc: Document): void {
	wiredDocuments.get(doc)?.();
	wiredDocuments.delete(doc);
	doc.querySelector('.language-learning-selection-action')?.remove();
	doc.querySelectorAll(LEARNING_CONTROL_SELECTOR).forEach(element => element.remove());
	doc.querySelector('.language-learning-card')?.remove();
}

export function wireTranscriptLanguageLearning({
	doc,
	transcript,
	segments,
	controls,
	tools,
	responseLanguage,
	restoreBilingualSubtitles,
	restoreJapaneseReadings,
	onPreferenceChange,
	cancelPendingSeek
}: TranscriptLanguageLearningOptions): TranscriptLanguageLearningController {
	cleanupTranscriptLanguageLearning(doc);
	const wiring = new AbortController();
	const { signal } = wiring;
	const originalTexts = segments.map(getOriginalSegmentText);
	const restore: TranscriptRestoreState = {
		promise: Promise.resolve(),
		complete: !restoreBilingualSubtitles && !restoreJapaneseReadings
	};

	let cancelAll = () => {};
	// The modal card hides the task bar's Cancel, so closing an explanation's card cancels that
	// explanation, and only it: a running transcript task keeps running.
	let cancelExplanation = () => {};
	const card = createLearningCard({
		doc,
		tools,
		signal,
		onClose: owner => { if (owner === 'explain') cancelExplanation(); }
	});
	const taskBar = createTaskBar({ doc, segments, tools, onCancel: () => cancelAll() });

	// The flow whose button shows the running transcript task.
	let activeFlow: TranscriptFlow | undefined;
	let busyFlow: TranscriptFlow | undefined;
	// How the transcript run or explanation that settled last ended.
	let lastEnded: AiActionStatus | undefined;
	// A busy toggle keeps its name and focus: it shows a spinner, is `aria-disabled` (its click
	// handler ignores activations), and the pill carries the progress.
	const setFlowBusy = (flow: TranscriptFlow, busy: boolean) => {
		flow.button.classList.toggle('is-loading', busy);
		flow.button.textContent = flow.label;
		if (busy) {
			flow.button.setAttribute('aria-busy', 'true');
			flow.button.setAttribute('aria-disabled', 'true');
		} else {
			flow.button.removeAttribute('aria-busy');
			flow.button.removeAttribute('aria-disabled');
		}
	};
	const retryTranscript = () => { void transcriptAction.retry(); };
	const transcriptAction = createAiAction<void>({
		onChange(state) {
			if (signal.aborted) return;
			if (state.status === 'running') {
				// A progress report keeps the run's progress; a new run starts without one.
				if (state.progress) return;
				card.hide();
				if (busyFlow && busyFlow !== activeFlow) setFlowBusy(busyFlow, false);
				busyFlow = activeFlow;
				if (busyFlow) setFlowBusy(busyFlow, true);
				taskBar.begin();
				syncPill();
				return;
			}
			if (busyFlow) setFlowBusy(busyFlow, false);
			busyFlow = undefined;
			taskBar.finish(state.status);
			lastEnded = state.status;
			syncPill();
			if (state.status === 'error' && state.error && activeFlow) {
				const progress = state.progress;
				card.showError('transcript', activeFlow.title, state.error, {
					task: activeFlow.task,
					profileId: taskBar.executionInfo?.profileId,
					...(progress ? { progress: { completed: progress.completed, total: progress.total } } : {}),
					retry: retryTranscript,
					onProfileSwitched: option => taskBar.useProfile(option)
				});
			}
		}
	});
	const runTranscriptTask = async (flow: TranscriptFlow, run: AiActionRun<void>) => {
		activeFlow = flow;
		await transcriptAction.start(run);
	};

	const explanations = createExplainFeature({
		tools,
		card,
		responseLanguage,
		signal,
		onRequestChange(state) {
			if (signal.aborted) return;
			if (state.status !== 'running') lastEnded = state.status;
			syncPill();
		}
	});
	// The pill is derived from both controllers: a running transcript task shows its progress (the
	// task bar owns that text); otherwise a running explanation says Thinking…, quietly, since its
	// card announces it; otherwise the run that ended last says it was cancelled, or the pill hides.
	const syncPill = () => {
		const transcriptRunning = transcriptAction.state.status === 'running';
		if (!transcriptRunning) {
			if (explanations.running) taskBar.setStatus(getMessage('thinking'), { quiet: true });
			else if (lastEnded === 'cancelled') taskBar.setStatus(getMessage('readerAiCancelled'));
			else taskBar.clearStatus();
		}
		taskBar.setCancelVisible(transcriptRunning || explanations.running);
	};
	cancelAll = () => {
		transcriptAction.cancel();
		explanations.cancel();
	};
	cancelExplanation = () => explanations.cancel();

	const context: TranscriptFeatureContext = {
		doc,
		transcript,
		segments,
		originalTexts,
		tools,
		responseLanguage,
		signal,
		taskBar,
		restore,
		runTranscriptTask,
		onPreferenceChange
	};
	const translations = createTranslationsFeature(context);
	const readings = createReadingsFeature(context);

	const vocabularyButton = doc.createElement('button');
	vocabularyButton.type = 'button';
	vocabularyButton.className = 'player-learning-action player-learning-vocabulary';
	vocabularyButton.textContent = getMessage('readerSavedVocabulary');
	vocabularyButton.hidden = !tools.listVocabulary;
	vocabularyButton.addEventListener('click', event => {
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		void card.showCenter();
	});

	controls.append(
		taskBar.rangeControl,
		translations.bilingualButton,
		vocabularyButton,
		translations.editButton,
		taskBar.element,
		readings.button,
		readings.editButton,
		readings.regenerateButton
	);

	wireSelectionTrigger({
		doc,
		transcript,
		segments,
		originalTexts,
		signal,
		cancelPendingSeek,
		explain: (selection, returnFocus) => explanations.explain(selection, returnFocus)
	});

	wiredDocuments.set(doc, () => {
		// Abort first: the controllers' cancellation then changes no view that is being removed.
		wiring.abort();
		transcriptAction.dispose();
		explanations.dispose();
		taskBar.dispose();
	});

	restore.promise = (async () => {
		if (restoreBilingualSubtitles) await translations.restore();
		if (restoreJapaneseReadings) await readings.restore();
	})()
		.catch(() => {
			// Restoring local checkpoints is best-effort and never starts a paid request.
		})
		.finally(() => { restore.complete = true; });

	return {
		ready: restore.promise,
		toggleBilingual: translations.toggle,
		toggleJapaneseReadings: readings.toggle,
		regenerateJapaneseReadings: readings.regenerate,
		cancelActiveRequest: () => cancelAll(),
		explain: (selection, returnFocus) => explanations.explain(selection, returnFocus),
		setTaskRange: range => taskBar.setTaskRange(range),
		showVocabulary: () => card.showCenter()
	};
}
