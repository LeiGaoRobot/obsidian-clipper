import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { inferConnectionKind, isCliKind } from './connection-kind';
import type { ConnectionKind } from './types';

interface CatalogPreset {
	name: string;
	baseUrl: string;
}

const catalog = JSON.parse(
	readFileSync(resolve(process.cwd(), 'providers.json'), 'utf8')
) as Record<string, CatalogPreset | string>;

// The wire branch llm-client.ts selects today for each bundled preset.
const legacyWireKinds: Record<string, ConnectionKind> = {
	anthropic: 'anthropic',
	'azure-openai': 'azure-openai',
	deepseek: 'openai-compatible',
	'google-gemini': 'openai-compatible',
	huggingface: 'huggingface',
	meta: 'openai-compatible',
	ollama: 'ollama',
	openai: 'openai-compatible',
	openrouter: 'openai-compatible',
	perplexity: 'perplexity',
	xai: 'openai-compatible'
};

describe('inferConnectionKind', () => {
	test('covers every bundled preset', () => {
		const presetIds = Object.keys(catalog).filter(key => key !== 'version').sort();
		expect(presetIds).toEqual(Object.keys(legacyWireKinds).sort());
	});

	test.each(Object.entries(legacyWireKinds))(
		'matches the legacy wire branch for the %s preset',
		(presetId, kind) => {
			const preset = catalog[presetId] as CatalogPreset;
			expect(inferConnectionKind({ name: preset.name, baseUrl: preset.baseUrl })).toBe(kind);
		}
	);

	test('prefers an explicit preset id', () => {
		expect(inferConnectionKind({
			name: 'Work proxy',
			baseUrl: 'https://proxy.example/v1/messages',
			presetId: 'anthropic'
		})).toBe('anthropic');
	});

	test('keeps the protocol when a provider is renamed', () => {
		expect(inferConnectionKind({
			name: 'My Claude',
			baseUrl: 'https://api.anthropic.com/v1/messages'
		})).toBe('anthropic');
		expect(inferConnectionKind({
			name: 'Local',
			baseUrl: 'http://localhost:11434/api/chat'
		})).toBe('ollama');
		expect(inferConnectionKind({
			name: 'Team Azure',
			baseUrl: 'https://team.openai.azure.com/openai/deployments/gpt/chat/completions'
		})).toBe('azure-openai');
	});

	test('falls back to the legacy name rules for proxies', () => {
		expect(inferConnectionKind({
			name: 'Anthropic (proxy)',
			baseUrl: 'https://gateway.example/v1/messages'
		})).toBe('anthropic');
		expect(inferConnectionKind({
			name: 'Ollama on NAS',
			baseUrl: 'http://nas.local:8080/chat'
		})).toBe('ollama');
	});

	test('keeps Ollama OpenAI-compatible endpoints on the OpenAI wire format', () => {
		expect(inferConnectionKind({
			name: 'Local',
			baseUrl: 'http://localhost:11434/v1/chat/completions'
		})).toBe('openai-compatible');
	});

	test('defaults to OpenAI-compatible', () => {
		expect(inferConnectionKind({
			name: 'LM Studio',
			baseUrl: 'http://127.0.0.1:1234/v1/chat/completions'
		})).toBe('openai-compatible');
		expect(inferConnectionKind({ name: 'Broken', baseUrl: 'not a url' })).toBe('openai-compatible');
	});

	test('ignores an unknown preset id', () => {
		expect(inferConnectionKind({
			name: 'Custom',
			baseUrl: 'https://api.perplexity.ai/chat/completions',
			presetId: 'removed-preset'
		})).toBe('perplexity');
	});
});

describe('isCliKind', () => {
	test('identifies CLI kinds', () => {
		expect(isCliKind('cli-codex')).toBe(true);
		expect(isCliKind('cli-grok')).toBe(true);
		expect(isCliKind('anthropic')).toBe(false);
	});
});
