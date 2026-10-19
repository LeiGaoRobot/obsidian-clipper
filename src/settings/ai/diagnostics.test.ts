// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AiDiagnosticEntry } from '../../ai/types';
import { initializeAiSettings } from './index';
import { API_CONNECTION, createFakeStore, installGuideEnvironment, loadSettingsDocument, settle } from './test-support';

const ENTRIES: AiDiagnosticEntry[] = [
	{ at: 1000, task: 'test', kind: 'openai-compatible', connectionId: 'openai', durationMs: 420, outcome: 'ok', structuredMode: 'json_schema' },
	{ at: 2000, task: 'interpret', kind: 'openai-compatible', connectionId: 'openai', durationMs: 2500, outcome: 'error', code: 'rate-limited', status: 429 },
	{ at: 3000, task: 'translate', kind: 'openai-compatible', connectionId: 'gone', durationMs: 12000, outcome: 'cancelled', groups: 4, retries: 1, fallback: true }
];

async function section(entries: AiDiagnosticEntry[] = ENTRIES, copyText = vi.fn(async (_text: string) => undefined)) {
	const fake = createFakeStore({
		connections: [API_CONNECTION],
		credentials: { openai: 'sk' },
		session: { ai_diagnostics: { v: 1, entries } }
	});
	const handle = await initializeAiSettings({
		store: fake.store,
		installGuide: installGuideEnvironment(),
		session: fake.session,
		copyText
	});
	await settle();
	return { ...fake, handle, copyText };
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('#ai-diagnostics .ai-diagnostics-entry'));
const button = (name: string) => document.querySelector(`#ai-diagnostics .ai-diagnostics-${name}`) as HTMLButtonElement;

beforeEach(() => {
	loadSettingsDocument();
});

describe('Diagnostics panel', () => {
	test('is visible and lists entries newest first', async () => {
		await section();
		expect(document.getElementById('ai-diagnostics-group')?.hidden).toBe(false);
		expect(rows().map(row => row.className)).toEqual([
			'ai-diagnostics-entry is-cancelled',
			'ai-diagnostics-entry is-error',
			'ai-diagnostics-entry is-ok'
		]);
		const [cancelled, failed, ok] = rows();
		expect(cancelled.querySelector('.ai-diagnostics-summary')?.textContent).toContain('gone');
		expect(cancelled.querySelector('.ai-diagnostics-details')?.textContent).toContain('4 groups, 1 retries');
		expect(cancelled.querySelector('.ai-diagnostics-details')?.textContent).toContain('Retried without structured output');
		expect(failed.querySelector('.ai-diagnostics-summary')?.textContent).toContain('OpenAI');
		expect(failed.querySelector('.ai-diagnostics-details')?.textContent).toContain('HTTP 429');
		expect(failed.querySelector('.ai-diagnostics-details')?.textContent).toContain('2.5 s');
		expect(ok.querySelector('.ai-diagnostics-summary')?.textContent).toContain('Test');
		expect(ok.querySelector('.ai-diagnostics-outcome')?.textContent).toBe('OK');
		expect(ok.querySelector('.ai-diagnostics-details')?.textContent).toContain('JSON schema');
	});

	test('follows new entries in storage.session', async () => {
		const { session } = await section([]);
		expect(document.querySelector('#ai-diagnostics .ai-empty-state')?.textContent).toBe('No AI requests yet.');
		expect(button('copy').disabled).toBe(true);
		await session.set({ ai_diagnostics: { v: 1, entries: [ENTRIES[0]] } });
		await settle();
		expect(rows()).toHaveLength(1);
		expect(button('copy').disabled).toBe(false);
	});

	test('Copy puts the entries on the clipboard as JSON', async () => {
		const { copyText } = await section();
		button('copy').click();
		await settle();
		expect(copyText).toHaveBeenCalledTimes(1);
		expect(JSON.parse(copyText.mock.calls[0][0])).toEqual(ENTRIES);
		expect(document.querySelector('#ai-diagnostics .ai-diagnostics-copied')?.textContent).toBe('Copied!');
	});

	test('Clear removes the log', async () => {
		const { session } = await section();
		button('clear').click();
		await settle();
		expect(session.data.ai_diagnostics).toBeUndefined();
		expect(rows()).toHaveLength(0);
		expect(document.querySelector('#ai-diagnostics .ai-empty-state')).not.toBeNull();
	});

	test('says so without storage.session', async () => {
		const { store } = createFakeStore({});
		await initializeAiSettings({ store, installGuide: installGuideEnvironment(), session: null });
		expect(document.querySelector('#ai-diagnostics')?.textContent).toContain('session storage');
		expect(button('copy')).toBeNull();
	});
});
