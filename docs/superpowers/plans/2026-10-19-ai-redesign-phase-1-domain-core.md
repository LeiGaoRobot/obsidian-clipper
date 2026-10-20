# AI Redesign Phase 1: Domain Core

Spec: [[2026-10-19-ai-subsystem-redesign-design]]. Branch: `ai-redesign`.

**Goal:** Add the pure domain core that later phases build on:

- the types;
- a derived v2 view over today's v1 settings;
- the single resolver;
- typed errors, with localized descriptions.

Nothing is persisted and no existing caller changes, so user-visible behavior is identical.

## Constraints

- Everything under `src/ai/` stays free of DOM, storage, and browser runtime. The one exception is `error-messages.ts`, which uses `getMessage` because it runs on the UI side.
- Nothing is written to storage. The v2 view is computed from a `Settings` object and must not mutate it.
- The view must be faithful to v1: the profile it resolves for every task equals the model or mode the current code would use. For API connections, the derived `kind` equals the wire branch `llm-client.ts` chooses today.
- Locale message names use only `[A-Za-z0-9_]`, so they are valid for Chrome `messages.json`. This refines the spec's `aiError.<code>` naming to `aiError<Code>Title` / `aiError<Code>Body`.
- Test-first for every module: run `npx vitest run src/ai/<name>.test.ts` while implementing.

## Spec refinements made here

1. **Connection kinds follow wire protocols:**
   - `openai-compatible`, `azure-openai`, `anthropic`, `ollama`, `huggingface`, `perplexity`
   - `cli-codex`, `cli-grok`

   The bundled Gemini, DeepSeek, OpenRouter, xAI, and Meta presets all use OpenAI-compatible endpoints, so vendor identity lives in `presetId`, not in `kind`. Phase 3 can add vendor-specific capability defaults keyed by `presetId`.
2. **Master AI switch:** `enabled` (v1 `interpreterEnabled`) is a master AI switch in the view, because every AI feature is gated on it today. `interpreter.autoRun` stays Interpreter-specific.
3. **CLI connections:** v1 makes both CLIs implicitly available, because the transcript error card can switch engines. The view therefore always synthesizes `legacy-cli-codex` and `legacy-cli-grok` connections and profiles. The resolver, not the view, rejects them with `host-unsupported` where Native Messaging is missing. The Codex profile carries `interpreterCodexModel` and `interpreterCodexReasoningEffort`.
4. **New error code `cli-missing`:** the Host reports `config` / `launch-failed` when the CLI executable is not configured or cannot start. That is distinct from a missing Host, and the user does something different to fix it.

## Files

| File | Responsibility |
| --- | --- |
| `src/ai/types.ts` | `ConnectionKind`, `Connection`, `ModelProfile`, `AiTask`, `AI_TASKS`, `AiRouting`, `AiSettingsView`, `NativeMessagingSupport` |
| `src/ai/connection-kind.ts` | `inferConnectionKind(provider)`: `presetId` → baseUrl host → legacy name rules; `isCliKind` |
| `src/ai/settings-view.ts` | `deriveAiSettings(settings, { nativeMessaging })` |
| `src/ai/resolve.ts` | `resolveProfile(view, task)`, `resolveResponseLanguage(view, browserLanguage)` |
| `src/ai/errors.ts` | `AiErrorCode`, `AiError`, `isAiError`, `toAiError(unknown)`, `classifyHttpStatus(status, body, { connectionId, kind })` |
| `src/ai/error-messages.ts` | `describeAiError(error) → { title, body, action, detail? }` |
| `src/_locales/{en,zh_CN}/messages.json` | `aiError<Code>Title` / `aiError<Code>Body` for every code |
| `AGENTS.md` | seam row for `src/ai/` |

Each module gets a `*.test.ts` next to it.

## Tasks

### 1. Types and connection kind

- `inferConnectionKind` checks, in order:
  1. an explicit `presetId` from the catalog id map;
  2. the URL host: `api.anthropic.com` → anthropic; `*.openai.azure.com` → azure-openai; `huggingface.co` hosts → huggingface; `api.perplexity.ai` → perplexity; port `11434` or path `/api/chat` → ollama;
  3. the legacy rules in `llm-client` order: name `hugging`, baseUrl `openai.azure.com`, name `anthropic`, name `perplexity`, name `ollama`;
  4. otherwise `openai-compatible`.
- Test: every bundled `providers.json` preset (by its name and baseUrl) maps to the branch `llm-client` uses today.
- Test: renamed providers keep their kind through the host rule.
- Test: a custom provider with an unknown host and name falls back to `openai-compatible`.

