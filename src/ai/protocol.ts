import {
	isCompleteTranscriptReadingSegment,
	parseReadingTokens,
	parseTranslationText,
	type AiTaskInput,
	type AiTaskInputs,
	type AiTaskOutput,
	type TranscriptSegment
} from './contracts';
import { AI_ERROR_CODES, AiError, type AiErrorCode, type AiErrorRecovery, type AiNotConfiguredReason } from './errors';
import { hasIndexIds, type TranscriptJobIdentity, type TranscriptJobTask } from './job-identity';
import type { AiJobAttempts, AiJobStatus } from './job-store';
import { AI_TASKS, type AiTask, type AiTestResult, type AiTestStep, type ConnectionKind } from './types';

export const AI_PORT_NAME = 'ai';

/** Clients ping this often while a job is pending; Port traffic keeps the service worker alive. */
export const AI_KEEPALIVE_INTERVAL_MS = 20_000;

// The Native Messaging Host's prompt limit. All input text together stays under it; the contract's
// own instructions can still push a near-limit request over and have it refused by the Host.
const MAX_INPUT_CHARS = 750_000;
const MAX_PROMPTS = 50;
const MAX_SEGMENTS = 2000;
const MAX_INSTRUCTION_CHARS = 20_000;
const MAX_IDENTITY_CHARS = 100;
// The scope is hashed into the job id, so it may be longer than the namespace, which is not.
const MAX_SCOPE_CHARS = 500;
// A whole transcript job is bounded by its stored record in storage.session rather than by one request.
const MAX_JOB_SEGMENTS = 20_000;
const MAX_JOB_INPUT_CHARS = 1_500_000;

export type AiStartMessage = {
	[T in AiTask]: { type: 'start'; jobId: string; task: T; profileId?: string; input: AiTaskInput<T> }
}[AiTask];

/** Tasks that run as one durable background job over a whole transcript. */
export const AI_JOB_TASKS: readonly TranscriptJobTask[] = ['translate', 'reading'];

/** A job's input. Segment ids equal their index, so results map onto source arrays directly. */
export interface AiJobInput {
	instruction: string;
	segments: TranscriptSegment[];
	identity: TranscriptJobIdentity;
}

/** One accepted item: a translation or a segment reading. */
export type JobResultItem<T extends TranscriptJobTask = TranscriptJobTask> = AiTaskOutput<T>[number];

export type AiStartJobMessage = {
	[T in TranscriptJobTask]: { type: 'start-job'; jobId: string; task: T; profileId?: string; input: AiJobInput }
}[TranscriptJobTask];

export type AiCheckpointPutMessage = {
	[T in TranscriptJobTask]: {
		type: 'checkpoint-put';
		requestId: string;
		jobId: string;
		task: T;
		identity: TranscriptJobIdentity;
		segmentCount: number;
		/**
		 * The source segments, ids equal to their index. The gateway recomputes the job id from them
		 * and checks each reading against its source text.
		 */
		segments: TranscriptSegment[];
		results: JobResultItem<T>[];
	}
}[TranscriptJobTask];

export type AiClientMessage =
	| AiStartMessage
	| AiStartJobMessage
	| AiCheckpointPutMessage
	| { type: 'checkpoint-get'; requestId: string; jobId: string }
	| { type: 'checkpoint-clear'; requestId: string; jobId: string }
	| AiTestMessage
	| AiStatusClearMessage
	| { type: 'cancel'; jobId: string }
	| { type: 'attach'; jobId: string }
	| { type: 'ping' };

/**
 * Tests a connection (D3), only after an explicit click. It carries no credential: the gateway
 * reads the key of `connectionId` from `ai_credentials`. `cancel` with the same `jobId` stops it.
 */
export interface AiTestMessage {
	type: 'test';
	jobId: string;
	connectionId: string;
}

/**
 * Asks the gateway, the only writer of `ai_connection_status`, to remove the entry of
 * `connectionId` (Settings sends it when a connection is deleted or its endpoint, key, or a
 * profile's model changes). Answered by `status-cleared`, or `error` when the write failed.
 */
export interface AiStatusClearMessage {
	type: 'status-clear';
	jobId: string;
	connectionId: string;
}

export type AiProgressPhase = 'started' | 'heartbeat' | 'receiving';

export interface AiJobCounts {
	completedGroups: number;
	totalGroups: number;
	completedSegments: number;
	totalSegments: number;
}

