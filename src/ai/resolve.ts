import { isCliKind } from './connection-kind';
import { AiError } from './errors';
import type { AiSettingsView, AiTask, Connection, ModelProfile } from './types';

export type ResolvedProfile =
	| { ok: true; profile: ModelProfile; connection: Connection; credential?: string }
	| { ok: false; error: AiError };

function fail(error: AiError): ResolvedProfile {
	return { ok: false, error };
}

/** The single place that decides which model profile serves a task. */
export function resolveProfile(view: AiSettingsView, task: AiTask): ResolvedProfile {
	if (!view.enabled) return fail(new AiError('not-configured', { reason: 'disabled' }));

	const profileId = view.routing.taskProfiles[task] ?? view.routing.defaultProfileId;
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
	if (connection.apiKeyRequired && !credential) {
		return fail(new AiError('credential-missing', { connectionId }));
	}
	return { ok: true, profile, connection, ...(credential ? { credential } : {}) };
}

export function resolveResponseLanguage(view: AiSettingsView, browserLanguage?: string): string {
	return view.routing.responseLanguage?.trim() || browserLanguage?.trim() || 'English';
}
