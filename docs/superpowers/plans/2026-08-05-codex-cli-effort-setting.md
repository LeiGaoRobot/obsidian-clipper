# Codex CLI Effort Setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, Codex-only reasoning-effort setting that is persisted, forwarded through Native Messaging protocol v4, and applied to each explicit `codex exec` invocation.

**Architecture:** Represent effort as a closed TypeScript union with one normalizer shared by settings and extension request validation. Forward the optional canonical value only in Codex mode, repeat the allowlist validation in the standalone Native Messaging Host, and pass it as the separate arguments `-c` and `model_reasoning_effort="value"`. Leaving the setting unset preserves the Codex CLI/model default.

**Tech Stack:** TypeScript, Vitest, jsdom, WebExtension storage, Chrome Native Messaging, Node.js ESM Native Host, Webpack, Markdown, Chrome `_locales` JSON.

## Global Constraints

- The default effort is unset; unset values are omitted from storage, Native Messaging requests, and CLI arguments.
- The only explicit values are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`.
- `max` and `ultra` remain model-dependent. If Codex CLI rejects a model/effort pair, preserve the existing `cli-failed` path; never downgrade, retry another effort, or switch models automatically.
- The effort setting applies only to Codex CLI. API-provider and Grok CLI behavior must remain unchanged and must never receive an `effort` property.
- Native Messaging protocol version is 4. An older Host must fail with the existing protocol-mismatch/reinstall flow instead of silently ignoring effort.
- The Host must repeat effort validation and pass `-c` and `model_reasoning_effort="value"` as separate `spawn` arguments. Never build a shell command.
- Model and effort overrides are independent: unset, effort-only, model-only, and model-plus-effort requests are all valid.
- Never initiate a paid or remote request on page load, transcript load, selection change, settings load, settings save, or health check. Existing trusted-user-action gates remain unchanged.
- Do not send model, effort, provider credentials, or CLI configuration through page DOM. Resolve stored settings in the existing background/caller paths.
- Preserve every pre-existing uncommitted workspace change. Stage and commit only the exact files owned by each task.
- Add user-visible strings to `src/_locales/en/messages.json` and `src/_locales/zh_CN/messages.json`; other locales use English fallback.
- Keep provider request code in `src/utils/llm-client.ts` unchanged.

## File map

- Create `src/utils/codex-reasoning-effort.ts`: canonical allowlist and normalization only.
- Create `src/utils/codex-reasoning-effort.test.ts`: pure allowlist and normalization tests.
- Modify `src/types/types.ts`: `CodexReasoningEffort` union and optional settings property.
- Modify `src/utils/storage-utils.ts` and `src/utils/storage-utils.test.ts`: safe load/save/omission.
- Modify `src/settings.html`, `src/managers/interpreter-settings.ts`, and `src/managers/interpreter-settings.test.ts`: Codex-only select, initialization, visibility, and form saving.
- Modify `src/_locales/en/messages.json` and `src/_locales/zh_CN/messages.json`: label, description, and default option.
- Modify `src/utils/native-cli-contract.ts` and `src/utils/native-cli-contract.test.ts`: protocol v4 and canonical request field.
- Modify `native-host/obsidian-clipper-host.mjs` and `native-host/obsidian-clipper-host.test.ts`: independent validation and exact argv.
- Modify `src/utils/native-cli-client.ts`, `src/utils/native-cli-client.test.ts`, `src/utils/native-cli-service.ts`, and `src/utils/native-cli-service.test.ts`: request-scoped forwarding across background/Native Port boundaries.
- Modify `src/utils/language-learning-service.ts`, `src/utils/language-learning-service.test.ts`, `src/utils/interpreter.ts`, and `src/utils/interpreter.test.ts`: stored-setting forwarding only in Codex mode.
- Modify `docs/Interpret web pages.md`, `docs/Language learning.md`, `docs/Introduction to Obsidian Web Clipper.md`, and `docs/development/Language learning MVP.md`: user behavior, cost, compatibility, and protocol v4.

---

### Task 1: Canonical effort values and persisted setting

**Files:**
- Create: `src/utils/codex-reasoning-effort.ts`
- Create: `src/utils/codex-reasoning-effort.test.ts`
- Modify: `src/types/types.ts:55-100`
- Modify: `src/utils/storage-utils.ts:1-8,108-120,220-302`
- Modify: `src/utils/storage-utils.test.ts:55-95`

**Interfaces:**
- Produces: `CodexReasoningEffort` from `src/types/types.ts`.
- Produces: `CODEX_REASONING_EFFORTS: readonly CodexReasoningEffort[]`.
- Produces: `normalizeCodexReasoningEffort(value: unknown): CodexReasoningEffort | undefined`.
- Produces: optional `Settings.interpreterCodexReasoningEffort` and stored `interpreter_settings.interpreterCodexReasoningEffort`.
- Consumes: existing `loadSettings()` and `saveSettings()` storage flow.

- [ ] **Step 1: Write the failing pure normalizer test**

Create `src/utils/codex-reasoning-effort.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
	CODEX_REASONING_EFFORTS,
	normalizeCodexReasoningEffort
} from './codex-reasoning-effort';