/** A full job snapshot; sent on `start-job`, on `attach`, and last when the job leaves `running`. */
export interface AiJobStateMessage extends AiJobCounts {
	type: 'job-state';
	jobId: string;
	status: AiJobStatus;
	results: JobResultItem[];
	attempts: AiJobAttempts;
	error?: SerializedAiError;
}

/** The items accepted from the group that just finished, with the job's new counts. */
export interface AiJobProgressMessage extends AiJobCounts {
	type: 'job-progress';
	jobId: string;
	results: JobResultItem[];
}

/** A group entered backoff after a retryable provider error. */
export interface AiJobRetryMessage {
	type: 'job-retry';
	jobId: string;
	code: AiErrorCode;
	status?: number;
	delayMs: number;
	attempt: number;
}

export interface AiCheckpointRecord {
	status: AiJobStatus;
	results: JobResultItem[];
	completedSegments: number;
	totalSegments: number;
}

/** The answer to a `checkpoint-*` request; `record` is present for a `checkpoint-get` that found one. */
export interface AiCheckpointMessage {
	type: 'checkpoint';
	requestId: string;
	jobId: string;
	ok: boolean;
	record?: AiCheckpointRecord;
}

export interface SerializedAiError {
	code: AiErrorCode;
	retryable: boolean;
	connectionId?: string;
	status?: number;
	reason?: AiNotConfiguredReason;
	detail?: string;
	nativeCode?: string;
	timeoutSeconds?: number;
	retryAfterMs?: number;
	/** Optional on the wire: an older background sends errors without them. */
	task?: AiTask;
	profileId?: string;
	recovery?: AiErrorRecovery;
}

export type AiGatewayMessage =
	| { type: 'progress'; jobId: string; phase: AiProgressPhase; elapsedMs: number; receivedChars?: number }
	| { type: 'result'; jobId: string; output: unknown; connectionKind: ConnectionKind }
	| { type: 'error'; jobId: string; error: SerializedAiError }
	| AiJobStateMessage
	| AiJobProgressMessage
	| AiJobRetryMessage
	| AiCheckpointMessage
	| AiTestStepMessage
	| AiTestResultMessage
	| AiStatusClearedMessage;

/** A Test step started; `profileId` names the profile a CLI exec runs with. */
export interface AiTestStepMessage {
	type: 'test-step';
	jobId: string;
	step: AiTestStep;
	profileId?: string;
}

/** The finished Test; a cancelled or invalid Test answers `error` instead. */
export interface AiTestResultMessage {
	type: 'test-result';
	jobId: string;
	result: AiTestResult;
}

/** The entry of `connectionId` is gone from `ai_connection_status` (or was never there). */
export interface AiStatusClearedMessage {
	type: 'status-cleared';
	jobId: string;
	connectionId: string;
}

export function serializeAiError(error: AiError): SerializedAiError {
	return {
		code: error.code,
		retryable: error.retryable,
		...(error.connectionId ? { connectionId: error.connectionId } : {}),
		...(error.status !== undefined ? { status: error.status } : {}),
		...(error.reason ? { reason: error.reason } : {}),
		...(error.detail ? { detail: error.detail } : {}),
		...(error.nativeCode ? { nativeCode: error.nativeCode } : {}),
		...(error.timeoutSeconds !== undefined ? { timeoutSeconds: error.timeoutSeconds } : {}),
		...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
		...(error.task ? { task: error.task } : {}),
		...(error.profileId ? { profileId: error.profileId } : {}),
		...(error.recovery ? { recovery: error.recovery } : {})
	};
}

export function deserializeAiError(value: unknown): AiError {
	const error = value && typeof value === 'object' ? value as Partial<SerializedAiError> : {};
	const code = (AI_ERROR_CODES as readonly string[]).includes(String(error.code))
		? error.code as AiErrorCode
		: 'provider-error';
	return new AiError(code, {
		...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
		...(typeof error.connectionId === 'string' ? { connectionId: error.connectionId } : {}),
		...(typeof error.status === 'number' ? { status: error.status } : {}),
		...(typeof error.reason === 'string' ? { reason: error.reason as AiNotConfiguredReason } : {}),
		...(typeof error.detail === 'string' ? { detail: error.detail } : {}),
		...(typeof error.nativeCode === 'string' ? { nativeCode: error.nativeCode } : {}),
		...(typeof error.timeoutSeconds === 'number' ? { timeoutSeconds: error.timeoutSeconds } : {}),
		...(typeof error.retryAfterMs === 'number' ? { retryAfterMs: error.retryAfterMs } : {}),
		...((AI_TASKS as readonly unknown[]).includes(error.task) ? { task: error.task as AiTask } : {}),
		...(isJobId(error.profileId) ? { profileId: error.profileId } : {}),
		...(error.recovery === 'continue-remaining' ? { recovery: error.recovery } : {})
	});
}

