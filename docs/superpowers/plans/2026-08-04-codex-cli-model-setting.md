# Codex CLI Model Setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, editable Codex model setting that applies to every Codex CLI-backed Interpreter and language-learning request while preserving the Codex CLI default when left blank.

**Architecture:** Persist one normalized optional setting in the existing Interpreter settings object. Carry it as a request-scoped `model` override through the existing Native Messaging boundary, bump that protocol to v3 so an older Host cannot silently ignore the new field, and pass it to `codex exec` as the separate arguments `--model <id>`. Grok and API paths remain unchanged.

**Tech Stack:** TypeScript 5.5, Vitest 4, jsdom, Chrome Native Messaging, Node.js ESM Native Host, Webpack, HTML, JSON localization, Markdown documentation.

## Global Constraints

- Preserve all pre-existing user changes. This worktree already contains unrelated and overlapping edits in settings, Native Host, localization, and documentation files.
- Before editing an existing file, inspect `git diff -- <path>` and keep every task-owned hunk surgical.
- Never stage an entire overlapping file blindly. Use `git add -p -- <path>` for task-owned hunks; if they cannot be isolated safely, defer the commit and report that explicitly.
- Keep the existing Native Host PATH fix and `runtime.lastError` cleanup intact.
- Never send a remote or paid request from settings initialization, page load, transcript load, selection change, or the connection health check.
- Do not add reasoning-effort controls, Codex profiles, account/model discovery, or automatic model fallback.
- Treat 200 JavaScript string code units as the limit in both the extension and Native Host.
- The extension must never carry a model field on Grok requests; the Host must reject one if a malformed client supplies it.

---

## Task 1: Define and Persist the Optional Setting

**Files:**

- Create: `src/utils/codex-model.test.ts`
- Create: `src/utils/codex-model.ts`
- Modify: `src/types/types.ts`
- Modify: `src/utils/storage-utils.test.ts`
- Modify: `src/utils/storage-utils.ts`

- [ ] **Step 1: Write the normalization tests first**

Create `src/utils/codex-model.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { MAX_CODEX_MODEL_CHARS, normalizeCodexModel } from './codex-model';

describe('Codex model setting', () => {
	test('trims a configured model ID', () => {
		expect(normalizeCodexModel('  gpt-5.6-sol  ')).toBe('gpt-5.6-sol');
	});

	test('treats blank, non-string, and oversized values as absent', () => {
		expect(normalizeCodexModel('   ')).toBeUndefined();
		expect(normalizeCodexModel(null)).toBeUndefined();
		expect(normalizeCodexModel('x'.repeat(MAX_CODEX_MODEL_CHARS + 1))).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the new test and verify the expected failure**

Run:

```sh
npx vitest run src/utils/codex-model.test.ts
```

Expected: FAIL because `src/utils/codex-model.ts` does not exist.

- [ ] **Step 3: Implement the smallest shared normalization seam**

Create `src/utils/codex-model.ts`:

```ts
export const MAX_CODEX_MODEL_CHARS = 200;

export function normalizeCodexModel(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const model = value.trim();
	return model.length > 0 && model.length <= MAX_CODEX_MODEL_CHARS
		? model
		: undefined;
}
```

Add the optional field to `Settings` in `src/types/types.ts`, immediately after `interpreterExecutionMode`:

```ts
	interpreterExecutionMode?: InterpreterExecutionMode;
	interpreterCodexModel?: string;
