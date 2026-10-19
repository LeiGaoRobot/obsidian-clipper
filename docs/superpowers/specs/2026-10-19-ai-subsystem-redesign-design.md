# AI Subsystem Redesign

Status: approved direction; decisions D1–D4 accepted 2026-10-19. Revised after an architecture review. This redesign supersedes the incremental Interpreter / language-learning AI plumbing.

## Why

Users run into problems both when they configure AI and when they use it. Each problem traces back to the current code:

| Pain | Root cause in the current code |
| --- | --- |
| Configuration is scattered | Providers, models, a global execution mode, the Codex model and effort, and the response language each live in a different Settings section. The readiness assistant is a second view of the same state. |
| API vs CLI is confusing | `interpreterExecutionMode` is a global switch outside the model list. In CLI mode `interpreterModel` is ignored. `?? 'api'` is repeated in about 15 places. |
| One model for every feature | A single `interpreterModel` serves Interpreter, AI edit, transcript translation, Japanese readings, and explanations. |
| "Is it configured?" is unclear | API mode only checks that the fields are filled in. The CLI health check does not validate the model or the effort. |
| Errors are unclear | The Interpreter path collapses errors to a plain `Error` (`native-cli-client.ts:25-33`). Some messages are hard-coded English. Cancellation is detected by matching names and messages (`request-cancellation.ts:13-19`). |
| Long jobs are slow or stall | Batches run strictly one after another. Timeouts differ by path (API 60 s, CLI 120 s). Adaptive shrinking is per-call module state (`language-learning-runtime.ts`). |
| Entry points behave differently | Interpreter fetches the provider from the popup. AI edit and Reader go through the background. `src/cli.ts` has a third argv builder that lacks model and effort support (`cli-execution.ts:62-76`). Only language learning supports cancel, progress, and structured errors. |
| Result quality is poor | Every request, plain text included, is wrapped in a `prompts_responses` JSON envelope and then repaired with regexes (`llm-client.ts:~290-380`). |

Structural smells make these worse:

- The wire protocol is chosen by substrings of `provider.name` (`llm-client.ts:74-234`).
- `Provider.presetId` is never set.
- The preset catalog is fetched from upstream, not from this fork.
- Defaults are defined in four places.
- API keys sit in `storage.sync` in plain text.
- All AI settings share one sync item, which is close to the 8 KB per-item quota.
- `transcript-language-learning.ts` is 1,593 lines. `interpreter-settings.ts` is 1,237 lines.

## Goals

1. **One mental model.** Users add *connections* (an API provider or a local CLI), define *model profiles* on them, and assign profiles to *tasks*. A CLI is a connection, not a global mode.
2. **Per-task models.** A default profile, plus an optional override for each task.
3. **Verifiable setup.** Every connection has an explicit **Test** action that returns a specific result the user can act on.
4. **One execution path.** Every model call goes through one background gateway, with the same cancel, progress, timeout, errors, and diagnostics behavior.
5. **Actionable errors.** A closed set of error codes, localized messages, and a next step for each.
6. **Fast, resumable long jobs.** Bounded concurrency, per-batch retry policy, adaptive batch size, durable checkpoints, and reattach after the service worker restarts.
7. **Task-shaped output.** Each task declares an output contract. Structured output is used where it is supported, with a tolerant parser as the fallback. Plain-text tasks are not forced into JSON.

## Non-goals

- New AI features. Scope is Interpreter prompt variables, AI edit, transcript translation, Japanese readings, and explanation. Vocabulary is storage-only and makes no model call.
- Changing the Interpreter template syntax `{{"prompt"}}`.
- Native Messaging installers for browsers other than Chrome.

## Domain model

This evolves `Provider` / `ModelConfig` (`types.ts:39-46,123-129`) by adding an explicit `kind`, CLI kinds, and a routing table.

