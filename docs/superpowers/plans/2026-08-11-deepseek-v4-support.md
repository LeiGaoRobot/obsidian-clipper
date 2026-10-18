# DeepSeek V4 API Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DeepSeek V4 Flash and V4 Pro directly selectable in Interpreter while preserving saved legacy models and the existing OpenAI-compatible request path.

**Architecture:** Add one DOM-free provider-preset normalizer as the boundary between remote/cached catalog JSON and the settings UI. Both catalog sources pass through that normalizer, while the root catalog is updated to the same V4 contract; the LLM production client remains unchanged and receives characterization coverage for DeepSeek V4.

**Tech Stack:** TypeScript, Vitest 4, jsdom, WebExtension storage, Webpack 5, Markdown documentation.

## Global Constraints

- Recommend exactly `deepseek-v4-flash` and `deepseek-v4-pro`; mark Flash as recommended.
- Do not migrate, delete, rename, or silently fall back from any saved `ModelConfig`, including `deepseek-chat` and `deepseek-reasoner`.
- Keep `https://api.deepseek.com/v1/chat/completions`, Bearer authentication, and `choices[0].message.content` parsing on the existing generic request path.
- Do not add `thinking`, `reasoning_effort`, `response_format`, Responses API, Anthropic API, `/models` discovery, or a DeepSeek CLI mode.
- Normalize DeepSeek only when the loaded catalog already contains a `deepseek` preset; do not synthesize one from an empty catalog.
- Preserve every non-DeepSeek provider field and do not add user-facing strings or localization keys.
- Preserve all unrelated working-tree changes. The baseline is already dirty in Interpreter settings and documentation; edit only the task hunks described below.
- Do not create a branch, stage files, or commit without separate user authorization. The checkpoint steps below replace the plan template's commit steps with scoped diff review.

## File Structure

- Create `src/utils/provider-presets.ts`: provider-preset types, the canonical DeepSeek V4 recommendation constant, and the pure catalog-normalization function.
- Create `src/utils/provider-presets.test.ts`: pure normalization and non-mutation coverage.
- Create `src/managers/interpreter-provider-presets.test.ts`: real remote-fetch and cached-storage coverage through `getPresetProviders()`.
- Modify `src/managers/interpreter-settings.ts`: consume the shared types and route both remote and cached catalog data through the normalizer.
- Modify `providers.json`: publish the V4 model recommendations and distinct catalog version token.
- Modify `src/utils/llm-client.test.ts`: characterize both V4 model IDs on the existing OpenAI-compatible request path.
- Modify `docs/Interpret web pages.md`: document current V4 IDs and the no-migration behavior in the existing DeepSeek provider section.
- Modify `docs/superpowers/specs/2026-08-07-deepseek-v4-support-design.md`: only if implementation uncovers a contradiction; otherwise leave the approved spec unchanged.

---

### Task 1: Normalize Remote and Cached DeepSeek Presets

**Files:**
- Create: `src/utils/provider-presets.ts`
- Create: `src/utils/provider-presets.test.ts`
- Create: `src/managers/interpreter-provider-presets.test.ts`
- Modify: `src/managers/interpreter-settings.ts:11-31,36-91`

**Interfaces:**
- Consumes: raw `ProviderPresets` JSON from the existing remote fetch or `provider_presets` extension-storage cache.
- Produces: `DEEPSEEK_V4_MODELS: PopularModel[]` and `normalizeProviderPresets(data: ProviderPresets): Record<string, PresetProvider>`.
- Produces for the settings manager: shared `PresetProvider` and `ProviderPresets` interfaces with the same fields currently declared locally.

- [x] **Step 1: Write the failing pure-normalization test**

Create `src/utils/provider-presets.test.ts`:

```ts
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
```

- [x] **Step 2: Run the pure test and verify RED**

Run:

```bash
npx vitest run src/utils/provider-presets.test.ts
```

Expected: FAIL because `src/utils/provider-presets.ts` does not exist.

- [x] **Step 3: Implement the pure normalizer**

Create `src/utils/provider-presets.ts`:

```ts
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
```

- [x] **Step 4: Run the pure test and verify GREEN**

Run:

```bash
npx vitest run src/utils/provider-presets.test.ts
```

Expected: PASS with 2 tests. If the equality assertion observes cloned model objects, keep the assertion structural; do not expose mutable shared objects from the normalizer.

- [x] **Step 5: Write failing integration tests for remote and cached catalogs**

