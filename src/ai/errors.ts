import type { ConnectionKind } from './types';

export const AI_ERROR_CODES = [
	'not-configured',
	'credential-missing',
	'auth',
	'model-unavailable',
	'rate-limited',
	'quota',
	'timeout',
	'network',
	'host-missing',
	'host-outdated',
	'host-unsupported',
	'cli-missing',
	'cli-not-authenticated',
	'bad-response',
	'incomplete',
	'cancelled',
	'provider-error'
] as const;

export type AiErrorCode = typeof AI_ERROR_CODES[number];

/** Why a profile could not be resolved, for `not-configured` errors. */
export type AiNotConfiguredReason =
	| 'disabled'
	| 'no-profile'
	| 'profile-unavailable'
	| 'connection-missing'
	| 'base-url-missing';

const RETRYABLE_BY_DEFAULT: Record<AiErrorCode, boolean> = {
	'not-configured': false,
	'credential-missing': false,
	auth: false,
	'model-unavailable': false,
	'rate-limited': true,
	quota: false,
	timeout: true,
	network: true,
	'host-missing': false,
	'host-outdated': false,
	'host-unsupported': false,
	'cli-missing': false,
	'cli-not-authenticated': false,
	'bad-response': true,
	incomplete: true,
	cancelled: true,
	'provider-error': false
};

export interface AiErrorOptions {
	retryable?: boolean;
	connectionId?: string;
	status?: number;
	reason?: AiNotConfiguredReason;
	detail?: string;
	/** The Native Messaging Host's own error code, kept for callers that still localize it. */
	nativeCode?: string;
	/** The limit that expired, for `timeout` errors. */
	timeoutSeconds?: number;
	/** The provider's `Retry-After`, as milliseconds from when the response arrived. */
	retryAfterMs?: number;
}

export class AiError extends Error {
	readonly code: AiErrorCode;
	readonly retryable: boolean;
	readonly connectionId?: string;
	readonly status?: number;
	readonly reason?: AiNotConfiguredReason;
	readonly detail?: string;
	readonly nativeCode?: string;
	readonly timeoutSeconds?: number;
	readonly retryAfterMs?: number;

	constructor(code: AiErrorCode, options: AiErrorOptions = {}) {
		super(options.detail || code);
		this.name = 'AiError';
		this.code = code;
		this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT[code];
		if (options.connectionId) this.connectionId = options.connectionId;
		if (options.status !== undefined) this.status = options.status;
		if (options.reason) this.reason = options.reason;
		if (options.detail) this.detail = options.detail;
		if (options.nativeCode) this.nativeCode = options.nativeCode;
		if (options.timeoutSeconds !== undefined) this.timeoutSeconds = options.timeoutSeconds;
		if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
	}
}

const MAX_DETAIL_CHARS = 2000;

export function isAiError(value: unknown): value is AiError {
	return value instanceof AiError;
}

// Native Messaging codes from native-cli-contract.ts, plus the runtime's generic 'failed'.
const NATIVE_CODE_MAP: Record<string, AiErrorCode> = {
	cancelled: 'cancelled',
	timeout: 'timeout',
	unavailable: 'host-missing',
	'protocol-mismatch': 'host-outdated',
	config: 'cli-missing',
	'launch-failed': 'cli-missing',
	'response-too-large': 'bad-response',
	'cli-failed': 'provider-error',
	invalid: 'provider-error',
	failed: 'provider-error'
};

const NATIVE_ERROR_NAMES = new Set([
	'NativeCliExecutionError',
	'LanguageLearningRequestError'
]);

/**
 * Normalizes any thrown value into an AiError. Uses error names and codes rather than
 * imports so this module stays free of browser runtime dependencies.
 */
export function toAiError(error: unknown, connectionId?: string): AiError {
	if (isAiError(error)) return error;
	const context = connectionId ? { connectionId } : {};
	if (!(error instanceof Error)) {
		return new AiError('provider-error', { ...context, detail: String(error) });
	}
	const detail = error.message;
	if (error.name === 'AbortError' || error.name === 'RequestCancelledError') {
		return new AiError('cancelled', { ...context, detail });
	}
	if (error.name === 'NativeCliUnavailableError') {
		return new AiError('host-missing', { ...context, detail });
	}
	if (NATIVE_ERROR_NAMES.has(error.name)) {
		const native = error as Error & { code?: unknown; details?: { timeoutSeconds?: unknown } };
		const nativeCode = typeof native.code === 'string' ? native.code : undefined;
		const timeoutSeconds = native.details?.timeoutSeconds;
		return new AiError((nativeCode && NATIVE_CODE_MAP[nativeCode]) || 'provider-error', {
			...context,
			detail,
			...(nativeCode ? { nativeCode } : {}),
			...(typeof timeoutSeconds === 'number' ? { timeoutSeconds } : {})
		});
	}
	// fetch() failures across Chrome, Firefox, and Safari; other TypeErrors are bugs, not network issues.
	if (error instanceof TypeError && NETWORK_FAILURE_PATTERN.test(detail)) {
		return new AiError('network', { ...context, detail });
	}
	return new AiError('provider-error', { ...context, detail });
}

const NETWORK_FAILURE_PATTERN = /failed to fetch|networkerror|load failed|network request failed/i;
const QUOTA_PATTERN = /insufficient_quota|quota|billing|credit balance/i;

export interface HttpErrorContext {
	connectionId?: string;
	kind?: ConnectionKind;
}

export interface HttpErrorOptions {
	/** Parsed `Retry-After` header; see `parseRetryAfter` in adapters/http.ts. */
	retryAfterMs?: number;
}

export function classifyHttpStatus(
	status: number,
	body = '',
	context: HttpErrorContext = {},
	httpOptions: HttpErrorOptions = {}
): AiError {
	const detail = body.length > MAX_DETAIL_CHARS ? `${body.slice(0, MAX_DETAIL_CHARS)}…` : body;
	const options = {
		status,
		...(context.connectionId ? { connectionId: context.connectionId } : {}),
		...(detail ? { detail } : {}),
		...(httpOptions.retryAfterMs !== undefined ? { retryAfterMs: httpOptions.retryAfterMs } : {})
	};
	// Ollama answers 403 when the extension origin is not in OLLAMA_ORIGINS; no key is involved.
	if (status === 403 && context.kind === 'ollama') return new AiError('provider-error', options);
	if (status === 401 || status === 403) return new AiError('auth', options);
	if (status === 402) return new AiError('quota', options);
	if (status === 404) return new AiError('model-unavailable', options);
	if (status === 408) return new AiError('timeout', options);
	if (status === 429) {
		return new AiError(QUOTA_PATTERN.test(body) ? 'quota' : 'rate-limited', options);
	}
	if ([500, 502, 503, 504, 529].includes(status)) {
		return new AiError('provider-error', { ...options, retryable: true });
	}
	return new AiError('provider-error', options);
}
