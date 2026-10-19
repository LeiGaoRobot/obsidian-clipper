// The Reader's handle on its lazily loaded transcript modules. A page that never shows a transcript
// loads nothing; once they are loaded, every later navigation, including one to an article without
// a transcript, first cleans up what the previous transcript left on the document (its learning
// card, selection button, listeners, and in-flight requests). Only type imports here: the modules
// themselves arrive through the injected `load`, which names their lazy chunk.

export interface ReaderTranscriptModules {
	transcript: typeof import('./reader-transcript');
	runtime: typeof import('./language-learning-runtime');
}

export interface PreparedTranscript {
	modules: ReaderTranscriptModules;
	/** False once a newer navigation or a teardown replaced this one. */
	isCurrent: () => boolean;
}

export interface ReaderTranscriptLoader {
	/**
	 * Cleans up the previous transcript, then loads the modules when `article` has a transcript.
	 * Resolves with them, or undefined for an article without one or a superseded navigation.
	 */
	prepare(doc: Document, article: HTMLElement): Promise<PreparedTranscript | undefined>;
	/** Cleans up the wired transcript, if the modules were ever loaded, and supersedes a pending one. */
	cleanup(doc: Document): void;
}

const TRANSCRIPT_SELECTOR = '.youtube.transcript, .bilibili.transcript';

export function createReaderTranscriptLoader(load: () => Promise<ReaderTranscriptModules>): ReaderTranscriptLoader {
	let modules: ReaderTranscriptModules | undefined;
	let generation = 0;

	const cleanup = (doc: Document) => {
		generation++;
		modules?.transcript.cleanupTranscript(doc);
	};

	return {
		async prepare(doc, article) {
			cleanup(doc);
			const current = generation;
			if (!article.querySelector(TRANSCRIPT_SELECTOR)) return undefined;
			modules ??= await load();
			if (current !== generation) return undefined;
			const loaded = modules;
			return { modules: loaded, isCurrent: () => current === generation };
		},
		cleanup
	};
}