```

- [ ] **Step 4: Add storage round-trip tests**

Extend `src/utils/storage-utils.test.ts` with tests that use the existing mocked sync storage:

```ts
	test('loads a trimmed Codex model and saves it in Interpreter settings', async () => {
		mocks.state.interpreter_settings = {
			interpreterExecutionMode: 'codex',
			interpreterCodexModel: '  gpt-5.6-terra  '
		};

		const settings = await loadSettings();
		expect(settings.interpreterCodexModel).toBe('gpt-5.6-terra');

		await saveSettings(settings);
		expect(mocks.set).toHaveBeenLastCalledWith(expect.objectContaining({
			interpreter_settings: expect.objectContaining({
				interpreterCodexModel: 'gpt-5.6-terra'
			})
		}));
	});

	test('omits a blank or oversized Codex model from saved settings', async () => {
		await loadSettings();
		await saveSettings({ interpreterCodexModel: '   ' });

		const savedBlank = mocks.set.mock.calls.at(-1)?.[0].interpreter_settings;
		expect(savedBlank).not.toHaveProperty('interpreterCodexModel');

		await saveSettings({ interpreterCodexModel: 'x'.repeat(201) });
		const savedOversized = mocks.set.mock.calls.at(-1)?.[0].interpreter_settings;
		expect(savedOversized).not.toHaveProperty('interpreterCodexModel');
	});
```

- [ ] **Step 5: Make storage normalize on both load and save**

In `src/utils/storage-utils.ts`:

1. Import `normalizeCodexModel`.
2. Add `interpreterCodexModel?: string` to `StorageData.interpreter_settings`.
3. Load the value with:

```ts
		interpreterCodexModel: normalizeCodexModel(data.interpreter_settings?.interpreterCodexModel),
```

4. At the beginning of `saveSettings`, after merging partial settings, normalize the in-memory value:

```ts
	generalSettings.interpreterCodexModel = normalizeCodexModel(generalSettings.interpreterCodexModel);
```

5. Serialize it only when present:

```ts
		interpreter_settings: {
			interpreterModel: generalSettings.interpreterModel,
			models: generalSettings.models,
			providers: generalSettings.providers,
			interpreterEnabled: generalSettings.interpreterEnabled,
			interpreterAutoRun: generalSettings.interpreterAutoRun,
			interpreterExecutionMode: generalSettings.interpreterExecutionMode ?? 'api',
			...(generalSettings.interpreterCodexModel
				? { interpreterCodexModel: generalSettings.interpreterCodexModel }
				: {}),
			defaultPromptContext: generalSettings.defaultPromptContext
		},
```

Do not add a migration value: absence intentionally means “use the Codex CLI default.”

- [ ] **Step 6: Run focused tests**

Run:

```sh
npx vitest run src/utils/codex-model.test.ts src/utils/storage-utils.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit only isolated task-owned hunks**

```sh
git add src/utils/codex-model.ts src/utils/codex-model.test.ts src/types/types.ts src/utils/storage-utils.ts src/utils/storage-utils.test.ts
git commit -m "feat: persist Codex CLI model setting"
```

If `src/types/types.ts` or `src/utils/storage-utils.ts` has overlapping pre-existing edits at execution time, use `git add -p` or defer this commit.

---

## Task 2: Add the Settings UI and Localized Visibility Behavior

**Files:**

- Create: `src/managers/interpreter-settings.test.ts`
- Modify: `src/managers/interpreter-settings.ts`
- Modify: `src/settings.html`
- Modify: `src/_locales/en/messages.json`
- Modify: `src/_locales/zh_CN/messages.json`

- [ ] **Step 1: Write a jsdom visibility test against the real settings markup**

Create `src/managers/interpreter-settings.test.ts` with `// @vitest-environment jsdom`. Mock `../utils/browser-polyfill` and `../utils/storage-utils` before importing the manager so module imports remain browser-independent, then load `src/settings.html` and test the exported visibility helper:

