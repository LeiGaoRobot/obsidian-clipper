import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	CATALOG,
	CATALOG_VERSION,
	findCatalogEntryByBaseUrl,
	getCatalogEntry,
	normalizeCatalog,
	PRESET_KINDS
} from './catalog';

const raw = JSON.parse(
	readFileSync(resolve(process.cwd(), 'providers.json'), 'utf8')
) as Record<string, unknown>;
const rawIds = Object.keys(raw).filter(key => key !== 'version');

describe('CATALOG', () => {
	test('lists every providers.json entry in file order', () => {
		expect(CATALOG.map(entry => entry.id)).toEqual(rawIds);
		expect(CATALOG_VERSION).toBe(raw.version);
	});

	test('gives every entry a kind from the preset table', () => {
		for (const entry of CATALOG) {
			expect(PRESET_KINDS[entry.id], entry.id).toBeDefined();
			expect(entry.kind).toBe(PRESET_KINDS[entry.id]);
		}
		expect(Object.keys(PRESET_KINDS).sort()).toEqual([...rawIds].sort());
	});

	test('defaults apiKeyRequired to true unless the file says false', () => {
		expect(getCatalogEntry('ollama')?.apiKeyRequired).toBe(false);
		// Neither entry sets the flag in providers.json.
		expect(getCatalogEntry('huggingface')?.apiKeyRequired).toBe(true);
		expect(getCatalogEntry('meta')?.apiKeyRequired).toBe(true);
		expect(getCatalogEntry('openai')?.apiKeyRequired).toBe(true);
	});

	test('lists the DeepSeek V4 models from the file', () => {
		expect(getCatalogEntry('deepseek')?.popularModels).toEqual([
			{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', recommended: true },
			{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }
		]);
	});

	test('keeps the optional links and an empty model list when absent', () => {
		expect(getCatalogEntry('anthropic')).toMatchObject({
			name: 'Anthropic',
			kind: 'anthropic',
			baseUrl: 'https://api.anthropic.com/v1/messages',
			apiKeyUrl: 'https://console.anthropic.com/settings/keys',
			modelsList: 'https://platform.claude.com/docs/en/about-claude/models/overview'
		});
		const huggingface = getCatalogEntry('huggingface');
		expect(huggingface?.popularModels).toEqual([]);
		expect(getCatalogEntry('ollama')?.apiKeyUrl).toBeUndefined();
	});

	test('is frozen', () => {
		expect(Object.isFrozen(CATALOG)).toBe(true);
		expect(Object.isFrozen(CATALOG[0])).toBe(true);
		expect(Object.isFrozen(CATALOG[0].popularModels)).toBe(true);
	});
});

describe('normalizeCatalog', () => {
	test('skips malformed entries and models, and falls back to OpenAI-compatible', () => {
		expect(normalizeCatalog({
			version: '1',
			broken: 'nope',
			'no-url': { name: 'No URL' },
			custom: {
				baseUrl: 'https://custom.example/v1/chat/completions',
				apiKeyRequired: 'yes',
				popularModels: [{ id: 'm' }, { name: 'no id' }, null]
			}
		})).toEqual([{
			id: 'custom',
			name: 'custom',
			kind: 'openai-compatible',
			baseUrl: 'https://custom.example/v1/chat/completions',
			apiKeyRequired: true,
			popularModels: [{ id: 'm', name: 'm' }]
		}]);
		expect(normalizeCatalog(null)).toEqual([]);
	});
});

describe('findCatalogEntryByBaseUrl', () => {
	test('matches a catalog base URL exactly', () => {
		expect(findCatalogEntryByBaseUrl('https://api.deepseek.com/v1/chat/completions')?.id).toBe('deepseek');
		expect(findCatalogEntryByBaseUrl(' http://127.0.0.1:11434/api/chat ')?.id).toBe('ollama');
	});

	test('does not match a different path, host, or a non-string', () => {
		expect(findCatalogEntryByBaseUrl('https://api.openai.com/v1/responses')).toBeUndefined();
		expect(findCatalogEntryByBaseUrl('https://proxy.example/v1/chat/completions')).toBeUndefined();
		expect(findCatalogEntryByBaseUrl('')).toBeUndefined();
		expect(findCatalogEntryByBaseUrl(undefined)).toBeUndefined();
	});
});