```ts
type ApiKind =
  | 'openai-compatible' | 'openai' | 'azure-openai' | 'anthropic'
  | 'gemini' | 'ollama' | 'huggingface' | 'perplexity' | 'openrouter';
type CliKind = 'cli-codex' | 'cli-grok';
type ConnectionKind = ApiKind | CliKind;
type StructuredOutputSupport = 'json_schema' | 'json_object' | 'none' | 'unknown';

interface Connection {
  id: string;
  kind: ConnectionKind;              // explicit; never inferred from the label at runtime
  label: string;                     // display only
  presetId?: string;
  baseUrl?: string;                  // API kinds
  apiKeyRequired?: boolean;          // false allowed for local endpoints
  structuredOutput?: StructuredOutputSupport;   // detected by Test, persisted
  maxConcurrency?: number;           // defaults below
  timeoutMs?: number;
}

interface ModelProfile {
  id: string;
  connectionId: string;
  model?: string;                    // optional for CLIs (CLI default)
  label: string;
  options?: { reasoningEffort?: CodexReasoningEffort; maxOutputTokens?: number; temperature?: number };
  enabled: boolean;
}

type AiTask = 'interpret' | 'edit' | 'translate' | 'reading' | 'explain';
```

- **Resolver:** `resolveProfile(task)` returns `taskProfiles[task] ?? defaultProfileId`. It validates the enabled state, that the connection exists, browser support for the kind, and whether a credential is present on this device. It is the only resolver, and it returns a typed `AiError` when it cannot resolve.
- **Codex settings:** the Codex model and effort move to `ModelProfile.model` and `options.reasoningEffort`. Two Codex profiles with different efforts can then serve different tasks.
- **Browser gating:** `cli-*` kinds are available only where Native Messaging exists. Firefox has no `nativeMessaging` permission. Safari has `sendNativeMessage` only, so it has no cancel and no heartbeat. Settings hides **Add local CLI** where it is unsupported, and the resolver returns `host-unsupported`.

### Storage layout (D1)

- **Sync**, one key per concern to stay under the per-item quota:
  - `ai_connections`
  - `ai_profiles`
  - `ai_routing` (`defaultProfileId`, `taskProfiles`, `responseLanguage`)
  - `ai_interpreter` (enabled, autoRun)
  - `ai_prompt_context` (the potentially large default prompt context)
- **Local**, never synced:
  - `ai_credentials`: `{ [connectionId]: apiKey }`
  - `ai_migration`: per-device migration state
  - `storage.local` is still plaintext on disk. Moving keys there stops them going to sync servers and relieves the quota. It is not encryption, and the docs will say so.
- There is one `AI_SETTINGS_DEFAULTS`, and a schema-driven codec replaces the hand-copied fields in `loadSettings` / `saveSettings` (`storage-utils.ts:230-323`).
- Connection cards show **Key missing on this device** when a synced connection has no local credential.

## Migration

Two rules shape the migration: **one writer at a time**, and **a per-device migration flag**.

- **Before Phase 5:** nothing persists v2. A derived v2 view is computed from v1 at load time. The old Settings UI, the popup model select, and `setExecutionMode` keep writing v1, so the two never diverge.
- **In Phase 5:** the new AI Settings section becomes the sole writer, and the persisted migration ships with it.
  1. Each device migrates independently. The flag is `ai_migration` in `storage.local`, not the synced `migrationVersion` (`storage-utils.ts:130,193-195`).
  2. Migration is idempotent:
     - It builds v2 sync keys from v1 `interpreter_settings`, but only if they are absent. Otherwise it reuses the v2 data another device already wrote.
     - It copies `providers[].apiKey` from the still-present v1 key into local `ai_credentials`, matched by connection id.
  3. `kind` is inferred once and persisted:
     - First by catalog `presetId`.
     - Then by baseUrl host (`api.anthropic.com`, `generativelanguage.googleapis.com`, `openai.azure.com`, `:11434`, …).
     - Only then by the legacy name heuristics.
  4. The CLI mode (`grok` / `codex`) becomes a CLI connection plus a profile that carries the Codex model and effort, and that profile becomes the default. Otherwise the default is the old `interpreterModel`.
  5. `readerSettings.learningResponseLanguage` is copied to `responseLanguage`.
