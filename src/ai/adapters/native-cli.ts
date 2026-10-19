import type { CodexReasoningEffort } from '../../types/types';
import type { NativeCliHeartbeat, NativeCliHostResponse, NativeCliRequest } from '../../utils/native-cli-contract';
import { buildNativeCliPromptRequest } from '../../utils/native-cli-contract';
import { sendNativeCliRequest } from '../../utils/native-cli-service';
import { toAiError } from '../errors';
import type { CliConnectionKind } from '../types';

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