```ts
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';

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
	getLocalStorage: vi.fn(async () => undefined),
	setLocalStorage: vi.fn(async () => undefined)
}));

import { updateCodexModelVisibility } from './interpreter-settings';

describe('Interpreter Codex model setting', () => {
	test('shows the editable model input only in Codex mode', () => {
		const settingsDocument = new DOMParser().parseFromString(
			readFileSync(
				new URL('../settings.html', import.meta.url),
				'utf8'
			),
			'text/html'
		);
		const mode = settingsDocument.getElementById('interpreter-execution-mode') as HTMLSelectElement;
		const item = settingsDocument.getElementById('interpreter-codex-model-item') as HTMLElement;
		const input = settingsDocument.getElementById('interpreter-codex-model') as HTMLInputElement;

		mode.value = 'api';
		updateCodexModelVisibility(settingsDocument);
		expect(item.hidden).toBe(true);

		mode.value = 'codex';
		updateCodexModelVisibility(settingsDocument);
		expect(item.hidden).toBe(false);
		expect(input.maxLength).toBe(200);
		expect(input.getAttribute('list')).toBe('interpreter-codex-model-options');
		expect(Array.from(settingsDocument.querySelectorAll('#interpreter-codex-model-options option'))
			.map(option => option.getAttribute('value'))).toEqual([
				'gpt-5.6-sol',
				'gpt-5.6-terra',
				'gpt-5.6-luna'
			]);
	});
});
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run:

```sh
npx vitest run src/managers/interpreter-settings.test.ts
```

Expected: FAIL because the markup and `updateCodexModelVisibility` do not exist.

- [ ] **Step 3: Add the localized editable input and datalist**

In `src/settings.html`, insert this item immediately after the execution-mode item and before the Native CLI connection item:

```html
<div class="setting-item mod-horizontal" id="interpreter-codex-model-item" hidden>
	<div class="setting-item-info">
		<label for="interpreter-codex-model" data-i18n="interpreterCodexModel">Codex model</label>
		<div class="setting-item-description" data-i18n="interpreterCodexModelDescription">Override the model for every Codex CLI action. Leave empty to use the Codex CLI default.</div>
	</div>
	<div class="setting-item-control">
		<input type="text" id="interpreter-codex-model" list="interpreter-codex-model-options" maxlength="200" autocomplete="off" data-i18n="interpreterCodexModelPlaceholder" />
		<datalist id="interpreter-codex-model-options">
			<option value="gpt-5.6-sol"></option>
			<option value="gpt-5.6-terra"></option>
			<option value="gpt-5.6-luna"></option>
		</datalist>
	</div>
</div>
```

Add these keys in alphabetical position to both locale files.

English:

```json
"interpreterCodexModel": {
	"message": "Codex model"
},
"interpreterCodexModelDescription": {
	"message": "Override the model for every Codex CLI action. Leave empty to use the Codex CLI default."
},
"interpreterCodexModelPlaceholder": {
	"message": "Use Codex CLI default"
}
```

Simplified Chinese:

```json
"interpreterCodexModel": {
	"message": "Codex 模型"
},
"interpreterCodexModelDescription": {
	"message": "覆盖所有 Codex CLI 操作使用的模型。留空则使用 Codex CLI 默认模型。"
},
"interpreterCodexModelPlaceholder": {
	"message": "使用 Codex CLI 默认模型"
}
```

- [ ] **Step 4: Initialize, show, and save the value**

In `src/managers/interpreter-settings.ts`, import `normalizeCodexModel`, then add:

```ts
export function updateCodexModelVisibility(doc: Document = document): void {
	const executionModeSelect = doc.getElementById('interpreter-execution-mode') as HTMLSelectElement | null;
	const codexModelItem = doc.getElementById('interpreter-codex-model-item');
	if (!executionModeSelect || !codexModelItem) return;
	codexModelItem.hidden = executionModeSelect.value !== 'codex';
}
```

During `initializeInterpreterSettings`, populate the input after settings load:

```ts
		const codexModelInput = document.getElementById('interpreter-codex-model') as HTMLInputElement | null;
		if (codexModelInput) {
			codexModelInput.value = generalSettings.interpreterCodexModel ?? '';
		}
```

Update the execution-mode change listener to call both visibility refreshers, and call `updateCodexModelVisibility()` once after assigning the initial mode:

```ts
			executionModeSelect.addEventListener('change', () => {
				saveInterpreterSettingsFromForm();
				updateCodexModelVisibility();
				updateNativeCliHealthVisibility();
			});
			updateCodexModelVisibility();
```

In `saveInterpreterSettingsFromForm`, read and normalize the input:

```ts
	const codexModelInput = document.getElementById('interpreter-codex-model') as HTMLInputElement | null;
	if (codexModelInput) {
		updatedSettings.interpreterCodexModel = normalizeCodexModel(codexModelInput.value);
	}