- **Later release:** v1 keys (including synced API keys) are deleted in a separate, later release, after a bootstrap window long enough for every device to migrate. That deletion is the only step that cannot be rolled back.

The migration is pure and has fixtures for every legacy shape, two-device interleavings, and an old build writing v1 after a new build has migrated.

## Execution architecture

```
Popup / Reader / Settings (UI)
  └─ ai/client.ts: start(task, input) → jobId; attach(jobId, {onProgress, onResult}); cancel(jobId); test(connectionId)
       └─ runtime Port 'ai'  (reconnects and reattaches by jobId on disconnect)
            └─ background ai/gateway.ts (stateless executor)
                 ├─ resolveProfile(task)
                 ├─ JobRunner (durable job record + checkpoints in storage.session)
                 └─ adapters/
                      ├─ openai-compatible / anthropic / gemini / ollama / azure / hf / perplexity
                      └─ native-cli (Codex / Grok via Native Messaging, Host protocol v5)
```

### MV3 service-worker lifetime

Chrome terminates the worker in three cases:

- after 30 s of idle;
- when one event runs longer than 5 min;
- when a `fetch` response takes longer than 30 s to arrive.

A Codex run is up to 120 s of silence on the native port, because the Host replies only when it exits (`obsidian-clipper-host.mjs:217-233`). Workers therefore must not hold job state in memory. Six rules follow:

1. **Durable jobs.**
   - Each job is a record in `storage.session`: `jobId`, task, checkpoint identity, group status, and attempts.
   - A checkpoint is written after each completed group.
   - When a worker starts, or a client reattaches, the job resumes from its incomplete groups.
2. **Reattach is the normal path.**
   - The UI holds a Port and treats `onDisconnect` as "reconnect and `attach(jobId)`", not as a failure.
   - Jobs are keyed by checkpoint identity: scope, target language, and a segment hash. Profile is not part of the key, so switching engines mid-job (an existing feature) still reuses checkpoints.
3. **Streaming.** HTTP adapters use `stream: true`, so bytes arrive early. This keeps `fetch` alive and gives `edit` and `explain` streamed text.
4. **Host protocol v5** adds:
   - periodic `heartbeat` / `progress` messages, so port traffic keeps the worker alive;
   - an optional output schema (`codex exec --output-schema`);
   - a `host-outdated` handshake.
5. **Disconnect policy per task.**
   - `interpret`, `edit`, and `explain` are cancelled when their UI Port closes.
   - `translate` and `reading` continue to checkpoint, and can be resumed or reattached.
6. **Safari** uses `sendNativeMessage`, so it has no heartbeat and no cancel. Safari CLI jobs run with one group per message and are documented as non-cancellable.

### Adapters and tooling

- **Adapter contract:**
  - `buildRequest`
  - `parseStream` / `parse`
  - `classify → AiError`
  - `capabilities` (structured output, streaming, model listing)
  - Adapters are DOM-free and statically imported into the service worker (the MV3 invariant).
- **Popup Interpreter on the gateway.** The Interpreter moves onto the gateway and gains cancel and structured errors. The v1 60 s cooldown is removed (Phase 2 plan, decision 4): it was per-popup module state and the Interpret button is disabled after any result, so it never applied. autoRun remains an explicit opt-in setting.
- **CLI argv** has one implementation, `native-host/cli-invocation.mjs`, which takes `command` as a parameter. The Host resolves the command from `config.json`, and `src/cli.ts` resolves it from `PATH`. `src/cli.ts` gains `--model` and `--effort`. Type checking needs a `.d.ts` for the `.mjs` (or `allowJs`). `cli-execution.ts` is deleted. The API build (`src/api.ts`) imports no AI code and is unaffected.
- **Test (D3)** is an explicit click only:
  1. A free check comes first: model listing for OpenAI-compatible, Anthropic, Gemini, and Ollama validates the key and the model id.
  2. A 1-token completion is used only for kinds without a listing (Azure, Hugging Face, Perplexity), or to probe structured-output support. The UI shows a cost note when it does this.
  3. For CLIs, Test runs the Host health check plus a minimal `exec` that validates the model and the effort.
  4. The result is persisted as a connection status: Untested, OK, or Failing with a reason.
