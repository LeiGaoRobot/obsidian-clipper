import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	DEEPSEEK_V4_MODELS,
	normalizeProviderPresets,
	type PresetProvider,
	type ProviderPresets
} from './provider-presets';

const legacyDeepSeek: PresetProvider = {
	id: 'deepseek',
	name: 'DeepSeek',
	apiKeyUrl: 'https://platform.deepseek.com/api_keys',
	apiKeyRequired: true,
	modelsList: 'https://api-docs.deepseek.com/quick_start/pricing',
	baseUrl: 'https://api.deepseek.com/v1/chat/completions',
	popularModels: [
		{ id: 'deepseek-chat', name: 'DeepSeek Chat' },
		{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }
	]
};

const legacyCatalog: ProviderPresets = {
	version: 'legacy',
	deepseek: legacyDeepSeek,
	anthropic: {
		id: 'anthropic',
		name: 'Anthropic',
		baseUrl: 'https://api.anthropic.com/v1/messages',
		apiKeyRequired: true
	}
};

describe('provider preset normalization', () => {
	test('replaces only DeepSeek recommendations with the V4 contract', () => {
		const savedLegacyModel = { providerModelId: 'deepseek-chat' };
		const result = normalizeProviderPresets(legacyCatalog);

		expect(result.deepseek).toEqual({
			...legacyDeepSeek,
			popularModels: DEEPSEEK_V4_MODELS
		});
		expect(result.anthropic).toEqual(legacyCatalog.anthropic);
		expect(legacyDeepSeek.popularModels?.[0].id).toBe('deepseek-chat');
		expect(savedLegacyModel.providerModelId).toBe('deepseek-chat');
		expect(result.deepseek.popularModels?.some(
			model => model.id === savedLegacyModel.providerModelId
		)).toBe(false);
	});

	test('does not synthesize DeepSeek when it is absent', () => {
		const result = normalizeProviderPresets({
			version: 'no-deepseek',
			anthropic: legacyCatalog.anthropic
		});

		expect(result).toEqual({ anthropic: legacyCatalog.anthropic });
		expect(result).not.toHaveProperty('deepseek');
	});
});

test('keeps the published catalog and guide on the DeepSeek V4 contract', () => {
	const catalog = JSON.parse(readFileSync(
		resolve(process.cwd(), 'providers.json'),
		'utf8'
	));
	const guide = readFileSync(
		resolve(process.cwd(), 'docs/Interpret web pages.md'),
		'utf8'
	);

	expect(catalog.version).toBe('2026.08.07');
	expect(catalog.deepseek.popularModels).toEqual(DEEPSEEK_V4_MODELS);
	expect(guide).toContain('`deepseek-v4-flash`');
	expect(guide).toContain('`deepseek-v4-pro`');
	expect(guide).toContain('not automatically migrate');
});
