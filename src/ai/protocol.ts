import type { PromptVariable } from '../types/types';
import { AI_ERROR_CODES, AiError, type AiErrorCode, type AiNotConfiguredReason } from './errors';
import { AI_TASKS, type AiTask, type ConnectionKind } from './types';

export const AI_PORT_NAME = 'ai';

/** Clients ping this often while a job is pending; Port traffic keeps the service worker alive. */
export const AI_KEEPALIVE_INTERVAL_MS = 20_000;

// The Native Messaging Host's prompt limit. Context and prompts together stay under it; the
// Host's own envelope wrapping can still push a near-limit request over and be refused there.
const MAX_INPUT_CHARS = 750_000;
const MAX_PROMPTS = 50;

export interface PromptsInput {
	context: string;
	prompts: PromptVariable[];
	maxTokens?: number;
}

export type AiClientMessage =
	| { type: 'start'; jobId: string; task: AiTask; profileId?: string; input: PromptsInput }
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
	| { type: 'result'; jobId: string; responses: Record<string, unknown>; connectionKind: ConnectionKind }
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

function isPromptsInput(value: unknown): value is PromptsInput {
	if (!value || typeof value !== 'object') return false;
	const input = value as Partial<PromptsInput>;
	return typeof input.context === 'string'
		&& Array.isArray(input.prompts)
		&& input.prompts.length > 0
		&& input.prompts.length <= MAX_PROMPTS
		&& input.prompts.every(prompt => prompt
			&& typeof prompt.key === 'string'
			&& prompt.key.length > 0
			&& prompt.key.length <= 200
			&& typeof prompt.prompt === 'string')
		&& input.prompts.reduce((total, prompt) => total + prompt.prompt.length, input.context.length) <= MAX_INPUT_CHARS
		&& (input.maxTokens === undefined
			|| (Number.isInteger(input.maxTokens) && input.maxTokens > 0 && input.maxTokens <= 200_000));
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
				&& isPromptsInput(message.input);
		default:
			return false;
	}
}
