// @vitest-environment jsdom

import { describe, expect, test, vi } from 'vitest';
import { createReaderTranscriptLoader, type ReaderTranscriptModules } from './reader-transcript-loader';

function article(html: string): HTMLElement {
	const element = document.createElement('article');
	element.innerHTML = html;
	return element;
}

const TRANSCRIPT = '<div class="youtube transcript"><div class="transcript-segment">Hello.</div></div>';
const PLAIN = '<p>A plain article.</p>';

function fakeModules() {
	const cleanupTranscript = vi.fn();
	return {
		cleanupTranscript,
		modules: { transcript: { cleanupTranscript }, runtime: {} } as unknown as ReaderTranscriptModules
	};
}

describe('Reader transcript loader', () => {
	test('a page that never shows a transcript loads nothing', async () => {
		const load = vi.fn();
		const loader = createReaderTranscriptLoader(load);

		await expect(loader.prepare(document, article(PLAIN))).resolves.toBeUndefined();
		loader.cleanup(document);
		await expect(loader.prepare(document, article(PLAIN))).resolves.toBeUndefined();

		expect(load).not.toHaveBeenCalled();
	});

	test('loads once, then cleans up the previous transcript before every later navigation', async () => {
		const { cleanupTranscript, modules } = fakeModules();
		const load = vi.fn().mockResolvedValue(modules);
		const loader = createReaderTranscriptLoader(load);

		const first = await loader.prepare(document, article(TRANSCRIPT));
		expect(first?.modules).toBe(modules);
		expect(cleanupTranscript).not.toHaveBeenCalled();

		await expect(loader.prepare(document, article(PLAIN))).resolves.toBeUndefined();
		expect(cleanupTranscript).toHaveBeenCalledWith(document);
		expect(first?.isCurrent()).toBe(false);

		const second = await loader.prepare(document, article(TRANSCRIPT));
		expect(second?.isCurrent()).toBe(true);
		expect(cleanupTranscript).toHaveBeenCalledTimes(2);
		expect(load).toHaveBeenCalledOnce();
	});

	test('a teardown cleans up the loaded transcript and supersedes a pending one', async () => {
		const { cleanupTranscript, modules } = fakeModules();
		let resolveLoad!: (value: ReaderTranscriptModules) => void;
		const loader = createReaderTranscriptLoader(() => new Promise(resolve => { resolveLoad = resolve; }));

		const pending = loader.prepare(document, article(TRANSCRIPT));
		loader.cleanup(document);
		resolveLoad(modules);

		await expect(pending).resolves.toBeUndefined();
		loader.cleanup(document);
		expect(cleanupTranscript).toHaveBeenCalledOnce();
	});

	test('a navigation that arrives while the modules load wins', async () => {
		const { modules } = fakeModules();
		let resolveLoad!: (value: ReaderTranscriptModules) => void;
		const loader = createReaderTranscriptLoader(() => new Promise(resolve => { resolveLoad = resolve; }));

		const stale = loader.prepare(document, article(TRANSCRIPT));
		const plain = loader.prepare(document, article(PLAIN));
		resolveLoad(modules);

		await expect(stale).resolves.toBeUndefined();
		await expect(plain).resolves.toBeUndefined();
	});
});