describe('Codex reasoning effort setting', () => {
	test('accepts every supported effort value', () => {
		expect(CODEX_REASONING_EFFORTS).toEqual([
			'minimal',
			'low',
			'medium',
			'high',
			'xhigh',
			'max',
			'ultra'
		]);
		for (const effort of CODEX_REASONING_EFFORTS) {
			expect(normalizeCodexReasoningEffort(effort)).toBe(effort);
		}
	});

	test('treats absent, padded, and unknown values as unset', () => {
		expect(normalizeCodexReasoningEffort(undefined)).toBeUndefined();
		expect(normalizeCodexReasoningEffort('')).toBeUndefined();
		expect(normalizeCodexReasoningEffort(' high ')).toBeUndefined();
		expect(normalizeCodexReasoningEffort('extreme')).toBeUndefined();
		expect(normalizeCodexReasoningEffort(1)).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the pure test and verify RED**

Run:

```bash
npx vitest run src/utils/codex-reasoning-effort.test.ts
```

Expected: FAIL because `./codex-reasoning-effort` does not exist.

- [ ] **Step 3: Add the minimal type and normalizer**

Add beside `InterpreterExecutionMode` in `src/types/types.ts`:

```ts
export type CodexReasoningEffort =
	| 'minimal'
	| 'low'
	| 'medium'
	| 'high'
	| 'xhigh'
	| 'max'
	| 'ultra';
```

Add to `Settings` beside `interpreterCodexModel`:

```ts
interpreterCodexReasoningEffort?: CodexReasoningEffort;
```

Create `src/utils/codex-reasoning-effort.ts`:

```ts
import type { CodexReasoningEffort } from '../types/types';

export const CODEX_REASONING_EFFORTS = [
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra'
] as const satisfies readonly CodexReasoningEffort[];

export function normalizeCodexReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
	return typeof value === 'string'
		&& (CODEX_REASONING_EFFORTS as readonly string[]).includes(value)
		? value as CodexReasoningEffort
		: undefined;
}
```

- [ ] **Step 4: Run the pure test and verify GREEN**

Run:

```bash
npx vitest run src/utils/codex-reasoning-effort.test.ts
```

Expected: PASS with 2 tests.

- [ ] **Step 5: Write failing storage round-trip tests**

Extend `src/utils/storage-utils.test.ts`:

```ts
test('loads and saves a supported Codex reasoning effort', async () => {
	mocks.state.interpreter_settings = {
		interpreterExecutionMode: 'codex',
		interpreterCodexReasoningEffort: 'max'
	};

	const settings = await loadSettings();
	expect(settings.interpreterCodexReasoningEffort).toBe('max');

	await saveSettings(settings);
	expect(mocks.set).toHaveBeenLastCalledWith(expect.objectContaining({
		interpreter_settings: expect.objectContaining({
			interpreterCodexReasoningEffort: 'max'
		})
	}));
});

test('normalizes unknown or default Codex reasoning effort to an omitted value', async () => {
	mocks.state.interpreter_settings = {
		interpreterExecutionMode: 'codex',
		interpreterCodexReasoningEffort: 'extreme'
	};

	const settings = await loadSettings();
	expect(settings.interpreterCodexReasoningEffort).toBeUndefined();

	await saveSettings({ interpreterCodexReasoningEffort: undefined });
	const saved = mocks.set.mock.calls[mocks.set.mock.calls.length - 1]?.[0].interpreter_settings;
	expect(saved).not.toHaveProperty('interpreterCodexReasoningEffort');
});
```

- [ ] **Step 6: Run storage tests and verify RED**

Run:

```bash
npx vitest run src/utils/storage-utils.test.ts
```

Expected: FAIL because the setting is neither loaded nor saved.

- [ ] **Step 7: Implement storage load/save/omission**

Import `CodexReasoningEffort` and `normalizeCodexReasoningEffort` in `src/utils/storage-utils.ts`. Add the optional field to `StorageData.interpreter_settings`:

```ts
interpreterCodexReasoningEffort?: CodexReasoningEffort;
```

Add to `loadSettings()` beside `interpreterCodexModel`:

```ts
interpreterCodexReasoningEffort: normalizeCodexReasoningEffort(
	data.interpreter_settings?.interpreterCodexReasoningEffort
),
```

Normalize before writing in `saveSettings()`:

```ts
generalSettings.interpreterCodexReasoningEffort = normalizeCodexReasoningEffort(
	generalSettings.interpreterCodexReasoningEffort
);
```

Add to the saved `interpreter_settings` object:

```ts
...(generalSettings.interpreterCodexReasoningEffort
	? { interpreterCodexReasoningEffort: generalSettings.interpreterCodexReasoningEffort }
	: {}),
```

- [ ] **Step 8: Run focused Task 1 tests and type-check**

Run:

```bash
npx vitest run src/utils/codex-reasoning-effort.test.ts src/utils/storage-utils.test.ts
npx tsc --noEmit --module es2020
```

Expected: both commands exit 0.

- [ ] **Step 9: Commit Task 1 only**

```bash
git add src/utils/codex-reasoning-effort.ts src/utils/codex-reasoning-effort.test.ts src/types/types.ts src/utils/storage-utils.ts src/utils/storage-utils.test.ts
git diff --cached --check
git commit -m "feat: persist Codex reasoning effort"
```

---

### Task 2: Codex-only settings UI and localization

**Files:**
- Modify: `src/settings.html:617-630`
- Modify: `src/managers/interpreter-settings.ts:1-15,200-250,313-325,1200-1235`
- Modify: `src/managers/interpreter-settings.test.ts`
- Modify: `src/_locales/en/messages.json:497-509`
- Modify: `src/_locales/zh_CN/messages.json:497-509`

**Interfaces:**
- Consumes: `CODEX_REASONING_EFFORTS` and `normalizeCodexReasoningEffort` from Task 1.
- Consumes: optional `generalSettings.interpreterCodexReasoningEffort` from Task 1.
- Produces: `updateCodexSettingsVisibility(doc?: Document): void`.
- Produces: exported `saveInterpreterSettingsFromForm(): void`, which remains the existing production form-save handler and is exercised directly by jsdom tests.

- [ ] **Step 1: Write failing jsdom tests for visibility, options, and saving**

Refactor the existing mocks in `src/managers/interpreter-settings.test.ts` so `saveSettings` is inspectable, import `saveInterpreterSettingsFromForm` and `updateCodexSettingsVisibility`, and add these assertions:

```ts
test('shows model and reasoning effort controls only in Codex mode', () => {
	const settingsDocument = new DOMParser().parseFromString(
		readFileSync(resolve(process.cwd(), 'src/settings.html'), 'utf8'),
		'text/html'
	);
	const mode = settingsDocument.getElementById('interpreter-execution-mode') as HTMLSelectElement;
	const modelItem = settingsDocument.getElementById('interpreter-codex-model-item') as HTMLElement;
	const effortItem = settingsDocument.getElementById('interpreter-codex-reasoning-effort-item') as HTMLElement;
	const effort = settingsDocument.getElementById('interpreter-codex-reasoning-effort') as HTMLSelectElement;

	mode.value = 'grok';
	updateCodexSettingsVisibility(settingsDocument);
	expect(modelItem.hidden).toBe(true);
	expect(effortItem.hidden).toBe(true);

	mode.value = 'codex';
	updateCodexSettingsVisibility(settingsDocument);
	expect(modelItem.hidden).toBe(false);
	expect(effortItem.hidden).toBe(false);
	expect(Array.from(effort.options).map(option => option.value)).toEqual([
		'', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
	]);
});

test('saves the selected Codex reasoning effort and clears Default', () => {
	document.body.innerHTML = `
		<select id="interpreter-execution-mode"><option value="codex" selected>Codex</option></select>
		<select id="interpreter-codex-reasoning-effort">
			<option value=""></option>
			<option value="max" selected>max</option>
		</select>
	`;

	saveInterpreterSettingsFromForm();
	expect(mocks.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
		interpreterCodexReasoningEffort: 'max'
	}));

	(document.getElementById('interpreter-codex-reasoning-effort') as HTMLSelectElement).value = '';
	saveInterpreterSettingsFromForm();
	expect(mocks.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
		interpreterCodexReasoningEffort: undefined
	}));
});
```

Preserve the existing model-input assertions in the same test file.

- [ ] **Step 2: Run the UI test and verify RED**

Run:

```bash
npx vitest run src/managers/interpreter-settings.test.ts
```

Expected: FAIL because the effort control and exported handlers do not exist.

- [ ] **Step 3: Add the select and localized copy**

Add below `interpreter-codex-model-item` in `src/settings.html`:

```html
<div class="setting-item mod-horizontal" id="interpreter-codex-reasoning-effort-item" hidden>
	<div class="setting-item-info">
		<label for="interpreter-codex-reasoning-effort" data-i18n="interpreterCodexReasoningEffort">Codex reasoning effort</label>
		<div class="setting-item-description" data-i18n="interpreterCodexReasoningEffortDescription">Override reasoning effort for every Codex CLI action. Higher effort can take longer and use more tokens. Unsupported model and effort combinations fail without fallback.</div>
	</div>
	<div class="setting-item-control">
		<select id="interpreter-codex-reasoning-effort">
			<option value="" data-i18n="interpreterCodexReasoningEffortDefault">Use Codex CLI default</option>
			<option value="minimal">minimal</option>
			<option value="low">low</option>
			<option value="medium">medium</option>
			<option value="high">high</option>
			<option value="xhigh">xhigh</option>
			<option value="max">max</option>
			<option value="ultra">ultra</option>
		</select>
	</div>
</div>
```

Add English keys:

```json
"interpreterCodexReasoningEffort": {
	"message": "Codex reasoning effort"
},
"interpreterCodexReasoningEffortDefault": {
	"message": "Use Codex CLI default"
},
"interpreterCodexReasoningEffortDescription": {
	"message": "Override reasoning effort for every Codex CLI action. Higher effort can take longer and use more tokens. Unsupported model and effort combinations fail without fallback."
}
```

Add Simplified Chinese keys:

```json
"interpreterCodexReasoningEffort": {
	"message": "Codex 推理强度"
},
"interpreterCodexReasoningEffortDefault": {
	"message": "使用 Codex CLI 默认值"
},
"interpreterCodexReasoningEffortDescription": {
	"message": "覆盖所有 Codex CLI 操作使用的推理强度。更高的强度可能耗时更长并使用更多 token；模型不支持所选强度时会直接失败，不会自动降级。"
}
```

- [ ] **Step 4: Wire initialization, visibility, and saving**

Import the Task 1 normalizer. During initialization, set the select value:

```ts
const codexEffortSelect = document.getElementById('interpreter-codex-reasoning-effort') as HTMLSelectElement | null;
if (codexEffortSelect) {
	codexEffortSelect.value = generalSettings.interpreterCodexReasoningEffort ?? '';
}
```

Rename `updateCodexModelVisibility` to `updateCodexSettingsVisibility` and toggle both items:

```ts
export function updateCodexSettingsVisibility(doc: Document = document): void {
	const executionModeSelect = doc.getElementById('interpreter-execution-mode') as HTMLSelectElement | null;
	const codexModelItem = doc.getElementById('interpreter-codex-model-item');
	const codexEffortItem = doc.getElementById('interpreter-codex-reasoning-effort-item');
	if (!executionModeSelect || !codexModelItem || !codexEffortItem) return;
	const hidden = executionModeSelect.value !== 'codex';
	codexModelItem.hidden = hidden;
	codexEffortItem.hidden = hidden;
}
```

Update both existing call sites to use the renamed function. Export the existing form handler and add:

```ts
const codexEffortSelect = document.getElementById('interpreter-codex-reasoning-effort') as HTMLSelectElement | null;
if (codexEffortSelect) {
	updatedSettings.interpreterCodexReasoningEffort = normalizeCodexReasoningEffort(codexEffortSelect.value);
}
```

- [ ] **Step 5: Run focused UI/storage tests and locale validation**

Run:

```bash
npx vitest run src/managers/interpreter-settings.test.ts src/utils/storage-utils.test.ts src/utils/codex-reasoning-effort.test.ts
npm run check-strings
```

Expected: tests exit 0. `check-strings` may continue to report the repository's existing unused-key baseline, but none of the three new `interpreterCodexReasoningEffort*` keys may be reported unused.

- [ ] **Step 6: Commit Task 2 only**

```bash
git add src/settings.html src/managers/interpreter-settings.ts src/managers/interpreter-settings.test.ts src/_locales/en/messages.json src/_locales/zh_CN/messages.json
git diff --cached --check
git commit -m "feat: add Codex reasoning effort setting UI"
```

---

### Task 3: Native Messaging protocol v4 and Host argv

**Files:**
- Modify: `src/utils/native-cli-contract.ts`
- Modify: `src/utils/native-cli-contract.test.ts`
- Modify: `native-host/obsidian-clipper-host.mjs`
- Modify: `native-host/obsidian-clipper-host.test.ts`

**Interfaces:**
- Consumes: `CodexReasoningEffort`, `CODEX_REASONING_EFFORTS`, and `normalizeCodexReasoningEffort` from Task 1.
- Produces: `NATIVE_CLI_PROTOCOL_VERSION = 4` in both extension and Host.
- Produces: optional `effort?: CodexReasoningEffort` on `NativeCliRequest` and `NativeCliRequestOptions`.
- Produces: Host invocation pair `['-c', 'model_reasoning_effort="value"']` for Codex only.

- [ ] **Step 1: Write failing extension-contract tests**

Extend `src/utils/native-cli-contract.test.ts`:

```ts
test('uses protocol v4 and adds canonical effort only to Codex requests', () => {
	expect(NATIVE_CLI_PROTOCOL_VERSION).toBe(4);
	expect(buildNativeCliRequest('codex', 'Context', [], {
		requestId: 'request-effort',
		effort: 'max'
	})).toMatchObject({
		protocolVersion: 4,
		mode: 'codex',
		effort: 'max'
	});
});

test('rejects invalid or non-Codex effort overrides', () => {
	expect(() => buildNativeCliRequest('codex', 'Context', [], {
		effort: 'extreme' as never
	})).toThrow('Codex reasoning effort must be a supported value.');
	expect(() => buildNativeCliRequest('grok', 'Context', [], {
		effort: 'high'
	})).toThrow('Codex reasoning effort overrides require Codex execution mode.');
});

test.each(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
	('accepts %s at the extension boundary', effort => {
		expect(isNativeCliRequest({
			type: 'executeCli',
			protocolVersion: 4,
			requestId: `request-${effort}`,
			mode: 'codex',
			prompt: 'prompt',
			effort
		})).toBe(true);
	});
```

Also assert that `isNativeCliRequest` rejects `effort: 'extreme'` and rejects `effort: 'high'` in Grok mode.

- [ ] **Step 2: Write failing Host boundary and argv tests**

Extend `native-host/obsidian-clipper-host.test.ts`:

```ts
test('passes model and reasoning effort to Codex as separate arguments', () => {
	const invocation = createCliInvocation(
		{ mode: 'codex', prompt: 'prompt', model: 'gpt-5.6-sol', effort: 'max' },
		{ grokPath: '/usr/local/bin/grok', codexPath: '/usr/local/bin/codex' }
	);

	expect(invocation.args).toEqual([
		'exec',
		'--model',
		'gpt-5.6-sol',
		'-c',
		'model_reasoning_effort="max"',
		'--ephemeral',
		'--color',
		'never',
		'--sandbox',
		'read-only',
		'--skip-git-repo-check',
		'-'
	]);
});

test('supports an effort override without a model override', () => {
	const invocation = createCliInvocation(
		{ mode: 'codex', prompt: 'prompt', effort: 'high' },
		{ grokPath: '/usr/local/bin/grok', codexPath: '/usr/local/bin/codex' }
	);

	expect(invocation.args).toEqual([
		'exec',
		'-c',
		'model_reasoning_effort="high"',
		'--ephemeral',
		'--color',
		'never',
		'--sandbox',
		'read-only',
		'--skip-git-repo-check',
		'-'
	]);
});

test.each(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
	('accepts %s effort at the Native Host boundary', effort => {
		expect(validateRequest({
			type: 'executeCli',
			protocolVersion: 4,
			requestId: `request-${effort}`,
			mode: 'codex',
			prompt: 'prompt',
			effort
		})).toBeNull();
	});
```

Add Host rejection cases for unknown effort and Grok effort, and preserve the existing no-model argv test as the no-model/no-effort regression case.

- [ ] **Step 3: Run contract and Host tests and verify RED**

Run:

```bash
npx vitest run src/utils/native-cli-contract.test.ts native-host/obsidian-clipper-host.test.ts
```

Expected: FAIL because the protocol is 3 and effort is not represented, validated, or added to argv.

- [ ] **Step 4: Implement extension protocol v4**

In `src/utils/native-cli-contract.ts`:

```ts
export const NATIVE_CLI_PROTOCOL_VERSION = 4;

export interface NativeCliRequest {
	// existing fields
	effort?: CodexReasoningEffort;
}

export interface NativeCliRequestOptions {
	requestId?: string;
	model?: string;
	effort?: CodexReasoningEffort;
}
```

Validate `isNativeCliRequest` with:

```ts
const validEffort = request.effort === undefined || (
	request.mode === 'codex'
	&& normalizeCodexReasoningEffort(request.effort) === request.effort
);
```

In `buildNativeCliRequest`, normalize, reject explicit invalid/non-Codex effort, and include only a valid value:

```ts
const effort = normalizeCodexReasoningEffort(options.effort);
if (options.effort !== undefined && !effort) {
	throw new TypeError('Codex reasoning effort must be a supported value.');
}
if (effort && mode !== 'codex') {
	throw new TypeError('Codex reasoning effort overrides require Codex execution mode.');
}
```

Add `&& validEffort` to the request guard and `...(effort ? { effort } : {})` to the result.

- [ ] **Step 5: Implement independent Host validation and argv**

In `native-host/obsidian-clipper-host.mjs`:

```js
export const NATIVE_CLI_PROTOCOL_VERSION = 4;
export const CODEX_REASONING_EFFORTS = new Set([
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra'
]);
```

Add to `validateRequest` after model validation:

```js
if (request.effort !== undefined) {
	if (request.mode !== 'codex') {
		return 'Codex reasoning effort overrides require Codex execution mode.';
	}
	if (typeof request.effort !== 'string' || !CODEX_REASONING_EFFORTS.has(request.effort)) {
		return 'Codex reasoning effort must be a supported value.';
	}
}
```

Add to Codex argv immediately after the optional model pair:

```js
...(request.effort
	? ['-c', `model_reasoning_effort="${request.effort}"`]
	: []),
```

- [ ] **Step 6: Run focused protocol and Host tests**

Run:

```bash
npx vitest run src/utils/codex-reasoning-effort.test.ts src/utils/native-cli-contract.test.ts native-host/obsidian-clipper-host.test.ts
npx tsc --noEmit --module es2020
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit Task 3 only**

```bash
git add src/utils/native-cli-contract.ts src/utils/native-cli-contract.test.ts native-host/obsidian-clipper-host.mjs native-host/obsidian-clipper-host.test.ts
git diff --cached --check
git commit -m "feat: carry Codex reasoning effort over native messaging"
```

---

### Task 4: Forward effort from stored callers to the Native Port

**Files:**
- Modify: `src/utils/native-cli-client.ts`
- Modify: `src/utils/native-cli-client.test.ts`
- Modify: `src/utils/native-cli-service.ts`
- Modify: `src/utils/native-cli-service.test.ts`
- Modify: `src/utils/language-learning-service.ts`
- Modify: `src/utils/language-learning-service.test.ts`
- Modify: `src/utils/interpreter.ts`
- Modify: `src/utils/interpreter.test.ts`

**Interfaces:**
- Consumes: `CodexReasoningEffort` from Task 1.
- Consumes: `NativeCliRequestOptions.effort` from Task 3.
- Produces: `NativeCliClientOptions.effort?: CodexReasoningEffort`.
- Produces: `NativeCliExecutionOptions.effort?: CodexReasoningEffort` while preserving `signal?: AbortSignal`.

- [ ] **Step 1: Write failing client and observable Native Port tests**

Update `src/utils/native-cli-client.test.ts` so its Codex test passes both values and observes the background message:

```ts
await executeNativeCli(
	'codex',
	'Context',
	[{ key: 'prompt_1', prompt: 'Summarize', filters: '' }],
	{ model: 'gpt-5.6-sol', effort: 'max' }
);

expect(mocks.sendMessage).toHaveBeenCalledWith({
	action: 'nativeCliRequest',
	request: expect.objectContaining({
		mode: 'codex',
		model: 'gpt-5.6-sol',
		effort: 'max'
	})
});
```

Update the observable test in `src/utils/native-cli-service.test.ts`:

```ts
const response = executeNativeCliForPrompts(
	'codex',
	'Context',
	[{ key: 'prompt_1', prompt: 'Summarize' }],
	{ model: 'gpt-5.6-sol', effort: 'ultra' }
);
const request = port.posted[0] as {
	requestId: string;
	mode: string;
	model?: string;
	effort?: string;
};
expect(request).toMatchObject({
	mode: 'codex',
	model: 'gpt-5.6-sol',
	effort: 'ultra'
});
```

Extend the Grok Native Port test to assert both `model` and `effort` are absent. Keep the existing cancellation test unchanged so it proves the option-object change does not alter cancellation.

- [ ] **Step 2: Write failing stored-caller tests**

In `src/utils/language-learning-service.test.ts`, configure:

```ts
mocks.loadSettings.mockResolvedValue({
	interpreterEnabled: true,
	interpreterExecutionMode: 'codex',
	interpreterCodexModel: 'gpt-5.6-terra',
	interpreterCodexReasoningEffort: 'max'
});
```

Expect:

```ts
expect(mocks.executeNativeCliForPrompts).toHaveBeenCalledWith(
	'codex',
	'Context',
	[{ key: 'prompt_1', prompt: 'Translate' }],
	{ model: 'gpt-5.6-terra', effort: 'max', signal: controller.signal }
);
```

Set the same stored values in the Grok case and expect only `{ signal: controller.signal }`.

In `src/utils/interpreter.test.ts`, add `interpreterCodexReasoningEffort: 'high'` to the mocked settings and expect:

```ts
expect(mocks.executeNativeCli).toHaveBeenCalledWith(
	'codex',
	'Page context',
	[{ key: 'prompt_1', prompt: 'Summarize', filters: '' }],
	{ model: 'gpt-5.6-luna', effort: 'high' }
);
```

- [ ] **Step 3: Run all four caller test files and verify RED**

Run:

```bash
npx vitest run src/utils/native-cli-client.test.ts src/utils/native-cli-service.test.ts src/utils/language-learning-service.test.ts src/utils/interpreter.test.ts
```

Expected: FAIL because effort is not present in option types or forwarded request objects.

- [ ] **Step 4: Add request-scoped effort to client and service options**

Import `CodexReasoningEffort` as a type. Extend both option interfaces:

```ts
export interface NativeCliClientOptions {
	model?: string;
	effort?: CodexReasoningEffort;
}
```

```ts
export interface NativeCliExecutionOptions {
	model?: string;
	effort?: CodexReasoningEffort;
	signal?: AbortSignal;
}
```

In each `buildNativeCliRequest` call, pass:

```ts
{ model: options.model, effort: options.effort }
```

- [ ] **Step 5: Forward stored effort only for Codex callers**

In `src/utils/language-learning-service.ts`, extend the existing options object:

```ts
{
	...(executionMode === 'codex' && settings.interpreterCodexModel
		? { model: settings.interpreterCodexModel }
		: {}),
	...(executionMode === 'codex' && settings.interpreterCodexReasoningEffort
		? { effort: settings.interpreterCodexReasoningEffort }
		: {}),
	signal
}
```

In `src/utils/interpreter.ts`, build the Codex options without coupling the two settings:

```ts
executionMode === 'codex'
	? {
		...(generalSettings.interpreterCodexModel
			? { model: generalSettings.interpreterCodexModel }
			: {}),
		...(generalSettings.interpreterCodexReasoningEffort
			? { effort: generalSettings.interpreterCodexReasoningEffort }
			: {})
	}
	: {}
```

- [ ] **Step 6: Run focused caller/protocol tests and type-check**

Run:

```bash
npx vitest run src/utils/native-cli-client.test.ts src/utils/native-cli-service.test.ts src/utils/language-learning-service.test.ts src/utils/interpreter.test.ts src/utils/native-cli-contract.test.ts native-host/obsidian-clipper-host.test.ts
npx tsc --noEmit --module es2020
```

Expected: both commands exit 0. Confirm the observable Port request contains effort for Codex, omits it for Grok, and the cancellation test still passes.

- [ ] **Step 7: Commit Task 4 only**

```bash
git add src/utils/native-cli-client.ts src/utils/native-cli-client.test.ts src/utils/native-cli-service.ts src/utils/native-cli-service.test.ts src/utils/language-learning-service.ts src/utils/language-learning-service.test.ts src/utils/interpreter.ts src/utils/interpreter.test.ts
git diff --cached --check
git commit -m "feat: apply Codex reasoning effort to Interpreter requests"
```

---

### Task 5: User and developer documentation

**Files:**
- Modify: `docs/Interpret web pages.md:40-53`
- Modify: `docs/Language learning.md:12-17,96-112`
- Modify: `docs/Introduction to Obsidian Web Clipper.md:34-38`
- Modify: `docs/development/Language learning MVP.md:101-109`

**Interfaces:**
- Consumes: final UI behavior from Task 2.
- Consumes: protocol v4 and Host argv behavior from Task 3.
- Consumes: stored-caller scope from Task 4.
- Produces: discoverable documentation with model-dependent effort and cost behavior.

- [ ] **Step 1: Update Interpreter documentation with exact behavior**

Expand the Codex paragraph in `docs/Interpret web pages.md` to state:

```markdown
When you select **Codex CLI**, optional **Codex model** and **Codex reasoning effort** controls appear. Both apply to every Codex CLI Interpreter and language-learning action, and either can be left at its default independently. Reasoning effort choices are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; availability depends on the selected model. Higher effort can take longer and use more tokens. Unsupported model and effort combinations are shown as retryable CLI failures without automatic fallback. Changing either setting does not run a request, and **Check connection** verifies only the Host and executable.
```

- [ ] **Step 2: Update language-learning and Introduction documentation**

In `docs/Language learning.md`, add the independent optional effort setting to setup and model-selection guidance. Change the cancellation protocol reference from version 3 to version 4. State that readiness does not validate model/effort compatibility.

In `docs/Introduction to Obsidian Web Clipper.md`, change the Interpreter discovery bullet to:

```markdown
	- Use an API provider or a local Grok/Codex CLI through Chrome Native Messaging, with optional per-request Codex model and reasoning-effort overrides and a Settings guide that prepares a cwd-independent one-time Host install command for local source builds.
```

- [ ] **Step 3: Update the development architecture paragraph**

Replace the Native Messaging description in `docs/development/Language learning MVP.md` with a paragraph that explicitly records:

```markdown
In Codex CLI mode, the background resolves `interpreterCodexModel` and `interpreterCodexReasoningEffort` from stored Interpreter settings. Native Messaging protocol v4 carries optional canonical `model` and `effort` values only for Codex. The extension and Host both validate effort against `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; the Host passes effort as separate `-c` and `model_reasoning_effort="value"` spawn arguments. A protocol mismatch with an older v3 Host requires reinstalling the Host. Model support is left to Codex CLI, and failures do not trigger fallback.
```

Preserve the existing model-length, request-ID, cancellation, Grok hardening, credentials, and health-check statements around that paragraph.

- [ ] **Step 4: Verify documentation consistency**

Run:

```bash
rg -n "protocol version 3|Protocol v3|older v2|interpreterCodexReasoningEffort|model_reasoning_effort|Codex reasoning effort" docs src native-host
git diff --check -- docs/Interpret\ web\ pages.md docs/Language\ learning.md docs/Introduction\ to\ Obsidian\ Web\ Clipper.md docs/development/Language\ learning\ MVP.md
```

Expected: active Native Messaging documentation uses v4; old v2/v3 wording remains only in historical design/plan documents where appropriate. All new effort behavior is discoverable.

- [ ] **Step 5: Commit Task 5 only**

```bash
git add "docs/Interpret web pages.md" "docs/Language learning.md" "docs/Introduction to Obsidian Web Clipper.md" "docs/development/Language learning MVP.md"
git diff --cached --check
git commit -m "docs: explain Codex reasoning effort override"
```

---

### Task 6: Full verification, Host package, and installed-Host smoke

**Files:**
- Verify only; no source files are owned by this task.

**Interfaces:**
- Consumes: completed Tasks 1-5.
- Produces: fresh evidence that the clean committed feature works across unit, type, build, bundle, package, and installed-Host boundaries.

- [ ] **Step 1: Run the complete focused suite**

```bash
npx vitest run src/utils/codex-reasoning-effort.test.ts src/utils/storage-utils.test.ts src/managers/interpreter-settings.test.ts src/utils/native-cli-contract.test.ts native-host/obsidian-clipper-host.test.ts src/utils/native-cli-client.test.ts src/utils/native-cli-service.test.ts src/utils/language-learning-service.test.ts src/utils/interpreter.test.ts
```

Expected: all focused files and tests pass.

- [ ] **Step 2: Run the repository completion matrix**

```bash
TZ=America/Los_Angeles npm test
npx tsc --noEmit --module es2020
npm run build
npm run test:bundle-boundaries
npm run package:native-host
npm run check-strings
git diff --check
```

Expected: tests, type-check, all browser builds, bundle-boundary verification, Host packaging, and `git diff --check` exit 0. `check-strings` may report the known legacy unused-key baseline, but none of the new effort keys may appear.

- [ ] **Step 3: Verify the built background boundary**

```bash
rg -n "interpreterCodexReasoningEffort" dist/background.js
! rg -n "model_reasoning_effort" dist/background.js dist/*.js dist/chunks/*.js
```

Expected: the background contains the stored setting/request path. No extension bundle contains the Host-only `model_reasoning_effort` command-construction string or credentials.

- [ ] **Step 4: Reinstall Native Host protocol v4**

```bash
npm run install:native-host -- --extension-id oikmjebdlpcmpfkpnkkgbgdnmnhgngme
```

Expected: the installer reports `com.obsidian.web_clipper` installed for that extension ID. Inspect the installed Host and manifest paths printed by the command; confirm the Host exports protocol version 4 and the manifest retains only the expected extension origin.

- [ ] **Step 5: Run a non-billable installed-Host health smoke**

Send this length-prefixed JSON request directly to the installed launcher without invoking `codex exec`:

```json
{
	"type": "healthCheck",
	"protocolVersion": 4,
	"requestId": "effort-health-codex",
	"mode": "codex"
}
```

Decode the length-prefixed response and require:

```json
{
	"ok": true,
	"requestId": "effort-health-codex",
	"health": {
		"protocolVersion": 4,
		"mode": "codex"
	}
}
```

Also require a non-empty `health.command`. This smoke must not send page content or run a model request.

- [ ] **Step 6: Perform the browser settings smoke when policy permits**

Reload the unpacked extension, open Settings → Interpreter, and verify:

1. API and Grok modes hide model and effort controls.
2. Codex mode shows both controls.
3. The effort list contains Default plus all seven explicit values, including `max` and `ultra`.
4. Selecting `max`, reloading Settings, and returning to Default persists correctly.
5. No model request is made by these settings actions.

If browser policy blocks `chrome://extensions` or the extension settings URL, record the smoke as `NOT VERIFIED` with the exact policy limitation. Do not bypass browser policy and do not run an explicit Codex action merely to test billing-sensitive execution.

- [ ] **Step 7: Inspect final scope**

```bash
git status --short
git log --oneline --decorate -8
git diff --check
```

Expected: only the intended task commits were added; all pre-existing user changes remain unstaged and unmodified by the feature workflow.