### 2. Derived v2 view

- `deriveAiSettings` maps providers to connections, with the API key copied into a separate `credentials` map and never onto the connection. Models map to profiles. CLI connections and profiles are always synthesized.
- `defaultProfileId` follows the v1 rules:
  - CLI mode → that CLI's profile;
  - otherwise the enabled model with id `interpreterModel`, falling back to the first enabled model;
  - otherwise unset.
- `taskProfiles` is empty. `responseLanguage` is the trimmed `readerSettings.learningResponseLanguage`, or undefined.
- Tests:
  - an API default;
  - a stale `interpreterModel` falling back to the first enabled model;
  - the Codex model and effort carried over;
  - Grok mode;
  - CLI connections kept where Native Messaging is unsupported;
  - the input is not mutated;
  - the API key does not appear on a connection.

### 3. Resolver

`resolveProfile(view, task)` returns `{ ok: true, profile, connection, credential? }` or `{ ok: false, error: AiError }`. It checks, in order:

1. AI disabled → `not-configured` (`reason: 'disabled'`)
2. no profile id → `not-configured` (`no-profile`)
3. missing or disabled profile → `not-configured` (`profile-unavailable`)
4. missing connection → `not-configured` (`connection-missing`)
5. CLI kind without Native Messaging → `host-unsupported`
6. API kind without a baseUrl → `not-configured` (`base-url-missing`)
7. a required key missing on this device → `credential-missing`

A task override beats the default. `resolveResponseLanguage` returns the view's language, falling back to the browser language.

Parity test: for a matrix of v1 settings, the resolved profile equals what `language-learning-service.ts` and `language-learning-readiness.ts` select today.

### 4. Errors

- `AiError extends Error` with `code`, `retryable`, `connectionId?`, `status?`, `detail?`. Its `name` is `'AiError'`, and the default `retryable` value comes from a per-code table.
- `toAiError(unknown)` uses duck typing, so it does not import runtime modules:
  - `AbortError` / `RequestCancelledError` → `cancelled`
  - `NativeCliUnavailableError` → `host-missing`
  - native codes:
    - `timeout` → `timeout`
    - `unavailable` → `host-missing`
    - `protocol-mismatch` → `host-outdated`
    - `config` / `launch-failed` → `cli-missing`
    - `response-too-large` → `bad-response`
    - `cancelled` → `cancelled`
    - `cli-failed` / `invalid` / `failed` → `provider-error`
  - A `TypeError` from `fetch` → `network`.
  - Any existing `AiError` passes through unchanged.
- `classifyHttpStatus` maps HTTP statuses to codes:
  - 401 / 403 → `auth`
  - 404 → `model-unavailable`
  - 408 → `timeout`
  - 429 with a quota or billing body → `quota`; otherwise 429 → `rate-limited`
  - 500 / 502 / 503 / 504 / 529 → retryable `provider-error`
  - any other status → non-retryable `provider-error`

### 5. Error descriptions and locales

- `describeAiError` returns i18n title and body text, an `action` from `openSettings | retry | continueRemaining | copyInstallCommand | switchProfile | none`, and the raw `detail` for a disclosure.
- Test: every `AiErrorCode` has both keys in the English and zh_CN locales, and every key name matches `^[A-Za-z0-9_]+$`.

### 6. Verify

```sh
TZ=America/Los_Angeles npm test
npx tsc --noEmit --module es2020
npm run build
npm run test:bundle-boundaries
git diff --check
```

Fable then reviews the diff against this plan and the spec.

## Review follow-ups (applied)

- Malformed stored providers (missing `name` / `baseUrl`, possible via import) map to an OpenAI-compatible connection with empty fields instead of throwing.
- Only `fetch` failure `TypeError`s (Chrome, Firefox, Safari wording) become `network`. Other `TypeError`s are `provider-error`.
- Ollama `403` (origin not allowed) is `provider-error`, not `auth`. HTTP details are capped at 2,000 characters.
- `cli-not-authenticated` is reserved until the Phase 2 CLI adapter detects sign-in failures, and its action is `none`.
- `resolveResponseLanguage` keeps v1's final `English` fallback.
- CLI connection and profile labels are empty: the UI localizes them from `kind`.
- The zh_CN copy follows existing terms: API 密钥, 提供商, 基础 URL, 解释器, and Native Messaging Host.

## Out of scope

Persisting v2, changing any caller, gateway and adapter code, and any Settings UI change are all out of scope for this phase. Phase 2 is the first phase that consumes `resolveProfile` and `AiError`.