Create `src/managers/interpreter-provider-presets.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const storageMocks = vi.hoisted(() => ({
	getLocalStorage: vi.fn(),
	setLocalStorage: vi.fn(async () => undefined)
}));

vi.mock('../utils/browser-polyfill', () => ({
	default: {
		i18n: { getMessage: vi.fn(() => '') },
		runtime: {
			id: 'test-extension',
			getPlatformInfo: vi.fn(async () => ({ os: 'mac' })),
			getURL: vi.fn((path: string) => path)
		},
		storage: {
			local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
			sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) }
		}
	}
}));

vi.mock('../utils/storage-utils', () => ({
	generalSettings: { models: [], providers: [] },
	loadSettings: vi.fn(async () => undefined),
	saveSettings: vi.fn(async () => undefined),
	getLocalStorage: storageMocks.getLocalStorage,
	setLocalStorage: storageMocks.setLocalStorage
}));

const legacyDeepSeek = {
	id: 'deepseek',
	name: 'DeepSeek',
	baseUrl: 'https://api.deepseek.com/v1/chat/completions',
	apiKeyRequired: true,
	popularModels: [
		{ id: 'deepseek-chat', name: 'DeepSeek Chat' },
		{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }
	]
};

function catalogResponse(version: string): Response {
	return new Response(JSON.stringify({ version, deepseek: legacyDeepSeek }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}

describe('Interpreter provider preset loading', () => {
	beforeEach(() => {
		vi.resetModules();
		storageMocks.getLocalStorage.mockReset();
		storageMocks.setLocalStorage.mockClear();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('normalizes a freshly fetched DeepSeek preset', async () => {
		storageMocks.getLocalStorage.mockResolvedValue(undefined);
		vi.stubGlobal('fetch', vi.fn(async () => catalogResponse('remote-v4')));
		const { getPresetProviders } = await import('./interpreter-settings');

		const providers = await getPresetProviders();

		expect(providers.deepseek.popularModels).toEqual([
			{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', recommended: true },
			{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }
		]);
		expect(storageMocks.setLocalStorage).toHaveBeenCalled();
	});

	test('normalizes the matching cached DeepSeek preset', async () => {
		storageMocks.getLocalStorage.mockResolvedValue({
			version: 'cached-v4',
			deepseek: legacyDeepSeek
		});
		vi.stubGlobal('fetch', vi.fn(async () => catalogResponse('cached-v4')));
		const { getPresetProviders } = await import('./interpreter-settings');

		const providers = await getPresetProviders();

		expect(providers.deepseek.popularModels?.map(model => model.id)).toEqual([
			'deepseek-v4-flash',
			'deepseek-v4-pro'
		]);
		expect(storageMocks.setLocalStorage).not.toHaveBeenCalled();
	});
});
```

- [x] **Step 6: Run the integration tests and verify RED**

Run:

```bash
npx vitest run src/managers/interpreter-provider-presets.test.ts
```

Expected: FAIL because the current `getPresetProviders()` returns the legacy recommendations unchanged.

- [x] **Step 7: Route both manager catalog sources through the normalizer**

In `src/managers/interpreter-settings.ts`, import the shared seam:

```ts
import {
	normalizeProviderPresets,
	type PresetProvider,
	type ProviderPresets
} from '../utils/provider-presets';
```

Remove the local `PresetProvider` and `ProviderPresets` declarations. In `fetchPresetProviders()`, replace the manual loop with:

```ts
const providers = normalizeProviderPresets(data);
```

In `getLocalPresets()`, replace the duplicate manual loop with:

```ts
return normalizeProviderPresets(data);
```

Keep the current fetch URL, cache version comparison, retry timing, logs, and existing unrelated Native CLI changes exactly as they are.

- [x] **Step 8: Run focused provider tests and verify GREEN**

Run:

```bash
npx vitest run \
  src/utils/provider-presets.test.ts \
  src/managers/interpreter-provider-presets.test.ts \
  src/managers/interpreter-settings.test.ts
```

Expected: PASS for the new normalization coverage and the pre-existing settings UI coverage.

- [x] **Step 9: Review the scoped Task 1 diff**

Run:

```bash
git diff -- \
  src/utils/provider-presets.ts \
  src/utils/provider-presets.test.ts \
  src/managers/interpreter-provider-presets.test.ts \
  src/managers/interpreter-settings.ts
```