- **Diagnostics.** A redacted ring-buffer job log in `storage.session` is shown under Settings → AI → Diagnostics. It records task, connection kind, duration, error code, and HTTP status. It never records content or keys.

## Errors

```ts
type AiErrorCode =
  | 'not-configured' | 'credential-missing' | 'auth' | 'model-unavailable'
  | 'rate-limited' | 'quota' | 'timeout' | 'network'
  | 'host-missing' | 'host-outdated' | 'host-unsupported' | 'cli-not-authenticated'
  | 'bad-response' | 'incomplete' | 'cancelled' | 'provider-error';
interface AiError { code: AiErrorCode; retryable: boolean; connectionId?: string; status?: number; detail?: string }
```

- Adapters classify every error into one of these codes. The UI never parses message text.
- `describeAiError(error)` maps each code to `{title, body, action}` using i18n keys `aiError.<code>.title` and `aiError.<code>.body`, in English and zh_CN. Each action is one of:
  - `openSettings(connectionId)`
  - `retry`
  - `continueRemaining`
  - `copyInstallCommand`
  - `switchProfile`
- Cancellation is `code: 'cancelled'` end to end.

## Output contracts

| Task | Contract |
| --- | --- |
| `interpret` | JSON object keyed by prompt variable, parsed to `{ responses, missing }`: the answered keys, plus the requested keys the reply left out, in prompt order (`replacePromptVariables` only needs `key`) |
| `edit`, `explain` | text, streamed |
| `translate` | `{ id: number, text: string }[]` |
| `reading` | aligned token arrays keyed by segment id |

Structured output is selected by the connection's detected capability:

| Provider | Mechanism |
| --- | --- |
| OpenAI-compatible | `response_format: json_schema`, else `json_object`, else none |
| Anthropic | forced tool use with `input_schema` |
| Gemini | `responseSchema` (OpenAPI subset, no `additionalProperties`) |
| Ollama | `format: <schema>` on ≥ 0.5, else `'json'` |
| Codex | `--output-schema` via Host v5 |
| Grok | none |

- **Fallback.** A `400` that mentions `response_format` / schema triggers one fallback to prompt-schema plus the tolerant parser, and the connection is downgraded to `none`. This is a documented, non-billable correction, separate from the D4 retries.
- **No envelope.** The `prompts_responses` envelope and the regex quote repair are removed. The extension prompt, the Host prompt, and `src/cli.ts` change in the same commit. `parsePromptResponses` already accepts a bare keyed object.
- **Validation.** A response that fails validation is `bad-response` or `incomplete`. It is never partially accepted as complete, which keeps the transcript alignment invariant. An `interpret` reply that answers some keys returns them with `missing` set. The Interpreter fills in the answers, leaves the missing prompts as placeholders, and shows a partial state instead of done. `src/cli.ts` cannot mark a missing prompt, so it rejects a partial reply as `incomplete`. A reply that answers no key is `bad-response`.

## Long jobs

`JobRunner` is the single implementation for `translate`, `reading`, and future batch tasks.

- **Segments and groups.** Segments keep stable numeric ids, and each segment is atomic. The character budget per group comes from the connection kind or profile, not from UI modules. That removes the per-mode limits hard-coded in `transcript-language-learning.ts:489,740` and `language-learning-runtime.ts:29-30`.
- **Concurrency (D2).**
  - Default `maxConcurrency` is 3 for hosted APIs, 1 for Ollama, and 1 for CLIs. Each connection can override it.
  - The runner owns one in-memory result state per job, and checkpoint writes are serialized. Today's stores overwrite the whole array on each save (`language-learning.ts:313,368`), so unserialized concurrent writes would lose results.
  - The AGENTS.md invariant becomes: "bounded concurrent groups with stable ids and serialized checkpoint writes".
