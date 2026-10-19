import { isCliKind } from './connection-kind';
import type { TranscriptJobTask } from './job-identity';
import type { CliConnectionKind, ConnectionKind } from './types';

// Transcript job limits shared by the job runner (background) and the Reader and runtime chunks,
// which need the group budgets for the batch estimate and the empty-source rule for alignment.
// Kept apart from `job-runner.ts` so those lazy chunks do not carry the runner. Pure.

/** Group prompt budgets in characters, by connection kind and task. All API kinds share one row. */
export const TRANSCRIPT_GROUP_BUDGETS: Readonly<Record<'api' | CliConnectionKind, Readonly<Record<TranscriptJobTask, number>>>> = {
	api: { translate: 6000, reading: 2500 },
	'cli-codex': { translate: 6000, reading: 2500 },
	'cli-grok': { translate: 6000, reading: 1600 }
};
/** A CLI timeout split never shrinks a group budget below these. */
export const CLI_GROUP_BUDGET_FLOORS: Readonly<Record<TranscriptJobTask, number>> = { translate: 1200, reading: 600 };
/** Groups in flight when a connection sets no `maxConcurrency`. */
export const DEFAULT_MAX_CONCURRENCY = { hosted: 3, ollama: 1, cli: 1 } as const;

/** The prompt budget of one group. CLI kinds use the split-reduced budget when one is stored. */
export function transcriptGroupBudget(kind: ConnectionKind, task: TranscriptJobTask, cliPromptChars?: number): number {
	if (!isCliKind(kind)) return TRANSCRIPT_GROUP_BUDGETS.api[task];
	return cliPromptChars ?? TRANSCRIPT_GROUP_BUDGETS[kind][task];
}

/** Groups in flight for a connection: its `maxConcurrency` when that is a positive integer, else the kind's default. */
export function maxConcurrencyFor(connection: { kind: ConnectionKind; maxConcurrency?: number }): number {
	const { kind, maxConcurrency } = connection;
	if (Number.isInteger(maxConcurrency) && (maxConcurrency as number) > 0) return maxConcurrency as number;
	if (isCliKind(kind)) return DEFAULT_MAX_CONCURRENCY.cli;
	return kind === 'ollama' ? DEFAULT_MAX_CONCURRENCY.ollama : DEFAULT_MAX_CONCURRENCY.hosted;
}

/**
 * A segment whose answer is known without a request: an empty reading (`[]`) is already complete
 * for an empty source, as `isCompleteTranscriptReadingSegment` has it, and a blank source has no
 * translation (`''`), which the translate contract would reject as an answer. Such segments count
 * as complete, are never requested, and carry no result item; clients fill the gap with the
 * empty value.
 */
export function isEmptySourceSegment(task: TranscriptJobTask, text: string): boolean {
	return task === 'reading' ? text === '' : text.trim() === '';
}
