import type { CodexReasoningEffort } from '../../types/types';
import type { NativeCliHeartbeat, NativeCliHostResponse, NativeCliRequest } from '../../utils/native-cli-contract';
import { buildNativeCliPromptRequest } from '../../utils/native-cli-contract';
import { checkNativeCliHealth, sendNativeCliRequest, type NativeCliHealthResult } from '../../utils/native-cli-service';
import { AiError, aiErrorOptions, toAiError } from '../errors';
import type { AiTestTransport, CliConnectionKind } from '../types';

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
		throw cliError(error, options.connectionId);
	}
}

/** `toAiError`, plus the connection on an AiError the service threw without one (a cancellation). */
function cliError(error: unknown, connectionId?: string): AiError {
	const aiError = toAiError(error, connectionId);
	if (!connectionId || aiError.connectionId) return aiError;
	return new AiError(aiError.code, { ...aiErrorOptions(aiError), connectionId });
}

export interface CliHealthOptions {
	connectionId?: string;
	signal?: AbortSignal;
	check?: (mode: 'grok' | 'codex', signal?: AbortSignal) => Promise<NativeCliHealthResult>;
}

/**
 * The Host health check for a CLI connection's Test: the Host answers on the current protocol and
 * finds the CLI's command. Resolves with the transport used; rejects with an AiError.
 */
export async function checkCliHealth(kind: CliConnectionKind, options: CliHealthOptions = {}): Promise<AiTestTransport> {
	try {
		const { transport } = await (options.check ?? checkNativeCliHealth)(kind === 'cli-codex' ? 'codex' : 'grok', options.signal);
		return transport;
	} catch (error) {
		throw cliError(error, options.connectionId);
	}
}
