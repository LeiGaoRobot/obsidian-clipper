import { getMessage } from '../../utils/i18n';
import type { TranscriptGrammarAnalysis } from '../../utils/language-learning';
import type { TranscriptLanguageLearning } from './types';

// The Reader's grammar panel: a non-modal side panel docked at the right edge of the viewport. It
// stays open while the user reads the transcript, so example lines can be followed one after
// another: an example scrolls to its line and plays from there without closing the panel. While
// open it reserves its width through `--learning-panel-width`, so the Reader content narrows
// instead of sliding under it. The page can script this document, so its controls ignore
// untrusted clicks.

export const GRAMMAR_PANEL_CLASS = 'language-learning-grammar-panel';
export const LEARNING_PANEL_WIDTH_PROPERTY = '--learning-panel-width';

export interface GrammarPanelShowOptions {
	/** The timestamp label of a source segment. */
	timeOf: (id: number) => string | undefined;
	/** Called after a trusted click on an example; the panel stays open. */
	onJump: (id: number) => void;
	/** Where focus returns when the panel closes. */
	returnFocus?: HTMLElement;
}

export interface GrammarPanel {
	element: HTMLElement;
	readonly isOpen: boolean;
	show(title: string, analysis: TranscriptGrammarAnalysis, options: GrammarPanelShowOptions): void;
	hide(): void;
}

export interface GrammarPanelOptions {
	doc: Document;
	tools: TranscriptLanguageLearning;
	/** Aborted when the Reader rewires or navigates; removes the panel and its reserved width. */
	signal: AbortSignal;
}

/** The analysis as Markdown, for Copy. */
export function formatGrammarAnalysis(analysis: TranscriptGrammarAnalysis, timeOf: (id: number) => string | undefined): string {
	return analysis.points.map(point => [
		`## ${point.pattern}${point.level ? ` (${point.level})` : ''}`,
		point.meaning,
		...point.examples.map(example => {
			const time = timeOf(example.id);
			return `- ${time ? `${time} ` : ''}${example.quote}`;
		})
	].join('\n')).join('\n\n');
}

export function removeGrammarPanel(doc: Document): void {
	doc.querySelector(`.${GRAMMAR_PANEL_CLASS}`)?.remove();
	doc.documentElement.style.removeProperty(LEARNING_PANEL_WIDTH_PROPERTY);
}

