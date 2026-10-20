import { describe, expect, test, vi } from 'vitest';
import { CATALOG, getCatalogEntry } from '../catalog';
import { buildModelListRequest, fetchModelList, isModelListed, modelListUrl, parseModelList } from './listing';

function catalogConnection(id: string) {
	const entry = getCatalogEntry(id);
	if (!entry) throw new Error(`Missing catalog entry ${id}`);
	return { kind: entry.kind, baseUrl: entry.baseUrl };
}

describe('model listing URLs', () => {
	test.each([
		['openai', 'https://api.openai.com/v1/models'],
		['deepseek', 'https://api.deepseek.com/v1/models'],
		['openrouter', 'https://openrouter.ai/api/v1/models'],
		['xai', 'https://api.x.ai/v1/models'],
		['meta', 'https://api.llama.com/v1/models'],
		['google-gemini', 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'],
		['anthropic', 'https://api.anthropic.com/v1/models?limit=1000'],
		['ollama', 'http://127.0.0.1:11434/api/tags']
	])('%s lists at %s', (id, url) => {
		expect(modelListUrl(catalogConnection(id))).toBe(url);
	});

	test.each(['azure-openai', 'huggingface', 'perplexity'])('%s has no listing', id => {
		expect(modelListUrl(catalogConnection(id))).toBeUndefined();
	});

	test('every catalog entry is covered above', () => {
		expect(CATALOG.map(entry => entry.id).sort()).toEqual(
			['anthropic', 'azure-openai', 'deepseek', 'google-gemini', 'huggingface', 'meta', 'ollama', 'openai', 'openrouter', 'perplexity', 'xai']
		);
	});

	test('keeps the query string and derives Ollama’s OpenAI path', () => {
		expect(modelListUrl({ kind: 'openai-compatible', baseUrl: 'https://proxy.example.com/v1/chat/completions?tenant=a&b=1' }))
			.toBe('https://proxy.example.com/v1/models?tenant=a&b=1');
		expect(modelListUrl({ kind: 'ollama', baseUrl: 'http://localhost:11434/v1/chat/completions' }))
			.toBe('http://localhost:11434/v1/models');
		expect(modelListUrl({ kind: 'anthropic', baseUrl: 'https://proxy.example.com/v1/messages?limit=50' }))
			.toBe('https://proxy.example.com/v1/models?limit=50');
	});

	test('a base URL without a known suffix, a template, or a CLI has no listing', () => {
		expect(modelListUrl({ kind: 'openai-compatible', baseUrl: 'https://example.com/generate' })).toBeUndefined();
		expect(modelListUrl({ kind: 'openai-compatible', baseUrl: 'https://{host}/v1/chat/completions' })).toBeUndefined();
		expect(modelListUrl({ kind: 'openai-compatible', baseUrl: 'not a url' })).toBeUndefined();
		expect(modelListUrl({ kind: 'cli-codex' })).toBeUndefined();
	});
});

describe('model listing requests', () => {
	test('send the kind’s credential header', () => {
		expect(buildModelListRequest(catalogConnection('openai'), 'sk-1')).toEqual({
			url: 'https://api.openai.com/v1/models',
			headers: { Authorization: 'Bearer sk-1' }
		});
		expect(buildModelListRequest(catalogConnection('google-gemini'), 'g-1')).toEqual({
			url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
			headers: { 'x-goog-api-key': 'g-1' }
		});
		expect(buildModelListRequest(catalogConnection('anthropic'), 'a-1')?.headers).toEqual({
			'x-api-key': 'a-1',
			'anthropic-version': '2023-06-01',
			'anthropic-dangerous-direct-browser-access': 'true'
		});
		expect(buildModelListRequest(catalogConnection('ollama'))?.headers).toEqual({});
		expect(buildModelListRequest(catalogConnection('perplexity'), 'p-1')).toBeUndefined();
	});
});

describe('parseModelList', () => {
	test('reads data[].id, models[].name without models/, and models[].id', () => {
		expect(parseModelList({ data: [{ id: 'gpt-5.6' }, { id: 'gpt-5.6-mini' }, { object: 'model' }] })).toEqual(['gpt-5.6', 'gpt-5.6-mini']);
		expect(parseModelList({ models: [{ name: 'models/gemini-2.5-flash' }, { name: 'llama4:latest' }] })).toEqual(['gemini-2.5-flash', 'llama4:latest']);
		expect(parseModelList({ models: [{ id: 'sonar-pro' }] })).toEqual(['sonar-pro']);
		expect(parseModelList(null)).toEqual([]);
		expect(parseModelList({ data: 'nope' })).toEqual([]);
	});

	test('matches untagged Ollama models to :latest', () => {
		expect(isModelListed('llama4', ['llama4:latest'])).toBe(true);
		expect(isModelListed('llama4:8b', ['llama4:latest'])).toBe(false);
		expect(isModelListed('gpt-5.6', ['gpt-5.6'])).toBe(true);
		expect(isModelListed('', [''])).toBe(false);
	});
});

describe('fetchModelList', () => {
	test('GETs the listing and classifies a rejected key', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 }))
			.mockResolvedValueOnce(new Response('{"error":"bad key"}', { status: 401 }));
		const request = { url: 'https://api.openai.com/v1/models', headers: { Authorization: 'Bearer sk' } };

		await expect(fetchModelList(request, { kind: 'openai-compatible', fetchImpl })).resolves.toEqual(['m']);
		expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer sk' } });
		await expect(fetchModelList(request, { kind: 'openai-compatible', connectionId: 'c', fetchImpl }))
			.rejects.toMatchObject({ code: 'auth', status: 401, connectionId: 'c' });
	});

	test('times out and cancels', async () => {
		const hang = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
		}));
		const request = { url: 'https://api.openai.com/v1/models', headers: {} };
		await expect(fetchModelList(request, { kind: 'openai-compatible', fetchImpl: hang as unknown as typeof fetch, timeoutMs: 5 }))
			.rejects.toMatchObject({ code: 'timeout' });

		const controller = new AbortController();
		const pending = fetchModelList(request, { kind: 'openai-compatible', fetchImpl: hang as unknown as typeof fetch, signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
	});
});
