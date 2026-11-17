import { getMessage } from '../../utils/i18n';
import type { TranscriptGrammarAnalysis, TranscriptGrammarLine } from '../../utils/language-learning';
import { throwIfRequestAborted } from '../../ai/abort';
import { cacheGrammarAnalysis, getCachedGrammarAnalysis } from './cache';
import type { GrammarPanel } from './grammar-panel';
import type { TranscriptFeatureContext, TranscriptFlow } from './types';

// Grammar analysis: one request over the selected AI range lists the grammar patterns it uses,
// each with example lines that jump the player to that line. The result opens in the side panel,
// which stays open while examples are followed. It runs on the transcript action, so
// it replaces a running translation or readings task as either of those replaces the other. A
// cached analysis of the same lines opens without a request.

export interface GrammarFeature {
	button: HTMLButtonElement;
	analyze(): Promise<void>;
}

export interface GrammarFeatureOptions {
	panel: GrammarPanel;
	seekToSegment?: (index: number) => void;
}

function segmentTime(segment: HTMLElement): string | undefined {
	return segment.querySelector('.timestamp')?.textContent?.trim() || undefined;
}

export function createGrammarFeature(ctx: TranscriptFeatureContext, { panel, seekToSegment }: GrammarFeatureOptions): GrammarFeature {
	const { doc, segments, originalTexts, tools, responseLanguage, signal, taskBar } = ctx;

	const button = doc.createElement('button');
	button.type = 'button';
	button.className = 'player-learning-action player-learning-grammar';
	button.textContent = getMessage('readerGrammarAnalysis');
	button.hidden = !tools.analyzeTranscriptGrammar;

	const flow: TranscriptFlow = {
		button,
		label: getMessage('readerGrammarAnalysis'),
		title: getMessage('readerGrammarAnalysis'),
		// Grammar analysis runs on the Explanations model; Switch and retry routes that task.
		task: 'explain'
	};

	const timeOf = (id: number) => (segments[id] ? segmentTime(segments[id]) : undefined);
	const jump = (id: number) => {
		const segment = segments[id];
		if (!segment?.isConnected) return;
		// Focus stays on the example in the panel, so the next example is one Tab away.
		segment.scrollIntoView({ block: 'center' });
		seekToSegment?.(id);
	};
	const show = (analysis: TranscriptGrammarAnalysis) => {
		if (signal.aborted) return;
		panel.show(getMessage('readerGrammarAnalysis'), analysis, { timeOf, onJump: jump, returnFocus: button });
	};

	const analyze = async () => {
		const analyzeGrammar = tools.analyzeTranscriptGrammar;
		if (signal.aborted || !analyzeGrammar) return;
		const lines: TranscriptGrammarLine[] = taskBar.getTaskIndexes().map(id => {
			const time = timeOf(id);
			return { id, ...(time ? { time } : {}), text: originalTexts[id] };
		});
		const cached = getCachedGrammarAnalysis(lines, responseLanguage);
		if (cached) {
			show(cached);
			return;
		}
		await ctx.runTranscriptTask(flow, async runSignal => {
			throwIfRequestAborted(runSignal);
			taskBar.setStatus(getMessage('readerGrammarAnalyzing'));
			const analysis = await analyzeGrammar(lines, runSignal);
			throwIfRequestAborted(runSignal);
			cacheGrammarAnalysis(lines, responseLanguage, analysis);
			show(analysis);
		});
	};

	button.addEventListener('click', event => {
		// The analysis is a paid request: a click the page synthesized does nothing.
		if (!event.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		if (button.getAttribute('aria-disabled') === 'true') return;
		void analyze();
	});

	return { button, analyze };
}