```

The existing debounced form `input` listener saves typing without initiating any model request.

- [ ] **Step 5: Run focused UI and localization checks**

Run:

```sh
npx vitest run src/managers/interpreter-settings.test.ts src/utils/codex-model.test.ts src/utils/storage-utils.test.ts
npm run check-strings
```

Expected: all PASS, with no unused new locale keys.

- [ ] **Step 6: Commit only task-owned hunks**

```sh
git add -p src/managers/interpreter-settings.ts src/settings.html src/_locales/en/messages.json src/_locales/zh_CN/messages.json
git add src/managers/interpreter-settings.test.ts
git commit -m "feat: add Codex CLI model setting UI"
```

---

## Task 3: Version and Validate the Native Messaging Contract

**Files:**

- Modify: `src/utils/native-cli-contract.test.ts`
- Modify: `src/utils/native-cli-contract.ts`
- Modify: `native-host/obsidian-clipper-host.test.ts`
- Modify: `native-host/obsidian-clipper-host.mjs`

- [ ] **Step 1: Write extension-contract tests for the optional model**

Update `src/utils/native-cli-contract.test.ts` to use an options object for request construction and add these cases:

```ts
	test('adds a trimmed model only to Codex requests', () => {
		const prompts = [{ key: 'prompt_1', prompt: 'Summarize this', filters: '' }];
		expect(buildNativeCliRequest('codex', 'Page content', prompts, {
			requestId: 'request-model',
			model: '  gpt-5.6-sol  '
		})).toMatchObject({
			protocolVersion: 3,
			requestId: 'request-model',
			mode: 'codex',
			model: 'gpt-5.6-sol'
		});
	});

	test('rejects invalid model overrides', () => {
		expect(() => buildNativeCliRequest('codex', 'Context', [], { model: '   ' }))
			.toThrow('Codex model must be a non-empty string of at most 200 characters.');
		expect(() => buildNativeCliRequest('codex', 'Context', [], { model: 'x'.repeat(201) }))
			.toThrow('Codex model must be a non-empty string of at most 200 characters.');
		expect(() => buildNativeCliRequest('grok', 'Context', [], { model: 'gpt-5.6-sol' }))
			.toThrow('Codex model overrides require Codex execution mode.');
	});
```

Also extend `isNativeCliRequest` assertions so a canonical Codex model is accepted while a Grok model, whitespace-padded model, blank model, and 201-character model are rejected.

- [ ] **Step 2: Run the contract test and verify it fails**

```sh
npx vitest run src/utils/native-cli-contract.test.ts
```

Expected: FAIL because the protocol is still v2 and requests have no model field.

- [ ] **Step 3: Implement protocol v3 and canonical request construction**

In `src/utils/native-cli-contract.ts`:

```ts
import { MAX_CODEX_MODEL_CHARS, normalizeCodexModel } from './codex-model';

export const NATIVE_CLI_PROTOCOL_VERSION = 3;

export interface NativeCliRequest {
	type: 'executeCli';
	protocolVersion: number;
	requestId: string;
	mode: CliExecutionMode;
	prompt: string;
	model?: string;
}

export interface NativeCliRequestOptions {
	requestId?: string;
	model?: string;
}
```

Validate the optional field inside `isNativeCliRequest`:

```ts
	const validModel = request.model === undefined || (
		request.mode === 'codex'
		&& typeof request.model === 'string'
		&& request.model === request.model.trim()
		&& request.model.length > 0
		&& request.model.length <= MAX_CODEX_MODEL_CHARS
	);
```

Require `validModel` in the return expression. Replace the fourth positional `requestId` argument with `options: NativeCliRequestOptions = {}` and build the request as follows:

```ts
	const model = normalizeCodexModel(options.model);
	if (options.model !== undefined && !model) {
		throw new TypeError('Codex model must be a non-empty string of at most 200 characters.');
	}
	if (model && mode !== 'codex') {
		throw new TypeError('Codex model overrides require Codex execution mode.');
	}
	return {
		type: 'executeCli',
		protocolVersion: NATIVE_CLI_PROTOCOL_VERSION,
		requestId: options.requestId ?? createNativeCliRequestId(),
		mode,
		prompt: buildExecutionPrompt(context, promptVariables),
		...(model ? { model } : {})
	};