Expected: only the new pure seam, its tests, and the two existing catalog-conversion loops change. Do not stage or commit.

---

### Task 2: Synchronize the Published Catalog and User Documentation

**Files:**
- Modify: `providers.json:1,30-41`
- Modify: `src/utils/provider-presets.test.ts`
- Modify: `docs/Interpret web pages.md:86-106`

**Interfaces:**
- Consumes: `DEEPSEEK_V4_MODELS` from Task 1.
- Produces: root catalog version `2026.08.07` and DeepSeek recommendations structurally equal to `DEEPSEEK_V4_MODELS`.
- Produces: user documentation naming the current V4 IDs and explaining that saved legacy IDs are not migrated.

- [x] **Step 1: Add failing root-catalog and documentation contract tests**

Append imports and a test to `src/utils/provider-presets.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
```

- [x] **Step 2: Run the contract test and verify RED**

Run:

```bash
npx vitest run src/utils/provider-presets.test.ts
```

Expected: FAIL because the root catalog still has version `2026.12.08`, lists `deepseek-chat` and `deepseek-reasoner`, and the guide does not yet explain V4 migration behavior.

- [x] **Step 3: Update the root provider catalog**

In `providers.json`, set:

```json
"version": "2026.08.07"
```

Replace only the DeepSeek `popularModels` array with:

```json
"popularModels": [
	{ "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "recommended": true },
	{ "id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro" }
]
```

Keep the existing DeepSeek API-key URL, model-list URL, and base URL unchanged.

- [x] **Step 4: Update the Interpreter guide**

Immediately after the preset-provider table in `docs/Interpret web pages.md`, add:

```markdown
The DeepSeek preset recommends `deepseek-v4-flash` and `deepseek-v4-pro`. Existing models saved with the legacy `deepseek-chat` or `deepseek-reasoner` IDs remain editable as custom models; Web Clipper does not automatically migrate them. Update the model ID manually if the provider no longer accepts a legacy ID.
```

Do not alter the existing Native CLI documentation edits earlier in the same dirty file.

- [x] **Step 5: Run the contract test and verify GREEN**

Run:

```bash
npx vitest run src/utils/provider-presets.test.ts
```

Expected: PASS for 3 tests.

- [x] **Step 6: Review the scoped Task 2 diff**

Run:

```bash
git diff -- providers.json src/utils/provider-presets.test.ts 'docs/Interpret web pages.md'
```

Expected: `providers.json` changes only its version and DeepSeek models; the guide gains one DeepSeek paragraph while preserving unrelated dirty hunks. Do not stage or commit.

---

### Task 3: Characterize the Existing DeepSeek V4 Request Contract

**Files:**
- Modify: `src/utils/llm-client.test.ts`
- Production files: none

**Interfaces:**
- Consumes: `sendToLLM(promptContext, content, promptVariables, model, options)` and a stored provider using the DeepSeek Chat Completions URL.
- Produces: regression evidence for URL, Bearer authentication, both V4 model IDs, message body, and `choices[0].message.content` parsing.

- [x] **Step 1: Make the mocked provider mutable without changing existing assertions**

Extend the hoisted mocks in `src/utils/llm-client.test.ts`:

```ts
const mocks = vi.hoisted(() => ({
	getExtensionBranding: vi.fn(),
	providers: [{
		id: 'provider-1',
		name: 'OpenAI-compatible',
		baseUrl: 'https://model.example/v1/chat/completions',
		apiKey: 'test-key',
		apiKeyRequired: true
	}]
}));
```

Change the storage mock to:

```ts
vi.mock('./storage-utils', () => ({
	generalSettings: { providers: mocks.providers }
}));
```

At the start of `beforeEach`, restore the default provider with `Object.assign`:

```ts
Object.assign(mocks.providers[0], {
	id: 'provider-1',
	name: 'OpenAI-compatible',
	baseUrl: 'https://model.example/v1/chat/completions',
	apiKey: 'test-key',
	apiKeyRequired: true
});
```

- [x] **Step 2: Add the two-model characterization test**

Add inside the existing `describe` block:

