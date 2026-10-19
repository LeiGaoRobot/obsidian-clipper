import type { Settings } from '../types/types';
import { inferConnectionKind } from './connection-kind';
import type {
	AiSettingsView,
	Connection,
	ModelProfile,
	NativeMessagingSupport
} from './types';

export const LEGACY_CODEX_CONNECTION_ID = 'legacy-cli-codex';
export const LEGACY_GROK_CONNECTION_ID = 'legacy-cli-grok';
export const LEGACY_CODEX_PROFILE_ID = 'legacy-cli-codex-default';
export const LEGACY_GROK_PROFILE_ID = 'legacy-cli-grok-default';

export interface DeriveAiSettingsOptions {
	nativeMessaging: NativeMessagingSupport;
}

function legacyDefaultProfileId(settings: Settings): string | undefined {
	const mode = settings.interpreterExecutionMode ?? 'api';
	if (mode === 'codex') return LEGACY_CODEX_PROFILE_ID;
	if (mode === 'grok') return LEGACY_GROK_PROFILE_ID;
	const enabledModels = settings.models.filter(model => model.enabled);
	const selected = enabledModels.find(model => model.id === settings.interpreterModel)
		|| enabledModels[0];
	return selected?.id;
}

/**
 * Computes the v2 AI settings view from v1 settings without persisting or mutating anything.
 * Until the v2 Settings section ships, v1 remains the only stored source of truth.
 */
export function deriveAiSettings(
	settings: Settings,
	{ nativeMessaging }: DeriveAiSettingsOptions
): AiSettingsView {
	const credentials: Record<string, string> = {};
	const apiConnections: Connection[] = settings.providers.map(provider => {
		if (typeof provider.apiKey === 'string' && provider.apiKey.trim()) {
			credentials[provider.id] = provider.apiKey;
		}
		return {
			id: provider.id,
			kind: inferConnectionKind(provider),
			label: typeof provider.name === 'string' ? provider.name : '',
			...(provider.presetId ? { presetId: provider.presetId } : {}),
			baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : '',
			// v1 treats a missing flag as "not required" everywhere it is read.
			apiKeyRequired: provider.apiKeyRequired === true
		};
	});
	// CLI labels stay empty: UI code localizes them from `kind`, keeping this module i18n-free.
	const cliConnections: Connection[] = [
		{ id: LEGACY_CODEX_CONNECTION_ID, kind: 'cli-codex', label: '' },
		{ id: LEGACY_GROK_CONNECTION_ID, kind: 'cli-grok', label: '' }
	];

	const apiProfiles: ModelProfile[] = settings.models.map(model => ({
		id: model.id,
		connectionId: model.providerId,
		model: model.providerModelId,
		label: model.name,
		enabled: model.enabled
	}));
	const codexOptions = settings.interpreterCodexReasoningEffort
		? { reasoningEffort: settings.interpreterCodexReasoningEffort }
		: undefined;
	const cliProfiles: ModelProfile[] = [
		{
			id: LEGACY_CODEX_PROFILE_ID,
			connectionId: LEGACY_CODEX_CONNECTION_ID,
			...(settings.interpreterCodexModel ? { model: settings.interpreterCodexModel } : {}),
			label: '',
			...(codexOptions ? { options: codexOptions } : {}),
			enabled: true
		},
		{
			id: LEGACY_GROK_PROFILE_ID,
			connectionId: LEGACY_GROK_CONNECTION_ID,
			label: '',
			enabled: true
		}
	];

	const responseLanguage = settings.readerSettings?.learningResponseLanguage?.trim();
	return {
		enabled: settings.interpreterEnabled,
		connections: [...apiConnections, ...cliConnections],
		profiles: [...apiProfiles, ...cliProfiles],
		routing: {
			defaultProfileId: legacyDefaultProfileId(settings),
			taskProfiles: {},
			...(responseLanguage ? { responseLanguage } : {})
		},
		interpreter: {
			autoRun: settings.interpreterAutoRun,
			defaultPromptContext: settings.defaultPromptContext
		},
		credentials,
		nativeMessaging
	};
}
