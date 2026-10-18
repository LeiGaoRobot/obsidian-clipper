export interface PopularModel {
	id: string;
	name: string;
	recommended?: boolean;
}

export interface PresetProvider {
	id: string;
	name: string;
	baseUrl: string;
	apiKeyUrl?: string;
	apiKeyRequired?: boolean;
	modelsList?: string;
	popularModels?: PopularModel[];
}

export interface ProviderPresets {
	version: string;
	[key: string]: PresetProvider | string;
}

export const DEEPSEEK_V4_MODELS: PopularModel[] = [
	{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', recommended: true },
	{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }
];

export function normalizeProviderPresets(
	data: ProviderPresets
): Record<string, PresetProvider> {
	const providers: Record<string, PresetProvider> = {};

	for (const key in data) {
		if (key === 'version' || !Object.prototype.hasOwnProperty.call(data, key)) continue;
		providers[key] = {
			...(data[key] as PresetProvider),
			id: key
		};
	}

	if (providers.deepseek) {
		providers.deepseek = {
			...providers.deepseek,
			popularModels: DEEPSEEK_V4_MODELS.map(model => ({ ...model }))
		};
	}

	return providers;
}
