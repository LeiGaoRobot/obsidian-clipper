import type { AiRouting, AiSettingsView, AiTask, Connection, ModelProfile } from '../ai/types';
import { aiSettingsStore } from './ai-settings';
import { getMessage } from './i18n';

// Profile listing, labels, and per-task routing writes shared by the Popup model select and the
// Reader engine switch. Availability (credentials, Native Messaging) is left to the background
// resolver: the Reader runs as a content script whose view cannot see the Host, so nothing here
// hides or rejects a CLI profile.

export interface ProfileGroup {
	connection: Connection;
	/** The connection's display name, used as the `<optgroup>` label. */
	label: string;
	profiles: ModelProfile[];
}

function hostOf(baseUrl: string | undefined): string {
	try {
		return baseUrl ? new URL(baseUrl).host : '';
	} catch {
		return '';
	}
}

/** A connection's display name. Derived CLI connections have no label and are named by kind. */
export function connectionDisplayName(connection: Connection): string {
	const label = connection.label.trim();
	if (label) return label;
	if (connection.kind === 'cli-codex') return getMessage('interpreterExecutionModeCodex');
	if (connection.kind === 'cli-grok') return getMessage('interpreterExecutionModeGrok');
	return hostOf(connection.baseUrl) || connection.id;
}

/** A profile's own name: its label, else its model id, else its connection's name. */
export function profileDisplayName(profile: ModelProfile, connection: Connection): string {
	return profile.label.trim() || profile.model?.trim() || connectionDisplayName(connection);
}

/** `connection · model`, or just the connection's name when the profile adds nothing to it. */
export function profileDisplayLabel(profile: ModelProfile, connection: Connection): string {
	const connectionName = connectionDisplayName(connection);
	const profileName = profileDisplayName(profile, connection);
	return profileName === connectionName ? connectionName : `${connectionName} · ${profileName}`;
}

/** Enabled profiles whose connection exists, grouped in connection order, CLI connections included. */
export function listEnabledProfileGroups(view: AiSettingsView): ProfileGroup[] {
	return view.connections
		.map(connection => ({
			connection,
			label: connectionDisplayName(connection),
			profiles: view.profiles.filter(profile => profile.enabled && profile.connectionId === connection.id)
		}))
		.filter(group => group.profiles.length > 0);
}

export function findProfileConnection(
	view: AiSettingsView,
	profileId: string | undefined
): { profile: ModelProfile; connection: Connection } | undefined {
	const profile = profileId ? view.profiles.find(item => item.id === profileId) : undefined;
	const connection = profile ? view.connections.find(item => item.id === profile.connectionId) : undefined;
	return profile && connection ? { profile, connection } : undefined;
}

/** The profile id routing names for a task, without availability checks. */
export function routedProfileId(view: AiSettingsView, task: AiTask): string | undefined {
	return view.routing.taskProfiles[task] ?? view.routing.defaultProfileId;
}

/**
 * Routing with `task` served by `profileId`. A choice equal to the default deletes the task entry,
 * so the routing table reads "Default" unless the user diverged.
 */
export function routingWithTaskProfile(routing: AiRouting, task: AiTask, profileId: string): AiRouting {
	const taskProfiles = { ...routing.taskProfiles };
	if (profileId === routing.defaultProfileId) delete taskProfiles[task];
	else taskProfiles[task] = profileId;
	return { ...routing, taskProfiles };
}

export interface TaskProfileWrite {
	/** False when nothing was stored: the store is read-only until v2 exists (derived mode). */
	written: boolean;
	/** The freshly loaded view with the new routing applied, written or not. */
	view: AiSettingsView;
}

/**
 * Routes `task` to `profileId` through the v2 store, read-modify-write over a fresh load so a
 * concurrent Settings change to another task is kept. Callers own the derived-mode fallback.
 */
export async function saveTaskProfile(task: AiTask, profileId: string): Promise<TaskProfileWrite> {
	const current = await aiSettingsStore.load();
	if (!findProfileConnection(current, profileId)) {
		throw new Error(`Unknown AI profile: ${profileId}`);
	}
	const routing = routingWithTaskProfile(current.routing, task, profileId);
	const written = await aiSettingsStore.saveRouting(routing);
	return { written, view: { ...current, routing } };
}
