import type { CodexReasoningEffort } from '../types/types';
import type { AiErrorCode } from './errors';

export type ApiConnectionKind =
	| 'openai-compatible'
	| 'azure-openai'
	| 'anthropic'
	| 'ollama'
	| 'huggingface'
	| 'perplexity';

export type CliConnectionKind = 'cli-codex' | 'cli-grok';

export type ConnectionKind = ApiConnectionKind | CliConnectionKind;

export type StructuredOutputSupport = 'json_schema' | 'json_object' | 'none' | 'unknown';

/** How the current browser exposes Native Messaging, if at all. */
export type NativeMessagingSupport = 'port' | 'message' | 'none';

export interface Connection {
	id: string;
	kind: ConnectionKind;
	label: string;
	presetId?: string;
	baseUrl?: string;
	apiKeyRequired?: boolean;
	structuredOutput?: StructuredOutputSupport;
	maxConcurrency?: number;
	timeoutMs?: number;
}

export interface ModelProfileOptions {
	reasoningEffort?: CodexReasoningEffort;
	maxOutputTokens?: number;
	temperature?: number;
}

export interface ModelProfile {
	id: string;
	connectionId: string;
	/** Provider model id. Optional for CLIs, which then use their own default. */
	model?: string;
	label: string;
	options?: ModelProfileOptions;
	enabled: boolean;
}

export const AI_TASKS = ['interpret', 'edit', 'translate', 'reading', 'explain'] as const;

export type AiTask = typeof AI_TASKS[number];

export interface AiRouting {
	defaultProfileId?: string;
	taskProfiles: Partial<Record<AiTask, string>>;
	responseLanguage?: string;
}

export interface AiInterpreterSettings {
	autoRun: boolean;
	defaultPromptContext: string;
}

export interface AiSettingsView {
	/** Master switch for every AI feature. */
	enabled: boolean;
	connections: Connection[];
	profiles: ModelProfile[];
	routing: AiRouting;
	interpreter: AiInterpreterSettings;
	/** API keys by connection id. Device-local; never part of a synced connection. */
	credentials: Record<string, string>;
	nativeMessaging: NativeMessagingSupport;
}

/** Whether a Test found a profile's model in the connection's model listing. */
export interface ConnectionModelCheck {
	profileId: string;
	model: string;
	listed: boolean;
}

/**
 * Per-device connection state in `storage.local` (`ai_connection_status`), keyed by connection id.
 * Only the gateway creates entries; Settings may delete them. `state` and `testedAt` are set
 * together when a Test finishes. An entry can also exist with only `structuredOutput`, written
 * when a run downgrades the structured-output mode of an untested connection.
 */
export interface ConnectionStatus {
	state?: 'ok' | 'failing';
	testedAt?: number;
	code?: AiErrorCode;
	/** HTTP status of the failing request, when there was one. */
	status?: number;
	detail?: string;
	models?: ConnectionModelCheck[];
	structuredOutput?: Exclude<StructuredOutputSupport, 'unknown'>;
}
