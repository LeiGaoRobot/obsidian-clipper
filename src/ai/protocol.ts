import type { AiTaskInput, AiTaskInputs } from './contracts';
import { AI_ERROR_CODES, AiError, type AiErrorCode, type AiNotConfiguredReason } from './errors';
import { AI_TASKS, type AiTask, type ConnectionKind } from './types';

export const AI_PORT_NAME = 'ai';

/** Clients ping this often while a job is pending; Port traffic keeps the service worker alive. */
export const AI_KEEPALIVE_INTERVAL_MS = 20_000;

// The Native Messaging Host's prompt limit. All input text together stays under it; the contract's
// own instructions can still push a near-limit request over and have it refused by the Host.
const MAX_INPUT_CHARS = 750_000;
const MAX_PROMPTS = 50;
const MAX_SEGMENTS = 2000;
const MAX_INSTRUCTION_CHARS = 20_000;

export type AiStartMessage = {
	[T in AiTask]: { type: 'start'; jobId: string; task: T; profileId?: string; input: AiTaskInput<T> }
}[AiTask];

export type AiClientMessage =
	| AiStartMessage
	| { type: 'cancel'; jobId: string }
	| { type: 'attach'; jobId: string }
	| { type: 'ping' };

export type AiProgressPhase = 'started' | 'heartbeat' | 'receiving';

export interface SerializedAiError {
	code: AiErrorCode;
	retryable: boolean;
	connectionId?: string;
	status?: number;
	reason?: AiNotConfiguredReason;
	detail?: string;
	nativeCode?: string;
	timeoutSeconds?: number;
}

export type AiGatewayMessage =
	| { type: 'progress'; jobId: string; phase: AiProgressPhase; elapsedMs: number; receivedChars?: number }
	| { type: 'result'; jobId: string; output: unknown; connectionKind: ConnectionKind }
	| { type: 'error'; jobId: string; error: SerializedAiError };

export function serializeAiError(error: AiError): SerializedAiError {
	return {
		code: error.code,
		retryable: error.retryable,
		...(error.connectionId ? { connectionId: error.connectionId } : {}),
		...(error.status !== undefined ? { status: error.status } : {}),
		...(error.reason ? { reason: error.reason } : {}),
		...(error.detail ? { detail: error.detail } : {}),
		...(error.nativeCode ? { nativeCode: error.nativeCode } : {}),
		...(error.timeoutSeconds !== undefined ? { timeoutSeconds: error.timeoutSeconds } : {})
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
		...(typeof error.timeoutSeconds === 'number' ? { timeoutSeconds: error.timeoutSeconds } : {})
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

function isSegments(value: unknown): value is AiTaskInputs['translate']['segments'] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SEGMENTS) return false;
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
		default:
			return false;
	}
}
