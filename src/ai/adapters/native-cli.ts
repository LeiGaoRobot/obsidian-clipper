import type { CodexReasoningEffort, PromptVariable } from '../../types/types';
import { buildExecutionPrompt, parsePromptResponses } from '../../utils/cli-execution-contract';
import type { NativeCliHeartbeat, NativeCliHostResponse, NativeCliRequest } from '../../utils/native-cli-contract';
import { buildNativeCliPromptRequest } from '../../utils/native-cli-contract';
import { sendNativeCliRequest } from '../../utils/native-cli-service';
import { AiError, toAiError } from '../errors';
import type { CliConnectionKind } from '../types';

export interface CliPromptCall {
	kind: CliConnectionKind;
	model?: string;
	effort?: CodexReasoningEffort;
	context: string;
	prompts: PromptVariable[];
}

export interface CliRenderedPromptCall {
	kind: CliConnectionKind;
	model?: string;
	effort?: CodexReasoningEffort;
	prompt: string;
	/** Codex only; ignored for Grok. */
	outputSchema?: Record<string, unknown>;
}

export type SendNativeCliRequest = (
	request: NativeCliRequest,
	signal?: AbortSignal,
	onHeartbeat?: (heartbeat: NativeCliHeartbeat) => void
) => Promise<NativeCliHostResponse>;

export interface CliCallOptions {
	connectionId?: string;
	signal?: AbortSignal;
	onHeartbeat?: (elapsedMs: number) => void;
	send?: SendNativeCliRequest;
}

/** Sends one rendered prompt through the Native Messaging Host and returns raw stdout. */
export async function runCliPrompt(call: CliRenderedPromptCall, options: CliCallOptions = {}): Promise<string> {
	const mode = call.kind === 'cli-codex' ? 'codex' : 'grok';
	try {
		const request = buildNativeCliPromptRequest(mode, call.prompt, mode === 'codex'
			? {
				...(call.model ? { model: call.model } : {}),
				...(call.effort ? { effort: call.effort } : {}),
				...(call.outputSchema ? { outputSchema: call.outputSchema } : {})
			}
			: {});
		const response = await (options.send ?? sendNativeCliRequest)(
			request,
			options.signal,
			options.onHeartbeat ? heartbeat => options.onHeartbeat?.(heartbeat.elapsedMs) : undefined
		);
		return response.stdout || '';
	} catch (error) {
		throw toAiError(error, options.connectionId);
	}
}

/** Runs one prompt call through the Native Messaging Host and returns responses by prompt key. */
export async function executeCliCall(call: CliPromptCall, options: CliCallOptions = {}): Promise<Record<string, unknown>> {
	const stdout = await runCliPrompt({
		kind: call.kind,
		...(call.model ? { model: call.model } : {}),
		...(call.effort ? { effort: call.effort } : {}),
		prompt: buildExecutionPrompt(call.context, call.prompts)
	}, options);
	try {
		return parsePromptResponses(stdout, call.prompts);
	} catch (error) {
		throw new AiError('bad-response', {
			...(options.connectionId ? { connectionId: options.connectionId } : {}),
			detail: error instanceof Error ? error.message : String(error)
		});
	}
}
