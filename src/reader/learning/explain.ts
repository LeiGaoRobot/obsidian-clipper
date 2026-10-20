import { getMessage } from '../../utils/i18n';
import type { LearningSelection } from '../../utils/language-learning';
import { createAiAction, type AiActionState } from '../../ai/ui/action';
import { cacheExplanation, getCachedExplanation } from './cache';
import { throwIfRequestAborted } from '../../ai/abort';
import type { LearningCard } from './card';
import type { TranscriptLanguageLearning } from './types';

// Explanations of a selected word or sentence. They run on their own action, so an explanation
// does not cancel a running transcript task; a newer explanation supersedes an older one, whose
// late result changes nothing. A cached explanation runs through the same action without a request.

export interface ExplainFeature {
	explain(selection: LearningSelection, returnFocus?: HTMLElement): Promise<void>;
	readonly running: boolean;
	cancel(): void;
	dispose(): void;
}

export interface ExplainFeatureOptions {
	tools: TranscriptLanguageLearning;
	card: LearningCard;
	responseLanguage: string;
	signal: AbortSignal;
	/** Every transition of a request that reaches the model, for the task bar. */
	onRequestChange?: (state: AiActionState) => void;
}

export function createExplainFeature({
	tools,
	card,
	responseLanguage,
	signal,
	onRequestChange
}: ExplainFeatureOptions): ExplainFeature {
	let current: { selection: LearningSelection; cached: boolean } | undefined;
	let pendingReturnFocus: HTMLElement | undefined;

	const action = createAiAction<void>({
		onChange(state) {
			if (signal.aborted || !current) return;
			const { selection, cached } = current;
			if (state.status === 'running') {
				card.rememberReturnFocus(pendingReturnFocus);
				pendingReturnFocus = undefined;
				// Closing the card (or its Cancel) cancels this explanation; see `onClose` in index.ts.
				card.showMessage('explain', selection.text, getMessage('thinking'), { cancellable: true });
			} else if (state.status === 'error' && state.error) {
				card.showError('explain', selection.text, state.error, {
					task: 'explain',
					retry: () => { void action.retry(); }
				});
			} else if (state.status === 'cancelled' && card.owner === 'explain') {
				card.hide();
			}
			if (!cached) onRequestChange?.(state);
		}
	});

	return {
		async explain(selection, returnFocus) {
			if (signal.aborted) return;
			const cached = getCachedExplanation(selection, responseLanguage);
			current = { selection, cached: Boolean(cached) };
			pendingReturnFocus = returnFocus;
			await action.start(async runSignal => {
				const explanation = cached ?? await tools.explainSelection(selection, runSignal);
				throwIfRequestAborted(runSignal);
				if (!cached && explanation) cacheExplanation(selection, responseLanguage, explanation);
				await card.showExplanation(selection, explanation || getMessage('emptyResponse'));
			});
		},
		get running() {
			return action.state.status === 'running';
		},
		cancel: () => action.cancel(),
		dispose: () => action.dispose()
	};
}
