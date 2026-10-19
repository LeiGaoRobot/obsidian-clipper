import type { CodexReasoningEffort } from '../types/types';
import type { AiErrorCode } from './errors';
import type { SerializedAiError } from './protocol';

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
	/**
	 * API keys by connection id. Device-local; never part of a synced connection. Empty in a view
	 * loaded without keys (the Popup and Reader stores).
	 */
	credentials: Record<string, string>;
	/**
	 * The connections that have a key on this device, without the keys: set only in a view loaded
	 * for readiness checks (the Popup's), where `credentials` is empty.
	 */
	credentialIds?: string[];
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
 * Only the gateway writes it; Settings asks it to remove an entry (`status-clear`). `state` and
 * `testedAt` are set together when a Test finishes. An entry can also exist with only
 * `structuredOutput`, written when a run downgrades the structured-output mode of an untested
 * connection.
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

/** A step of a connection Test, reported as it starts. */
export type AiTestStep = 'listing' | 'probe' | 'structured' | 'health' | 'exec';

/**
 * How a CLI Test reached the Native Messaging Host: a port, or one-shot messages (Safari), which
 * cannot be cancelled.
 */
export type AiTestTransport = 'port' | 'message';

/** The outcome of one connection Test. It never carries a credential. */
export interface AiTestResult {
	connectionId: string;
	state: 'ok' | 'failing';
	testedAt: number;
	/** True when the Test sent a request the provider may bill. */
	billable: boolean;
	/** Failing only. */
	error?: SerializedAiError;
	/** Each enabled profile's model checked against the listing. */
	models?: ConnectionModelCheck[];
	/** The listed model ids, capped at `MAX_LISTED_MODELS`. */
	listedModels?: string[];
	/** The structured-output mode the probe detected. */
	structuredOutput?: Exclude<StructuredOutputSupport, 'unknown'>;
	/**
	 * Failing only: the model listing answered 404, 405, or 501 and the plan had no probe, so the
	 * Test checked nothing rather than send a request the provider may bill.
	 */
	listingUnavailable?: true;
	/** CLI only. */
	transport?: AiTestTransport;
}

/**
 * One entry of the redacted Diagnostics log (`storage.session`, `ai_diagnostics`). It never holds
 * prompts, content, keys, or job ids.
 */
export interface AiDiagnosticEntry {
	at: number;
	task: AiTask | 'test';
	kind: ConnectionKind;
	connectionId: string;
	durationMs: number;
	outcome: 'ok' | 'error' | 'cancelled';
	code?: AiErrorCode;
	/** HTTP status of the failing request, when there was one. */
	status?: number;
	structuredMode?: Exclude<StructuredOutputSupport, 'unknown'>;
	/** The run fell back from a rejected structured-output mode. */
	fallback?: true;
	/** Durable jobs: groups planned in this run. */
	groups?: number;
	/** Durable jobs: automatic retries. */
	retries?: number;
}