function isJobId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function isMaxTokens(value: unknown): boolean {
	return value === undefined || (Number.isInteger(value) && (value as number) > 0 && (value as number) <= 200_000);
}

function isInstruction(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_INSTRUCTION_CHARS;
}

function isSegments(value: unknown, maxSegments = MAX_SEGMENTS): value is AiTaskInputs['translate']['segments'] {
	if (!Array.isArray(value) || value.length === 0 || value.length > maxSegments) return false;
	const ids = new Set<number>();
	for (const segment of value) {
		if (!segment || typeof segment !== 'object') return false;
		const { id, text } = segment as { id?: unknown; text?: unknown };
		if (!Number.isInteger(id) || (id as number) < 0 || ids.has(id as number) || typeof text !== 'string') return false;
		ids.add(id as number);
	}
	return true;
}

function sumLengths(values: string[]): number {
	return values.reduce((total, value) => total + value.length, 0);
}

/** Validates a task input and returns a copy holding only the fields the contract uses. */
export function sanitizeTaskInput(task: AiTask, value: unknown): AiTaskInput | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const input = value as Record<string, unknown>;
	if (!isMaxTokens(input.maxTokens)) return undefined;
	const budget = input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens as number };
	switch (task) {
		case 'interpret': {
			const { context, prompts } = input;
			if (typeof context !== 'string' || !Array.isArray(prompts) || prompts.length === 0 || prompts.length > MAX_PROMPTS) {
				return undefined;
			}
			const keys = new Set<string>();
			for (const prompt of prompts) {
				if (!prompt || typeof prompt !== 'object') return undefined;
				const { key, prompt: text } = prompt as { key?: unknown; prompt?: unknown };
				if (typeof key !== 'string' || !key || key.length > 200 || keys.has(key) || typeof text !== 'string') return undefined;
				keys.add(key);
			}
			const items = (prompts as Array<{ key: string; prompt: string }>).map(({ key, prompt }) => ({ key, prompt }));
			if (sumLengths([context, ...items.map(item => item.prompt)]) > MAX_INPUT_CHARS) return undefined;
			return { context, prompts: items, ...budget };
		}
		case 'edit':
		case 'explain': {
			const { instruction, content } = input;
			if (!isInstruction(instruction) || typeof content !== 'string') return undefined;
			if (sumLengths([instruction, content]) > MAX_INPUT_CHARS) return undefined;
			return { instruction, content, ...budget };
		}
		case 'translate':
		case 'reading': {
			const { instruction, segments } = input;
			if (!isInstruction(instruction) || !isSegments(segments)) return undefined;
			const copies = segments.map(({ id, text }) => ({ id, text }));
			if (sumLengths([instruction, ...copies.map(segment => segment.text)]) > MAX_INPUT_CHARS) return undefined;
			return { instruction, segments: copies, ...budget };
		}
	}
	return undefined;
}

function isJobTask(value: unknown): value is TranscriptJobTask {
	return (AI_JOB_TASKS as readonly unknown[]).includes(value);
}

function isIdentityPart(value: unknown, maxChars = MAX_IDENTITY_CHARS): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= maxChars;
}

/** Validates a job identity and returns a copy holding only its two fields. */
export function sanitizeJobIdentity(value: unknown): TranscriptJobIdentity | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const { namespace, scope } = value as Record<string, unknown>;
	return isIdentityPart(namespace) && isIdentityPart(scope, MAX_SCOPE_CHARS) ? { namespace, scope } : undefined;
}

/**
 * Validates a job input under the same bounds as a transcript task input, with segment ids equal to
 * their index, and returns a copy holding only the fields a job uses. The runner sets each group's
 * output budget, so a client `maxTokens` is dropped. The job id is checked by the gateway, which
 * recomputes it from this input.
 */
export function sanitizeJobInput(value: unknown): AiJobInput | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const { instruction, segments, identity: rawIdentity } = value as Record<string, unknown>;
	const identity = sanitizeJobIdentity(rawIdentity);
	if (!identity || !isInstruction(instruction) || !isSegments(segments, MAX_JOB_SEGMENTS)) return undefined;
	if (!hasIndexIds(segments)) return undefined;
	const copies = segments.map(({ id, text }) => ({ id, text }));
	if (sumLengths([instruction, ...copies.map(segment => segment.text)]) > MAX_JOB_INPUT_CHARS) return undefined;
	return { instruction, segments: copies, identity };
}

