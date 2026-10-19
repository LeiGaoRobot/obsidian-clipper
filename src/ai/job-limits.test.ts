import { describe, expect, test } from 'vitest';
import { CLI_GROUP_BUDGET_FLOORS, isEmptySourceSegment, maxConcurrencyFor, transcriptGroupBudget, TRANSCRIPT_GROUP_BUDGETS } from './job-limits';
import type { ConnectionKind } from './types';

describe('transcript job limits', () => {
	test('group budgets by connection kind and task', () => {
		for (const kind of ['openai-compatible', 'anthropic', 'ollama', 'azure-openai'] as ConnectionKind[]) {
			expect(transcriptGroupBudget(kind, 'translate')).toBe(6000);
			expect(transcriptGroupBudget(kind, 'reading')).toBe(2500);
			// Splits apply to CLIs only.
			expect(transcriptGroupBudget(kind, 'reading', 600)).toBe(2500);
		}
		expect(transcriptGroupBudget('cli-codex', 'translate')).toBe(6000);
		expect(transcriptGroupBudget('cli-codex', 'reading')).toBe(2500);
		expect(transcriptGroupBudget('cli-grok', 'translate')).toBe(6000);
		expect(transcriptGroupBudget('cli-grok', 'reading')).toBe(1600);
		expect(transcriptGroupBudget('cli-grok', 'reading', 800)).toBe(800);
	});

	test('concurrency defaults and the connection override', () => {
		expect(maxConcurrencyFor({ kind: 'openai-compatible' })).toBe(3);
		expect(maxConcurrencyFor({ kind: 'anthropic' })).toBe(3);
		expect(maxConcurrencyFor({ kind: 'ollama' })).toBe(1);
		expect(maxConcurrencyFor({ kind: 'cli-codex' })).toBe(1);
		expect(maxConcurrencyFor({ kind: 'cli-grok' })).toBe(1);
		expect(maxConcurrencyFor({ kind: 'ollama', maxConcurrency: 2 })).toBe(2);
		expect(maxConcurrencyFor({ kind: 'openai-compatible', maxConcurrency: 0 })).toBe(3);
		expect(maxConcurrencyFor({ kind: 'openai-compatible', maxConcurrency: 1.5 })).toBe(3);
	});

	test('empty sources need no request', () => {
		expect(isEmptySourceSegment('translate', '')).toBe(true);
		expect(isEmptySourceSegment('translate', '  ')).toBe(true);
		expect(isEmptySourceSegment('reading', '')).toBe(true);
		// A whitespace reading must still reproduce its source, so it is requested as today.
		expect(isEmptySourceSegment('reading', ' ')).toBe(false);
		expect(isEmptySourceSegment('translate', 'a')).toBe(false);
	});

	test('CLI split floors stay below every CLI group budget', () => {
		for (const task of ['translate', 'reading'] as const) {
			expect(CLI_GROUP_BUDGET_FLOORS[task]).toBeLessThan(TRANSCRIPT_GROUP_BUDGETS['cli-codex'][task]);
			expect(CLI_GROUP_BUDGET_FLOORS[task]).toBeLessThan(TRANSCRIPT_GROUP_BUDGETS['cli-grok'][task]);
		}
	});
});