```

Update existing test and service call sites that supply a fixed request ID from `'request-1'` to `{ requestId: 'request-1' }`.

- [ ] **Step 4: Write Native Host validation and invocation tests**

Extend `native-host/obsidian-clipper-host.test.ts`:

```ts
	test('passes the selected model to Codex as one argument', () => {
		const invocation = createCliInvocation(
			{ mode: 'codex', prompt: 'prompt', model: 'gpt-5.6-sol' },
			{ grokPath: '/usr/local/bin/grok', codexPath: '/usr/local/bin/codex' }
		);

		expect(invocation.args).toEqual([
			'exec',
			'--model',
			'gpt-5.6-sol',
			'--ephemeral',
			'--color',
			'never',
			'--sandbox',
			'read-only',
			'--skip-git-repo-check',
			'-'
		]);
		expect(invocation.input).toBe('prompt');
	});

	test('keeps the previous Codex arguments when no model is selected', () => {
		expect(createCliInvocation(
			{ mode: 'codex', prompt: 'prompt' },
			{ grokPath: '/usr/local/bin/grok', codexPath: '/usr/local/bin/codex' }
		).args).toEqual([
			'exec',
			'--ephemeral',
			'--color',
			'never',
			'--sandbox',
			'read-only',
			'--skip-git-repo-check',
			'-'
		]);
	});
```

Add table-driven `validateRequest` cases for: valid canonical Codex model, Grok request with a model, blank model, padded model, and 201-character model.

- [ ] **Step 5: Implement the same boundary checks in the Native Host**

In `native-host/obsidian-clipper-host.mjs`:

```js
export const NATIVE_CLI_PROTOCOL_VERSION = 3;
export const MAX_CODEX_MODEL_CHARS = 200;
```

After mode and prompt validation, add:

```js
	if (request.model !== undefined) {
		if (request.mode !== 'codex') return 'Codex model overrides require Codex execution mode.';
		if (typeof request.model !== 'string'
			|| request.model.length === 0
			|| request.model.length > MAX_CODEX_MODEL_CHARS) {
			return 'Codex model must be a non-empty string of at most 200 characters.';
		}
		if (request.model !== request.model.trim()) {
			return 'Codex model must not include leading or trailing whitespace.';
		}
	}
```

Build Codex arguments without shell interpolation:

```js
		args: [
			'exec',
			...(request.model ? ['--model', request.model] : []),
			'--ephemeral',
			'--color',
			'never',
			'--sandbox',
			'read-only',
			'--skip-git-repo-check',
			'-'
		],
```

Do not alter Grok arguments, PATH construction, cancellation, timeout, or response-size behavior.

- [ ] **Step 6: Run both protocol suites**

```sh
npx vitest run src/utils/native-cli-contract.test.ts native-host/obsidian-clipper-host.test.ts src/utils/native-cli-service.test.ts
```

Expected: PASS. Existing requests without a model remain byte-shape compatible apart from protocol version 3.

- [ ] **Step 7: Commit only isolated protocol hunks**

```sh
git add -p src/utils/native-cli-contract.ts src/utils/native-cli-contract.test.ts native-host/obsidian-clipper-host.mjs native-host/obsidian-clipper-host.test.ts src/utils/native-cli-service.test.ts
git commit -m "feat: carry Codex model over native messaging"
```

---

## Task 4: Thread the Model Through Every Codex CLI Caller

**Files:**

- Create: `src/utils/native-cli-client.test.ts`
- Create: `src/utils/language-learning-service.test.ts`
- Create: `src/utils/interpreter.test.ts`
- Modify: `src/utils/native-cli-client.ts`
- Modify: `src/utils/native-cli-service.ts`
- Modify: `src/utils/language-learning-service.ts`
- Modify: `src/utils/interpreter.ts`

- [ ] **Step 1: Add a client test that inspects the background message**

Create `src/utils/native-cli-client.test.ts` with a mocked `browser.runtime.sendMessage`:

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sendMessage: vi.fn() }));

vi.mock('./browser-polyfill', () => ({
	default: { runtime: { sendMessage: mocks.sendMessage } }
}));
vi.mock('./i18n', () => ({ getMessage: (key: string) => key }));

import { executeNativeCli } from './native-cli-client';

describe('Native CLI client', () => {
	beforeEach(() => {
		mocks.sendMessage.mockReset();
		mocks.sendMessage.mockResolvedValue({
			success: true,
			stdout: '{"prompt_1":"done"}'
		});
	});

	test('sends a request-scoped Codex model to the background', async () => {
		await executeNativeCli(
			'codex',
			'Context',
			[{ key: 'prompt_1', prompt: 'Summarize', filters: '' }],
			{ model: 'gpt-5.6-sol' }
		);

		expect(mocks.sendMessage).toHaveBeenCalledWith({
			action: 'nativeCliRequest',
			request: expect.objectContaining({
				mode: 'codex',
				model: 'gpt-5.6-sol'
			})
		});
	});
});
```