- **Retry policy (D4).**
  - API `429`, `500`, `502`, `503`, `504`, and `529`: up to 2 automatic retries per group, honoring `Retry-After`, with jitter. Cancellation short-circuits the backoff, and the retries are capped by a per-job budget so a 429 storm cannot fan out.
  - API timeout: never retried automatically, because it may already be billed.
  - CLI timeout: automatic split-and-retry down to a floor, as shipped today.
  - All other errors stop the job and leave it resumable.

## Settings UX

A single **AI** section replaces the AI parts of Interpreter and the Reader language-learning model settings.

1. **Connections:** cards with a status badge and a **Test** button.
   - **Add API provider** opens a catalog picker.
   - **Add local CLI** shows an inline install command and Test, and is shown only where the browser supports it.
2. **Models:** profiles grouped under their connection, with model id, effort (Codex), and an enabled toggle.
3. **Task routing:** a task → profile table, with Default at the top.
4. **Language:** response language.
5. **Interpreter:** enable, auto-run, and default prompt context.
6. **Diagnostics:** the recent job log.

The provider catalog is bundled from this repository's `providers.json`. The upstream fetch and its three cache layers are removed, along with the hard-coded DeepSeek override.

## Module layout

```
src/ai/
  types.ts  settings.ts  migrate.ts  resolve.ts  catalog.ts
  contracts.ts  errors.ts  errors-ui.ts  diagnostics.ts
  adapters/*.ts  gateway.ts  job-runner.ts  job-store.ts  client.ts
native-host/cli-invocation.mjs (+ .d.ts)
src/settings/ai/*.ts          AI settings section, split by panel
src/reader/learning/*.ts      transcript learning: controller, view, state
```

`language-learning.ts` keeps pure prompt construction and alignment behind the contracts (AGENTS.md seam). Old modules are deleted in cleanup, not kept as shims. The AGENTS.md seam table, `docs/Language learning.md`, and `docs/development/Language learning MVP.md` are updated in the same phase as each behavior change.

## Phases

Each phase merges with green tests, type check, three browser builds, and bundle-boundary checks.

1. **Domain core:**
   - types, `resolveProfile`, and the derived v2 view over v1 storage;
   - `AiError` with its `describeAiError` keys (en and zh_CN).
   - Everything is pure and test-first. Nothing new is persisted.
2. **Gateway:**
   - the Port protocol with jobId and attach from day one;
   - explicit-kind adapters with streaming;
   - Host protocol v5 (heartbeat, `host-outdated`) and the shared `cli-invocation.mjs`.
   - Language learning moves onto the gateway first, then the popup Interpreter. A mock-provider e2e lands in `scripts/extension-e2e.mjs`.
3. **Output contracts:** capability detection (with Test's probe as a stub), and removal of the envelope across the extension, Host, and `src/cli.ts`.
4. **JobRunner:**
   - durable job store, serialized checkpoints, concurrency, retry policy, and reattach;
   - an e2e that kills the worker (`ServiceWorker.stopWorker`) mid-translation and still completes.
   - The `transcriptCheckpointStorage` bridge (`background.ts:525-562`) is deleted.
5. **Settings AI section:**
   - it becomes the sole writer, together with the persisted per-device migration;
   - per-key sync layout, credential move, browser gating, Test, and Diagnostics.
6. **UI unification:** a shared action controller and error card, and the split of `transcript-language-learning.ts`.
7. **Cleanup:** removal of v1 code paths, `cli-execution.ts`, and duplicate defaults. The deletion of v1 *storage keys* ships as a separate, later release.

Phases 4 and 5 carry the most risk.

## Decisions (accepted 2026-10-19)

- **D1:** API keys move to non-synced local storage, with a per-device bootstrap import and a "key missing on this device" badge.
- **D2:** API transcript groups run concurrently (hosted default 3, Ollama 1, CLI 1), with serialized checkpoint writes. This replaces AGENTS.md's sequential-requests invariant.
- **D3:** Test is explicit, with free checks first and a minimal billable request only where needed.
- **D4:** Automatic retries for API `429` / `5xx` (max 2 per group, per-job budget). API timeouts are not retried.
