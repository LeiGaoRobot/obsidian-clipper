import browser from './browser-polyfill';
import { getMessage } from './i18n';
import type { NativeCliErrorCode, NativeCliHealth } from './native-cli-contract';
import type { NativeCliLastRunStatus } from './native-cli-service';

interface NativeCliHealthResponse {
	success: boolean;
	health?: NativeCliHealth;
	lastRun?: NativeCliLastRunStatus;
	error?: string;
	errorCode?: NativeCliErrorCode | 'failed';
	errorDetails?: Record<string, unknown>;
}

export interface NativeCliDiagnostics {
	health: NativeCliHealth;
	lastRun?: NativeCliLastRunStatus;
}

export class NativeCliHealthError extends Error {
	code: NativeCliErrorCode | 'failed';
	details?: Record<string, unknown>;

	constructor(
		code: NativeCliErrorCode | 'failed',
		message: string,
		details?: Record<string, unknown>
	) {
		super(message);
		this.name = 'NativeCliHealthError';
		this.code = code;
		this.details = details;
	}
}

export async function requestNativeCliHealth(mode: 'grok' | 'codex'): Promise<NativeCliDiagnostics> {
	const response = await browser.runtime.sendMessage({
		action: 'nativeCliHealth',
		mode
	}) as NativeCliHealthResponse;
	if (!response?.success || !response.health) {
		throw new NativeCliHealthError(
			response?.errorCode || 'failed',
			response?.error || getMessage('error'),
			response?.errorDetails
		);
	}
	return { health: response.health, lastRun: response.lastRun };
}