- [ ] **Step 2: Add service tests for Codex forwarding and Grok isolation**

Create `src/utils/language-learning-service.test.ts`. Mock `loadSettings`, `executeNativeCliForPrompts`, and `sendToLLM`; call `runLanguageLearningRequest` with one prompt. Assert:

```ts
	expect(mocks.executeNativeCliForPrompts).toHaveBeenCalledWith(
		'codex',
		'Context',
		[{ key: 'prompt_1', prompt: 'Translate' }],
		{ model: 'gpt-5.6-terra', signal: controller.signal }
	);
```

Add a second case with `interpreterExecutionMode: 'grok'` and the same stored `interpreterCodexModel`; assert the fourth argument is `{ signal: controller.signal }` with no `model` property.

- [ ] **Step 3: Add a focused Interpreter UI forwarding test**

Create `src/utils/interpreter.test.ts` with `// @vitest-environment jsdom`. Mock `generalSettings` and `executeNativeCli`, create the required Interpreter DOM elements, and call `handleInterpreterUI` with a template containing `{{"Summarize"}}`. The key assertion is:

```ts
	expect(mocks.executeNativeCli).toHaveBeenCalledWith(
		'codex',
		'Page context',
		[{ key: 'prompt_1', prompt: 'Summarize', filters: '' }],
		{ model: 'gpt-5.6-luna' }
	);
```

Use this exact minimal DOM before the call:

```ts
document.body.innerHTML = `
	<div id="interpreter"></div>
	<button id="interpret-btn"></button>
	<div id="interpreter-error"></div>
	<span id="interpreter-timer"></span>
	<button id="clip-btn"></button>
	<button id="more-btn"></button>
	<textarea id="prompt-context">Page context</textarea>
`;
```

Mock `executeNativeCli` to resolve `{ prompt_1: 'Done' }`, and set the mocked settings to:

```ts
{
	interpreterExecutionMode: 'codex',
	interpreterCodexModel: 'gpt-5.6-luna',
	providers: []
}
```

- [ ] **Step 4: Run the new tests and verify they fail before implementation**

```sh
npx vitest run src/utils/native-cli-client.test.ts src/utils/language-learning-service.test.ts src/utils/interpreter.test.ts
```

Expected: FAIL because the clients do not accept or forward execution options.

- [ ] **Step 5: Add unambiguous execution options**

In `src/utils/native-cli-client.ts`:

```ts
export interface NativeCliClientOptions {
	model?: string;
}

export async function executeNativeCli(
	mode: 'grok' | 'codex',
	context: string,
	promptVariables: PromptVariable[],
	options: NativeCliClientOptions = {}
): Promise<Record<string, unknown>> {
	const response = await browser.runtime.sendMessage({
		action: 'nativeCliRequest',
		request: buildNativeCliRequest(mode, context, promptVariables, { model: options.model })
	}) as NativeCliBackgroundResponse;
```

In `src/utils/native-cli-service.ts`:

```ts
export interface NativeCliExecutionOptions {
	model?: string;
	signal?: AbortSignal;
}

export async function executeNativeCliForPrompts(
	mode: 'grok' | 'codex',
	context: string,
	promptVariables: PromptVariable[],
	options: NativeCliExecutionOptions = {}
): Promise<Record<string, unknown>> {
	const response = await sendNativeCliRequest(
		buildNativeCliRequest(mode, context, promptVariables, { model: options.model }),
		options.signal
	);
	return parsePromptResponses(response.stdout || '', promptVariables);
}
```

The options object avoids confusing two optional trailing values (`model` and `AbortSignal`).

- [ ] **Step 6: Forward the setting from both configured callers**

In `src/utils/language-learning-service.ts`:

```ts
		const responses = await executeNativeCliForPrompts(
			executionMode,
			request.context,
			request.prompts,
			{
				...(executionMode === 'codex' && settings.interpreterCodexModel
					? { model: settings.interpreterCodexModel }
					: {}),
				signal
			}
		);
```

In `src/utils/interpreter.ts`:

```ts
			const responses = await executeNativeCli(
				executionMode,
				contextToUse,
				promptVariables,
				executionMode === 'codex' && generalSettings.interpreterCodexModel
					? { model: generalSettings.interpreterCodexModel }
					: {}
			);
```

Do not add the model to `languageLearningRequest` page messages or the DOM. The background service continues to load settings and resolve the override there for language learning.

- [ ] **Step 7: Run all caller and Native CLI focused tests**

```sh
npx vitest run \
  src/utils/native-cli-client.test.ts \
  src/utils/language-learning-service.test.ts \
  src/utils/interpreter.test.ts \
  src/utils/native-cli-contract.test.ts \
  src/utils/native-cli-service.test.ts \
  native-host/obsidian-clipper-host.test.ts
```

Expected: PASS. Verify the Grok test request has no `model` own property.

- [ ] **Step 8: Commit only isolated caller hunks**

```sh
git add src/utils/native-cli-client.ts src/utils/native-cli-client.test.ts src/utils/language-learning-service.ts src/utils/language-learning-service.test.ts src/utils/interpreter.ts src/utils/interpreter.test.ts src/utils/native-cli-service.ts
git commit -m "feat: apply Codex model to Interpreter requests"
```

Use selective staging if `src/utils/native-cli-service.ts` overlaps the existing disconnect cleanup fix.

---

## Task 5: Synchronize User and Developer Documentation

**Files:**

- Modify: `docs/Interpret web pages.md`
- Modify: `docs/Language learning.md`
- Modify: `docs/Introduction to Obsidian Web Clipper.md`
- Modify: `docs/development/Language learning MVP.md`

- [ ] **Step 1: Document the user-visible setting in the Interpreter guide**

Under `Local Grok and Codex CLI modes` in `docs/Interpret web pages.md`, add that selecting Codex CLI reveals an optional editable **Codex model** field. State all four behaviors explicitly:

- it applies to every Codex CLI Interpreter and language-learning action;
- leaving it empty uses the CLI default;
- model availability depends on the user’s Codex authentication/account;
- requests may consume usage or create cost under the user’s Codex setup.

Also state that changing the field does not run a request and the health check does not verify model availability.

- [ ] **Step 2: Update language-learning and discovery docs**

In `docs/Language learning.md`, extend the execution-mode explanation with the same default/override behavior and mention that an unavailable model is shown as a retryable CLI failure without fallback.

In `docs/Introduction to Obsidian Web Clipper.md`, update the Interpreter or language-learning discovery bullet to mention the optional per-request Codex model override.

- [ ] **Step 3: Record the protocol and boundary behavior for maintainers**

In `docs/development/Language learning MVP.md`, document:

- `interpreterCodexModel` is resolved from stored Interpreter settings in the background;
- Native Messaging protocol v3 carries an optional canonical `model` only for Codex;
- both extension and Host enforce the 200-code-unit limit;
- the Host passes `--model` and the ID as separate spawn arguments;
- an older v2 Host must be reinstalled after a protocol mismatch;
- health checks intentionally do not make a model request.

- [ ] **Step 4: Review documentation diffs for existing user edits**