```ts
test.each(['deepseek-v4-flash', 'deepseek-v4-pro'])(
	'uses the existing Chat Completions contract for %s',
	async providerModelId => {
		Object.assign(mocks.providers[0], {
			name: 'DeepSeek',
			baseUrl: 'https://api.deepseek.com/v1/chat/completions',
			apiKey: 'deepseek-test-key'
		});
		fetchMock.mockResolvedValue(new Response(JSON.stringify({
			choices: [{
				message: {
					content: JSON.stringify({
						prompts_responses: { prompt_1: 'deepseek-ok' }
					})
				}
			}]
		}), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const result = await sendToLLM(
			'smoke context',
			'',
			[{ key: 'prompt_1', prompt: 'Return smoke.' }],
			{
				id: `model-${providerModelId}`,
				providerId: 'provider-1',
				providerModelId,
				name: providerModelId,
				enabled: true
			},
			{ maxTokens: 3200, cooldownMs: 0 }
		);

		expect(fetchMock).toHaveBeenCalledWith(
			'https://api.deepseek.com/v1/chat/completions',
			expect.objectContaining({ method: 'POST' })
		);
		const request = fetchMock.mock.calls[0][1] as RequestInit;
		expect(request.headers).toMatchObject({
			'Authorization': 'Bearer deepseek-test-key'
		});
		expect(JSON.parse(request.body as string)).toMatchObject({
			model: providerModelId,
			max_tokens: 3200,
			messages: expect.arrayContaining([
				expect.objectContaining({ role: 'system' }),
				expect.objectContaining({ role: 'user', content: 'smoke context' })
			])
		});
		expect(result.promptResponses[0].user_response).toBe('deepseek-ok');
	}
);
```

- [x] **Step 3: Run the characterization test**

Run:

```bash
npx vitest run src/utils/llm-client.test.ts
```

Expected: PASS without any production `llm-client.ts` change. This is intentional characterization of the already-compatible transport seam, not a RED step.

- [x] **Step 4: Confirm production request code is untouched**

Run:

```bash
git diff -- src/utils/llm-client.ts src/utils/llm-client.test.ts
```

Expected: only `src/utils/llm-client.test.ts` changes. Do not add a DeepSeek-specific branch and do not stage or commit.

---

### Task 4: Full Verification and Scope Audit

**Files:**
- Verify all Task 1-3 files.
- Do not modify generated `dist/`, `dist_firefox/`, `dist_safari/`, or `builds/` outputs.

**Interfaces:**
- Consumes: completed DeepSeek preset normalizer, synchronized catalog/docs, and API characterization tests.
- Produces: fresh test, type-check, browser-build, whitespace, and scoped-diff evidence.

- [x] **Step 1: Run all focused DeepSeek and adjacent tests**

Run:

```bash
npx vitest run \
  src/utils/provider-presets.test.ts \
  src/managers/interpreter-provider-presets.test.ts \
  src/managers/interpreter-settings.test.ts \
  src/utils/llm-client.test.ts
```

Expected: PASS with no failures or unhandled errors.

- [x] **Step 2: Run the timezone-pinned full suite**

Run:

```bash
TZ=America/Los_Angeles npm test
```

Expected: exit 0 with all Vitest files and tests passing.

- [x] **Step 3: Run the explicit TypeScript check**

Run:

```bash
npx tsc --noEmit --module es2020
```

Expected: exit 0 with no diagnostics.

- [x] **Step 4: Build all affected browser targets**

Run:

```bash
npm run build
```

Expected: Chrome, Firefox, and Safari production Webpack builds all exit 0. Do not add or commit generated outputs.

- [x] **Step 5: Check whitespace and exact task scope**

Run:

```bash
git diff --check
git status --short
git diff -- \
  providers.json \
  'docs/Interpret web pages.md' \
  docs/superpowers/specs/2026-08-07-deepseek-v4-support-design.md \
  docs/superpowers/plans/2026-08-11-deepseek-v4-support.md \
  src/utils/provider-presets.ts \
  src/utils/provider-presets.test.ts \
  src/managers/interpreter-provider-presets.test.ts \
  src/managers/interpreter-settings.ts \
  src/utils/llm-client.test.ts
```

Expected: `git diff --check` exits 0. The scoped diff contains only approved DeepSeek work plus the pre-existing unrelated hunks already present in `src/managers/interpreter-settings.ts` and `docs/Interpret web pages.md`; all other dirty files remain untouched.

- [x] **Step 6: Report evidence and remaining live-validation boundary**

Report focused/full test counts, type-check result, all three browser-build results, and `git diff --check`. State explicitly that no real DeepSeek request ran because no user API key was requested or used; API compatibility is verified by the official contract and mocked request/response tests only. Do not claim live provider validation.
