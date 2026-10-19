import { defaultStructuredOutputMode, type StructuredOutputMode } from './capabilities';
import { isCliKind } from './connection-kind';
import { AiError } from './errors';
import type { AiSettingsView, AiTask, Connection, ConnectionStatus, ModelProfile } from './types';

export type ResolvedProfile =
	| { ok: true; profile: ModelProfile; connection: Connection; credential?: string }
	| { ok: false; error: AiError };

function fail(error: AiError): ResolvedProfile {
	return { ok: false, error };
}

export interface ResolveProfileOptions {
	/** An explicit choice for this run, such as the popup's model menu. Beats routing. */
	profileId?: string;
}

/** The single place that decides which model profile serves a task. */
export function resolveProfile(
	view: AiSettingsView,
	task: AiTask,
	options: ResolveProfileOptions = {}
): ResolvedProfile {
	if (!view.enabled) return fail(new AiError('not-configured', { reason: 'disabled' }));

	const profileId = options.profileId
		?? view.routing.taskProfiles[task]
		?? view.routing.defaultProfileId;
	if (!profileId) return fail(new AiError('not-configured', { reason: 'no-profile' }));

	const profile = view.profiles.find(item => item.id === profileId);
	if (!profile?.enabled) {
		return fail(new AiError('not-configured', { reason: 'profile-unavailable' }));
	}

	const connection = view.connections.find(item => item.id === profile.connectionId);
	if (!connection) return fail(new AiError('not-configured', { reason: 'connection-missing' }));
	const connectionId = connection.id;

	if (isCliKind(connection.kind)) {
		return view.nativeMessaging === 'none'
			? fail(new AiError('host-unsupported', { connectionId }))
			: { ok: true, profile, connection };
	}

	if (!connection.baseUrl?.trim()) {
		return fail(new AiError('not-configured', { reason: 'base-url-missing', connectionId }));
	}
	const credential = view.credentials[connectionId]?.trim() ? view.credentials[connectionId] : undefined;
	// A view loaded without keys still knows which connections have one.
	const hasCredential = credential !== undefined || view.credentialIds?.includes(connectionId) === true;
	if (connection.apiKeyRequired && !hasCredential) {
		return fail(new AiError('credential-missing', { connectionId }));
	}
	return { ok: true, profile, connection, ...(credential ? { credential } : {}) };
}

export function resolveResponseLanguage(view: AiSettingsView, browserLanguage?: string): string {
	return view.routing.responseLanguage?.trim() || browserLanguage?.trim() || 'English';
}

/**
 * The structured-output mode a run uses: this device's override (a Test result or a provider's
 * rejection, in `ai_connection_status`), then the mode a Test stored on the synced connection, then
 * the kind's default.
 */
export function effectiveStructuredOutput(
	connection: Pick<Connection, 'kind' | 'baseUrl' | 'structuredOutput'>,
	status?: Pick<ConnectionStatus, 'structuredOutput'>
): StructuredOutputMode {
	if (status?.structuredOutput) return status.structuredOutput;
	if (connection.structuredOutput && connection.structuredOutput !== 'unknown') return connection.structuredOutput;
	return defaultStructuredOutputMode(connection.kind, connection.baseUrl);
}