```sh
git diff -- 'docs/Interpret web pages.md' 'docs/Language learning.md' 'docs/Introduction to Obsidian Web Clipper.md' 'docs/development/Language learning MVP.md'
```

Expected: only additive or narrowly edited Codex-model passages; all pre-existing documentation changes remain.

- [ ] **Step 5: Commit only the new documentation hunks**

```sh
git add -p 'docs/Interpret web pages.md' 'docs/Language learning.md' 'docs/Introduction to Obsidian Web Clipper.md' 'docs/development/Language learning MVP.md'
git commit -m "docs: explain Codex CLI model override"
```

---

## Task 6: Full Verification and Real Native Host Smoke Test

**Files:**

- Verify only; do not intentionally modify source files.

- [ ] **Step 1: Run focused feature tests once more**

```sh
npx vitest run \
  src/utils/codex-model.test.ts \
  src/utils/storage-utils.test.ts \
  src/managers/interpreter-settings.test.ts \
  src/utils/native-cli-contract.test.ts \
  src/utils/native-cli-client.test.ts \
  src/utils/native-cli-service.test.ts \
  src/utils/language-learning-service.test.ts \
  src/utils/interpreter.test.ts \
  native-host/obsidian-clipper-host.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository-required automated checks**

```sh
TZ=America/Los_Angeles npm test
npx tsc --noEmit --module es2020
npm run check-strings
npm run build:chrome
npm run package:native-host
git diff --check
```

Expected:

- full Vitest suite passes;
- TypeScript reports no errors;
- localization check reports no unused strings;
- Chromium production build succeeds;
- Native Host package succeeds;
- whitespace check is clean.

- [ ] **Step 3: Inspect the Chromium background bundle boundary**

Run:

```sh
npm run test:bundle-boundaries
rg -n "interpreterCodexModel|--model|gpt-5\.6" dist/background.js
```

Expected: bundle-boundary verification passes; background includes request handling but has no DOM dependency or runtime-loaded network chunk. Model suggestions belong in settings markup, not background execution logic.

- [ ] **Step 4: Reinstall protocol-v3 Native Host for the unpacked extension**

```sh
npm run install:native-host -- --extension-id oikmjebdlpcmpfkpnkkgbgdnmnhgngme
```

Expected: installation succeeds and reports the configured Host/manifest locations. Reload the unpacked extension after installation.

- [ ] **Step 5: Perform a real settings and execution smoke test**

In Chrome:

1. Open Web Clipper **Settings → Interpreter**.
2. Confirm **Codex model** is hidden in API and Grok modes and visible in Codex mode.
3. Confirm the three suggestions appear but a custom value can still be typed.
4. Leave the field empty, reload settings, and confirm it stays empty.
5. Enter an available authenticated model ID, reload settings, and confirm the trimmed value persists.
6. Run **Check connection** and confirm it succeeds without making a model request.
7. Trigger one normal Interpreter action and one explicit language-learning action; confirm both succeed with the selected model.
8. Enter a deliberately unavailable model ID and confirm Codex CLI’s failure appears in the existing retry UI with no automatic fallback.
9. Switch to Grok and confirm a request still uses the unchanged Grok invocation.

- [ ] **Step 6: Audit the final diff and worktree ownership**

```sh
git status --short
git diff --stat
git diff -- src/types/types.ts src/utils/codex-model.ts src/utils/storage-utils.ts src/settings.html src/managers/interpreter-settings.ts src/utils/native-cli-contract.ts src/utils/native-cli-client.ts src/utils/native-cli-service.ts src/utils/language-learning-service.ts src/utils/interpreter.ts native-host/obsidian-clipper-host.mjs
```

Expected: every new line traces to the approved Codex model setting; unrelated pre-existing changes are preserved and not accidentally staged.

- [ ] **Step 7: Create a final verification commit only if safe**

If verification required no source changes, do not create an empty commit. If a task-owned correction was necessary, stage only that correction and commit it with a precise message such as:

```sh
git commit -m "fix: complete Codex model override verification"
```

Record the exact command outcomes and any manual smoke-test limitation in the handoff.
