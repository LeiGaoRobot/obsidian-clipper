import type { CodexReasoningEffort, PromptVariable } from '../../types/types';
import { parsePromptResponses } from '../../utils/cli-execution-contract';
import type { NativeCliHeartbeat, NativeCliHostResponse, NativeCliRequest } from '../../utils/native-cli-contract';
import { buildNativeCliRequest } from '../../utils/native-cli-contract';
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

/** Runs one prompt call through the Native Messaging Host and returns responses by prompt key. */
export async function executeCliCall(call: CliPromptCall, options: CliCallOptions = {}): Promise<Record<string, unknown>> {
	const mode = call.kind === 'cli-codex' ? 'codex' : 'grok';
	let stdout: string;
	try {
		const request = buildNativeCliRequest(mode, call.context, call.prompts, mode === 'codex'
			? {
				...(call.model ? { model: call.model } : {}),
				...(call.effort ? { effort: call.effort } : {})
			}
			: {});
		const response = await (options.send ?? sendNativeCliRequest)(
			request,
			options.signal,
			options.onHeartbeat ? heartbeat => options.onHeartbeat?.(heartbeat.elapsedMs) : undefined
		);
		stdout = response.stdout || '';
	} catch (error) {
		throw toAiError(error, options.connectionId);
	}
	try {
		return parsePromptResponses(stdout, call.prompts);
	} catch (error) {
		throw new AiError('bad-response', {
			...(options.connectionId ? { connectionId: options.connectionId } : {}),
			detail: error instanceof Error ? error.message : String(error)
		});
	}
}