// A reading must spell its source text with every kanji read; an empty token list stands for an
// empty source segment. Without a source, a reading is checked against the text its tokens spell.
function sanitizeResultItem(
	task: TranscriptJobTask,
	item: Record<string, unknown>,
	id: number,
	source: string | undefined
): JobResultItem | undefined {
	if (task === 'translate') {
		const text = parseTranslationText(item.text);
		return text ? { id, text } : undefined;
	}
	const tokens = Array.isArray(item.tokens) && item.tokens.length === 0 ? [] : parseReadingTokens(item.tokens);
	if (!tokens) return undefined;
	const text = source ?? tokens.map(token => token.text).join('');
	return isCompleteTranscriptReadingSegment(tokens, text) ? { id, tokens } : undefined;
}

/**
 * Validates checkpoint results for a job of `segmentCount` segments: unique integer ids below the
 * count, each item valid under the task contract, readings checked against `sources` when given.
 * Returns copies, or undefined if any item fails.
 */
export function sanitizeJobResults<T extends TranscriptJobTask>(
	task: T,
	segmentCount: number,
	value: unknown,
	sources?: readonly string[]
): JobResultItem<T>[] | undefined {
	if (!Array.isArray(value) || value.length > segmentCount) return undefined;
	if (sources && sources.length !== segmentCount) return undefined;
	const ids = new Set<number>();
	const items: JobResultItem[] = [];
	for (const item of value) {
		if (!item || typeof item !== 'object') return undefined;
		const id = (item as { id?: unknown }).id;
		if (!Number.isInteger(id) || (id as number) < 0 || (id as number) >= segmentCount || ids.has(id as number)) {
			return undefined;
		}
		const copy = sanitizeResultItem(task, item as Record<string, unknown>, id as number, sources?.[id as number]);
		if (!copy) return undefined;
		ids.add(id as number);
		items.push(copy);
	}
	return items as JobResultItem<T>[];
}

function isSegmentCount(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_JOB_SEGMENTS;
}

/**
 * Validates a `checkpoint-put` and returns a copy holding only its fields: index ids, as many
 * segments as `segmentCount`, the same size bound as a job input, and results valid under the task
 * contract against their source text. The job id is checked by the gateway, which recomputes it.
 */
export function sanitizeCheckpointPut(value: unknown): AiCheckpointPutMessage | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const message = value as Record<string, unknown>;
	if (message.type !== 'checkpoint-put' || !isJobId(message.requestId) || !isJobId(message.jobId)) return undefined;
	const { task, segmentCount, segments } = message;
	const identity = sanitizeJobIdentity(message.identity);
	if (!isJobTask(task) || !identity || !isSegmentCount(segmentCount)) return undefined;
	if (!isSegments(segments, MAX_JOB_SEGMENTS) || segments.length !== segmentCount || !hasIndexIds(segments)) return undefined;
	const copies = segments.map(({ id, text }) => ({ id, text }));
	if (sumLengths(copies.map(segment => segment.text)) > MAX_JOB_INPUT_CHARS) return undefined;
	const results = sanitizeJobResults(task, segmentCount, message.results, copies.map(segment => segment.text));
	if (!results) return undefined;
	return {
		type: 'checkpoint-put',
		requestId: message.requestId,
		jobId: message.jobId,
		task,
		identity,
		segmentCount,
		segments: copies,
		results
	} as AiCheckpointPutMessage;
}

export function isAiClientMessage(value: unknown): value is AiClientMessage {
	if (!value || typeof value !== 'object') return false;
	const message = value as Record<string, unknown>;
	switch (message.type) {
		case 'ping':
			return true;
		case 'cancel':
		case 'attach':
			return isJobId(message.jobId);
		case 'start':
			return isJobId(message.jobId)
				&& (AI_TASKS as readonly unknown[]).includes(message.task)
				&& (message.profileId === undefined || isJobId(message.profileId))
				&& sanitizeTaskInput(message.task as AiTask, message.input) !== undefined;
		case 'start-job':
			return isJobId(message.jobId)
				&& isJobTask(message.task)
				&& (message.profileId === undefined || isJobId(message.profileId))
				&& sanitizeJobInput(message.input) !== undefined;
		case 'checkpoint-get':
		case 'checkpoint-clear':
			return isJobId(message.requestId) && isJobId(message.jobId);
		case 'checkpoint-put':
			return sanitizeCheckpointPut(message) !== undefined;
		case 'test':
		case 'status-clear':
			return isJobId(message.jobId) && isJobId(message.connectionId);
		default:
			return false;
	}
}
