import { getMessage } from '../utils/i18n';
import type { AiError, AiErrorCode } from './errors';

export type AiErrorAction =
	| 'openSettings'
	| 'retry'
	| 'continueRemaining'
	| 'copyInstallCommand'
	| 'switchProfile'
	| 'none';

export interface AiErrorDescription {
	title: string;
	body: string;
	action: AiErrorAction;
	/** Raw provider or CLI detail, for an optional disclosure. Never localized. */
	detail?: string;
}

const ACTIONS: Record<AiErrorCode, AiErrorAction> = {
	'not-configured': 'openSettings',
	'credential-missing': 'openSettings',
	auth: 'openSettings',
	'model-unavailable': 'switchProfile',
	'rate-limited': 'retry',
	quota: 'switchProfile',
	timeout: 'retry',
	network: 'retry',
	'host-missing': 'copyInstallCommand',
	'host-outdated': 'copyInstallCommand',
	'host-unsupported': 'switchProfile',
	'cli-missing': 'copyInstallCommand',
	// Reserved: Phase 2 CLI adapter must detect sign-in failures from stderr.
	'cli-not-authenticated': 'none',
	'bad-response': 'retry',
	incomplete: 'continueRemaining',
	cancelled: 'none',
	'provider-error': 'retry'
};

function messageKeyStem(code: AiErrorCode): string {
	return 'aiError' + code
		.split('-')
		.map(part => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');
}

export function aiErrorMessageKeys(code: AiErrorCode): { title: string; body: string } {
	const stem = messageKeyStem(code);
	return { title: `${stem}Title`, body: `${stem}Body` };
}

export function describeAiError(error: AiError): AiErrorDescription {
	const keys = aiErrorMessageKeys(error.code);
	const action = error.code === 'provider-error' && !error.retryable
		? 'none'
		: ACTIONS[error.code];
	return {
		title: getMessage(keys.title),
		// A transcript job that timed out after splitting its groups: the remaining batches can continue.
		body: getMessage(error.recovery === 'continue-remaining' ? 'readerTranscriptTranslationBatchFailed' : keys.body),
		action,
		...(error.detail && error.detail !== error.code ? { detail: error.detail } : {})
	};
}