export function createGrammarPanel({ doc, tools, signal }: GrammarPanelOptions): GrammarPanel {
	const panel = doc.createElement('aside');
	panel.className = GRAMMAR_PANEL_CLASS;
	panel.setAttribute('role', 'complementary');
	panel.setAttribute('tabindex', '-1');
	panel.hidden = true;

	const header = doc.createElement('div');
	header.className = 'language-learning-grammar-panel-header';
	const title = doc.createElement('strong');
	title.id = `language-learning-grammar-panel-title-${Math.random().toString(36).slice(2)}`;
	panel.setAttribute('aria-labelledby', title.id);
	const closeButton = doc.createElement('button');
	closeButton.type = 'button';
	closeButton.className = 'language-learning-card-close language-learning-grammar-panel-close';
	closeButton.textContent = '×';
	closeButton.setAttribute('aria-label', getMessage('close'));
	header.append(title, closeButton);

	const body = doc.createElement('div');
	body.className = 'language-learning-grammar-panel-body';

	const actions = doc.createElement('div');
	actions.className = 'language-learning-grammar-panel-actions';
	const feedback = doc.createElement('span');
	feedback.className = 'language-learning-card-feedback';
	feedback.setAttribute('role', 'status');
	feedback.setAttribute('aria-live', 'polite');
	const copyButton = doc.createElement('button');
	copyButton.type = 'button';
	copyButton.className = 'language-learning-card-action language-learning-grammar-panel-copy';
	copyButton.textContent = getMessage('copyToClipboard');
	actions.append(feedback, copyButton);

	panel.append(header, body, actions);
	doc.body.appendChild(panel);

	let returnFocus: HTMLElement | null = null;
	let copyText: string | null = null;
	let resizeObserver: ResizeObserver | null = null;

	const reserveWidth = () => {
		if (panel.hidden || !panel.isConnected) {
			doc.documentElement.style.removeProperty(LEARNING_PANEL_WIDTH_PROPERTY);
			return;
		}
		doc.documentElement.style.setProperty(LEARNING_PANEL_WIDTH_PROPERTY, `${panel.offsetWidth}px`);
	};

	const hide = () => {
		if (panel.hidden) return;
		const focusTarget = returnFocus;
		const focusWasInside = panel.contains(doc.activeElement);
		panel.hidden = true;
		resizeObserver?.disconnect();
		resizeObserver = null;
		reserveWidth();
		feedback.textContent = '';
		returnFocus = null;
		if (focusWasInside && focusTarget?.isConnected) focusTarget.focus();
	};

	const renderAnalysis = (analysis: TranscriptGrammarAnalysis, { timeOf, onJump }: GrammarPanelShowOptions) => {
		const list = doc.createElement('div');
		list.className = 'language-learning-grammar';
		if (analysis.analyzedLines < analysis.totalLines) {
			const note = doc.createElement('p');
			note.className = 'language-learning-grammar-note';
			note.textContent = getMessage('readerGrammarTruncated', [String(analysis.analyzedLines), String(analysis.totalLines)]);
			list.appendChild(note);
		}
		if (analysis.points.length === 0) {
			const empty = doc.createElement('p');
			empty.textContent = getMessage('readerGrammarEmpty');
			list.appendChild(empty);
		}
		analysis.points.forEach(point => {
			const section = doc.createElement('section');
			section.className = 'language-learning-grammar-point';
			const patternHeading = doc.createElement('h4');
			patternHeading.className = 'language-learning-grammar-pattern';
			patternHeading.textContent = point.pattern;
			if (point.level) {
				const level = doc.createElement('span');
				level.className = 'language-learning-grammar-level';
				level.textContent = point.level;
				patternHeading.append(' ', level);
			}
			const meaning = doc.createElement('p');
			meaning.className = 'language-learning-grammar-meaning';
			meaning.textContent = point.meaning;
			section.append(patternHeading, meaning);
			if (point.examples.length > 0) {
				const examples = doc.createElement('ul');
				examples.className = 'language-learning-grammar-examples';
				point.examples.forEach(example => {
					const item = doc.createElement('li');
					const button = doc.createElement('button');
					button.type = 'button';
					button.className = 'language-learning-grammar-example';
					const time = timeOf(example.id);
					if (time) {
						const timeElement = doc.createElement('span');
						timeElement.className = 'language-learning-grammar-time';
						timeElement.textContent = time;
						button.append(timeElement, ' ');
					}
					button.append(example.quote);
					button.setAttribute('aria-label', getMessage('readerGrammarJump', [time ?? '', example.quote]));
					button.addEventListener('click', event => {
						if (!event.isTrusted) return;
						event.preventDefault();
						event.stopPropagation();
						body.querySelectorAll('.language-learning-grammar-example.is-active')
							.forEach(active => active.classList.remove('is-active'));
						button.classList.add('is-active');
						onJump(example.id);
					});
					item.appendChild(button);
					examples.appendChild(item);
				});
				section.appendChild(examples);
			}
			list.appendChild(section);
		});
		body.replaceChildren(list);
		body.scrollTop = 0;
	};

	closeButton.addEventListener('click', event => {
		if (!event.isTrusted) return;
		hide();
	});
	copyButton.addEventListener('click', async event => {
		if (!event.isTrusted || !copyText || !tools.copyLearningText) return;
		const copied = await tools.copyLearningText(copyText);
		feedback.textContent = getMessage(copied ? 'copied' : 'error');
	});
	// Not modal: Escape closes the panel only while focus is inside it.
	panel.addEventListener('keydown', event => {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		hide();
	});
	signal.addEventListener('abort', () => {
		resizeObserver?.disconnect();
		panel.remove();
		doc.documentElement.style.removeProperty(LEARNING_PANEL_WIDTH_PROPERTY);
	}, { once: true });

	return {
		element: panel,
		get isOpen() {
			return !panel.hidden;
		},
		show(heading, analysis, options) {
			if (signal.aborted) return;
			if (panel.hidden || !returnFocus?.isConnected) returnFocus = options.returnFocus ?? null;
			title.textContent = heading;
			renderAnalysis(analysis, options);
			copyText = analysis.points.length > 0 ? formatGrammarAnalysis(analysis, options.timeOf) : null;
			copyButton.hidden = !tools.copyLearningText || !copyText;
			feedback.textContent = '';
			panel.hidden = false;
			reserveWidth();
			const View = doc.defaultView;
			if (!resizeObserver && View && 'ResizeObserver' in View) {
				resizeObserver = new View.ResizeObserver(reserveWidth);
				resizeObserver.observe(panel);
			}
			panel.focus({ preventScroll: true });
		},
		hide
	};
}
