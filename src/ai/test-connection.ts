import type { ApiCallOptions, ApiPromptCall, AppIdentity } from './adapters/http';
import {
	buildModelListRequest,
	fetchModelList,
	isModelListed,
	MAX_LISTED_MODELS,
	modelListUrl
} from './adapters/listing';
import type { CliCallOptions, CliRenderedPromptCall } from './adapters/native-cli';
import { isStructuredOutputRejection, type StructuredOutputMode } from './capabilities';
import { isCliKind } from './connection-kind';
import { AiError, toAiError } from './errors';
import { serializeAiError } from './protocol';
import type {
	AiTestResult,
	AiTestStep,
	AiTestTransport,
	ApiConnectionKind,
	CliConnectionKind,
	Connection,
	ConnectionStatus,
	ModelProfile,
	NativeMessagingSupport
} from './types';

// The connection Test (D3): free checks first (a model listing, the Host health check), then a
// minimal billable request only where needed (a structured-output probe, a 1-token completion,
// or one CLI exec per profile). Pure over injected network and CLI calls; DOM-free.

// The probe asks for a tiny JSON object; any successful reply proves the key, the model, and the
// structured-output mode. The text is never checked, so a reply cut off by the limit still counts.
const PROBE_MESSAGES = {
	system: 'This is a connection test. Reply with the JSON object {"ok": true} and nothing else.',
	user: 'Connection test.'
};
const PROBE_SPEC = {
	name: 'connection_test',
	schema: {
		type: 'object',
		properties: { ok: { type: 'boolean' } },
		required: ['ok'],
		additionalProperties: false
	}
};
const STRUCTURED_PROBE_MAX_TOKENS = 16;
const TEXT_PROBE_MAX_TOKENS = 1;
const PROBE_IDLE_TIMEOUT_MS = 30_000;
const PROBE_HARD_TIMEOUT_MS = 60_000;
export const CLI_TEST_PROMPT = 'This is a connection test. Reply with OK and nothing else.';
const MAX_STATUS_DETAIL_CHARS = 500;
// A listing endpoint some compatible servers do not implement; the Test then probes instead.
const LISTING_UNAVAILABLE_STATUSES: readonly number[] = [404, 405, 501];

export interface ConnectionTestPlan {
	steps: AiTestStep[];
	/** True when a step sends a request the provider may bill; the UI shows a cost note. */
	billable: boolean;
}

function hostOf(baseUrl: string | undefined): string {
	try {
		return baseUrl ? new URL(baseUrl).hostname.toLowerCase() : '';
	} catch {
		return '';
	}
}

/** The probe a connection without a usable listing falls back to. */
function fallbackProbe(connection: Pick<Connection, 'kind' | 'baseUrl'>): AiTestStep {
	return connection.kind === 'openai-compatible' && hostOf(connection.baseUrl) !== 'api.openai.com' ? 'structured' : 'probe';
}

/**
 * The steps a Test of `connection` runs, given its enabled profiles. OpenAI's own API is known to
 * accept JSON schemas, so it is only listed; other compatible servers are probed for the mode.
 */
export function connectionTestPlan(
	connection: Pick<Connection, 'kind' | 'baseUrl'>,
	profiles: readonly Pick<ModelProfile, 'model'>[] = []
): ConnectionTestPlan {
	if (isCliKind(connection.kind)) return { steps: ['health', 'exec'], billable: true };
	const steps: AiTestStep[] = [];
	if (modelListUrl(connection)) {
		steps.push('listing');
		if (fallbackProbe(connection) === 'structured' && profiles.some(profile => profile.model?.trim())) {
			steps.push('structured');
		}
	} else {
		steps.push(fallbackProbe(connection));
	}
	return { steps, billable: steps.some(step => step !== 'listing') };
}

export interface ConnectionTestDeps {
	app: AppIdentity;
	executeApi(call: ApiPromptCall, options: ApiCallOptions): Promise<string>;
	executeCli(call: CliRenderedPromptCall, options: CliCallOptions): Promise<string>;
	/** The Host health check for the CLI. Resolves with the transport it used; rejects with an AiError. */
	health(kind: CliConnectionKind, options: { connectionId: string; signal?: AbortSignal }): Promise<AiTestTransport>;
	fetchImpl?: typeof fetch;
	now?: () => number;
	listingTimeoutMs?: number;
}

export interface ConnectionTestInput {
	connection: Connection;
	/** The connection's enabled profiles, in order. */
	profiles: readonly ModelProfile[];
	credential?: string;
	nativeMessaging: NativeMessagingSupport;
}

export interface ConnectionTestOptions {
	signal?: AbortSignal;
	onStep?: (step: AiTestStep, profileId?: string) => void;
}

function redact(error: AiError, credential: string | undefined): AiError {
	const secret = credential?.trim();
	if (!secret || !error.detail?.includes(secret)) return error;
	return new AiError(error.code, {
		retryable: error.retryable,
		...(error.connectionId ? { connectionId: error.connectionId } : {}),
		...(error.status !== undefined ? { status: error.status } : {}),
		...(error.reason ? { reason: error.reason } : {}),
		detail: error.detail.split(secret).join('[redacted]'),
		...(error.nativeCode ? { nativeCode: error.nativeCode } : {}),
		...(error.timeoutSeconds !== undefined ? { timeoutSeconds: error.timeoutSeconds } : {}),
		...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {})
	});
}

/**
 * Runs the Test. Resolves `ok` or `failing`; rejects with `cancelled` when the signal aborts, after
 * which no further request is sent. A one-shot CLI exec already sent cannot be stopped.
 */
export async function runConnectionTest(
	input: ConnectionTestInput,
	deps: ConnectionTestDeps,
	options: ConnectionTestOptions = {}
): Promise<AiTestResult> {
	const { connection, credential } = input;
	const connectionId = connection.id;
	const { signal } = options;
	const now = deps.now ?? Date.now;
	const result: AiTestResult = { connectionId, state: 'ok', testedAt: 0, billable: false };
	const cancelled = () => new AiError('cancelled', { connectionId });
	const checkCancel = () => {
		if (signal?.aborted) throw cancelled();
	};
	const step = (name: AiTestStep, profileId?: string) => {
		checkCancel();
		options.onStep?.(name, profileId);
	};

	const runCli = async (kind: CliConnectionKind) => {
		if (input.nativeMessaging === 'none') throw new AiError('host-unsupported', { connectionId });
		step('health');
		result.transport = await deps.health(kind, { connectionId, ...(signal ? { signal } : {}) });
		// Codex validates each enabled profile's model and effort; Grok has neither.
		const targets: Array<ModelProfile | undefined> = kind === 'cli-codex'
			? (input.profiles.length > 0 ? [...input.profiles] : [undefined])
			: [input.profiles[0]];
		for (const profile of targets) {
			step('exec', profile?.id);
			result.billable = true;
			await deps.executeCli({
				kind,
				...(kind === 'cli-codex' && profile?.model ? { model: profile.model } : {}),
				...(kind === 'cli-codex' && profile?.options?.reasoningEffort ? { effort: profile.options.reasoningEffort } : {}),
				prompt: CLI_TEST_PROMPT
			}, { connectionId, ...(signal ? { signal } : {}) });
		}
	};

	const probeModel = (kind: ApiConnectionKind): string => {
		const model = input.profiles.find(profile => profile.model?.trim())?.model?.trim();
		// Azure names the deployment in its URL; every other kind needs a model id.
		if (!model && kind !== 'azure-openai') throw new AiError('not-configured', { reason: 'no-profile', connectionId });
		return model ?? '';
	};

	const send = (kind: ApiConnectionKind, model: string, maxTokens: number, mode?: Exclude<StructuredOutputMode, 'none'>) => {
		result.billable = true;
		return deps.executeApi({
			kind,
			baseUrl: connection.baseUrl ?? '',
			model,
			...(credential ? { credential } : {}),
			messages: PROBE_MESSAGES,
			...(mode ? { structured: { ...PROBE_SPEC, mode } } : {}),
			maxTokens,
			app: deps.app
		}, {
			connectionId,
			...(signal ? { signal } : {}),
			idleTimeoutMs: PROBE_IDLE_TIMEOUT_MS,
			hardTimeoutMs: PROBE_HARD_TIMEOUT_MS
		});
	};

	// `json_schema`, then `json_object` after a structured rejection, else `none`. A rejection of
	// the parameter already shows that the key and the endpoint work.
	const probeStructured = async (kind: ApiConnectionKind): Promise<StructuredOutputMode> => {
		const model = probeModel(kind);
		step('structured');
		for (const mode of ['json_schema', 'json_object'] as const) {
			try {
				await send(kind, model, STRUCTURED_PROBE_MAX_TOKENS, mode);
				return mode;
			} catch (error) {
				checkCancel();
				const aiError = toAiError(error, connectionId);
				if (!isStructuredOutputRejection(aiError)) throw aiError;
			}
		}
		return 'none';
	};

	const probeText = async (kind: ApiConnectionKind) => {
		const model = probeModel(kind);
		step('probe');
		await send(kind, model, TEXT_PROBE_MAX_TOKENS);
	};

	const runApi = async (kind: ApiConnectionKind) => {
		if (!connection.baseUrl?.trim()) throw new AiError('not-configured', { reason: 'base-url-missing', connectionId });
		if (connection.apiKeyRequired && !credential?.trim()) throw new AiError('credential-missing', { connectionId });
		const plan = connectionTestPlan(connection, input.profiles);
		let probe: AiTestStep | undefined = plan.steps.find(name => name !== 'listing');
		const request = plan.steps.includes('listing') ? buildModelListRequest(connection, credential) : undefined;
		if (request) {
			step('listing');
			try {
				const listed = await fetchModelList(request, {
					kind,
					connectionId,
					...(signal ? { signal } : {}),
					...(deps.listingTimeoutMs !== undefined ? { timeoutMs: deps.listingTimeoutMs } : {}),
					...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
				});
				result.listedModels = listed.slice(0, MAX_LISTED_MODELS);
				// An unlisted model does not fail the connection: the key worked. It is reported per profile.
				result.models = input.profiles
					.filter(profile => profile.model?.trim())
					.map(profile => ({ profileId: profile.id, model: profile.model as string, listed: isModelListed(profile.model as string, listed) }));
			} catch (error) {
				checkCancel();
				const aiError = toAiError(error, connectionId);
				if (aiError.status === undefined || !LISTING_UNAVAILABLE_STATUSES.includes(aiError.status)) throw aiError;
				probe = fallbackProbe(connection);
			}
		}
		if (probe === 'structured') result.structuredOutput = await probeStructured(kind);
		else if (probe === 'probe') await probeText(kind);
	};

	try {
		if (isCliKind(connection.kind)) await runCli(connection.kind as CliConnectionKind);
		else await runApi(connection.kind as ApiConnectionKind);
		checkCancel();
		return { ...result, state: 'ok', testedAt: now() };
	} catch (error) {
		if (signal?.aborted) throw cancelled();
		const aiError = redact(toAiError(error, connectionId), credential);
		if (aiError.code === 'cancelled') throw aiError;
		return { ...result, state: 'failing', testedAt: now(), error: serializeAiError(aiError) };
	}
}

/**
 * The persisted status for a finished Test. A detected structured-output mode overwrites an
 * earlier downgrade; a Test that did not probe keeps it.
 */
export function statusFromTestResult(result: AiTestResult, previous?: ConnectionStatus): ConnectionStatus {
	const error = result.error;
	const detail = error?.detail
		? (error.detail.length > MAX_STATUS_DETAIL_CHARS ? `${error.detail.slice(0, MAX_STATUS_DETAIL_CHARS)}…` : error.detail)
		: undefined;
	const structuredOutput = result.structuredOutput ?? previous?.structuredOutput;
	return {
		state: result.state,
		testedAt: result.testedAt,
		...(result.state === 'failing' && error ? { code: error.code } : {}),
		...(result.state === 'failing' && error?.status !== undefined ? { status: error.status } : {}),
		...(result.state === 'failing' && detail ? { detail } : {}),
		...(result.models ? { models: result.models.map(model => ({ ...model })) } : {}),
		...(structuredOutput ? { structuredOutput } : {})
	};
}
