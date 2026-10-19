---
description: Architecture, invariants, verification, and known limitations for the Web Clipper language-learning MVP.
---
This document describes the implemented language-learning MVP and the interfaces that must remain stable when it evolves.

## Goals

- Let users revise selected or complete clipped Markdown through a preview-and-apply workflow.
- Add manually triggered, segment-aligned bilingual YouTube transcripts and Chromium/Firefox in-page Bilibili transcripts.
- Add manually triggered hiragana readings for Japanese kanji in YouTube and Bilibili transcripts.
- Let users correct generated Japanese readings directly in the Reader.
- Let users correct generated translations and persist both correction types for the browser session.
- Explain a double-clicked word or a selected phrase or sentence in transcript context.
- Let users favorite explanations locally, copy them, or save them to Obsidian.
- Add local sentence-repeat, A–B loop, auto-pause, speed, and keyboard study controls.
- Manage saved vocabulary and personal Japanese readings in a persistent Learning Center.
- Reuse the existing Interpreter provider, model, and credential configuration, or use the configured local Grok/Codex CLI execution mode.
- Keep every remote action explicit so the extension does not create surprise model costs.

## Non-goals

- Automatically translating every transcript on load.
- Permanent transcript or explanation history across browser sessions.
- Flashcard scheduling or spaced repetition.
- Adding a second provider configuration system for language learning.
- Token-level response streaming.

## Module map

| Module | Interface and responsibility |
| --- | --- |
| `src/utils/language-learning.ts` | Pure `LanguageLearningAssistant` interface for content transformation, selection explanation, aligned transcript translation, and Japanese readings |
| `src/utils/language-learning-runtime.ts` | `configuredLanguageLearning`, the configured interface used by Popup and Reader callers |
| `src/utils/language-learning-vocabulary.ts` | Persistent vocabulary, clipboard, and Obsidian-note adapters composed into the configured interface |
| `src/utils/language-learning-center.ts` | Search, filtering, bulk actions, import/export, and personal-reading management UI |
| `src/utils/japanese-reading-dictionary.ts` | Pure personal-reading resolution and model-output override logic |
| `src/utils/japanese-reading-dictionary-storage.ts` | Validated, bounded persistent personal-reading storage and import/export |
| `src/utils/language-learning-readiness.ts` | Pure readiness assessment and the Settings setup assistant |
| `src/utils/language-learning-popup.ts` | Popup and side-panel preview, apply, cancel, and undo state |
| `src/utils/transcript-language-learning.ts` | Bilingual and Japanese-reading controls, selection extraction, explanation card, caching, and cleanup |
| `src/utils/transcript-layout.ts` | Pure Reader transcript-layout switching, selected-state semantics, and layout class management |
| `src/utils/reader-transcript.ts` | Player integration and single-click versus double-click seek coordination |
| `src/utils/bilibili-transcript.ts` | DOM-free validation, track selection, and timed-segment parsing for Bilibili player subtitle responses |
| `src/utils/bilibili-page-fetch.ts` | Serializable, deadline-bounded Bilibili subtitle document fetcher |
| `src/utils/bilibili-player-page.ts` | Serializable current-player polling that ignores expired Bilibili request URLs |
| `src/utils/bilibili-reader.ts` | Safe timed Bilibili transcript DOM construction for Reader |
| `src/utils/transcript-study.ts` | Local sentence repeat, A–B loop, auto-pause, speed, and shortcut controller |
| `src/utils/focus-trap.ts` | Shared dialog focus containment, Escape handling, focus return, and cleanup |
| `src/ai/client.ts` | `runAiTask`: one `ai` Port per job, keepalive pings, cancellation, typed `AiError` rejections |
| `src/ai/gateway.ts` | Background job registry: profile resolution from stored settings, adapter dispatch, progress, cancel, and `attach` replay; durable transcript jobs (`start-job`, `checkpoint-get`/`put`/`clear`) and resume on init |
| `src/ai/job-client.ts` | `runTranscriptJob`: one durable job per transcript task, reconnect and `attach`, aligned results; one-round-trip checkpoint helpers for Reader restore and manual saves |
| `src/ai/job-identity.ts` | Pure job ids: cyrb53 segment hash and `job:<task>:<namespace>:<hash>`, shared by client and gateway |
| `src/ai/job-runner.ts` | DOM-free durable transcript runner: group budgets, bounded concurrent pool, serialized checkpoints, 429/5xx retries, CLI timeout splits, resume |
| `src/ai/job-store.ts` | `aiJob:` records and `aiJobInput:` inputs in `browser.storage.session` with an in-memory fallback, per-job serialized writes, pruning, and quota eviction |
| `src/ai/adapters/http.ts` | DOM-free streaming provider adapter shared with Interpreter |
| `src/ai/adapters/native-cli.ts` | Native Messaging adapter for local Grok/Codex execution |
| `src/utils/native-cli-service.ts` | Background Native Messaging bridge for local Grok/Codex execution |
| `src/utils/native-cli-health.ts` | Settings-page client for explicit Host and CLI diagnostics |
| `src/utils/native-cli-install.ts` | Platform-aware Settings guide that builds and copies the one-time Host install command for the current extension ID |
| `src/background.ts` | Registers the AI gateway on the `ai` Port with the session-storage job store, runs its init (resume and legacy-key cleanup), and hosts the Bilibili subtitle bridge |

Bilibili transcript capture is limited to the in-page Reader on Chromium and Firefox. Before Reader removes the live page, the background runs in the page's MAIN world, verifies the current BVID, AID, and CID, waits briefly for the matching player response, and fetches the selected subtitle in that same page context. Expired request URLs are ignored while the polling window remains open. This path does not use Interpreter credentials or create a provider request.

The request path is:

```text
Popup or Reader
  → configuredLanguageLearning
  → runAiTask(task, input), or runTranscriptJob(task, input) for a whole transcript, over the `ai` runtime Port
  → background AI gateway (resolveProfile from stored settings; transcript jobs run groups through job-runner)
  → streaming HTTP adapter or Native Messaging adapter
  → configured Interpreter provider or local CLI
```

The model interface is intentionally small. Popup and Reader know only how to transform content, explain a selection, translate ordered segments, or annotate Japanese readings. The configured runtime adds session-result restore and save through the job client, execution-mode behavior, and the personal-dictionary merge, and composes the separate vocabulary adapter without exposing provider URLs, credentials, request formats, or response parsing rules to Reader DOM code.

## Core interfaces

`createLanguageLearningAssistant(sendRequest, { runJob })` accepts a single-request adapter and a transcript-job runner (`runTranscriptJob` in production) and returns four operations:

- `transformContent(content, instruction)` returns revised Markdown.
- `explainSelection(selection, responseLanguage)` returns a contextual explanation.
- `translateTranscript(segments, targetLanguage, onProgress?, signal?)` runs one job, returns translations in the same order and length as the source segments, and reports batch progress, including retry waits.
- `annotateJapaneseTranscript(segments, onProgress?, signal?)` runs one job, returns source-aligned text/reading tokens for Japanese kanji, and reports batch progress, including retry waits.

This seam is also the primary pure-test surface. Runtime configuration and DOM behavior are tested separately.

## Invariants

### Explicit cost

Remote work starts only after a user invokes an explicit action:

- Selecting **Preview AI edit**.
- Selecting **Bilingual subtitles** before translations exist.
- Selecting **Japanese readings** before readings exist.
- Double-clicking a transcript word.
- Selecting **Explain with AI** for a transcript selection.

Selection changes, YouTube or Bilibili transcript loading, page loading, applying, cancelling, undoing, and show/hide toggles must not create provider requests. Bilibili subtitle retrieval runs through the extension background and uses no Interpreter credentials. Reader controls that run in the page DOM reject synthetic cost-incurring events with `event.isTrusted`. The popup controls run in an extension-owned document that host-page scripts cannot access; their click listener does not separately inspect `event.isTrusted`.

Changing the transcript task range, editing a generated result, revealing a ruby reading, opening saved vocabulary, copying, favoriting, and saving an existing explanation do not create provider requests. Switching execution mode from an error card retries only after a trusted user action.

Playback study controls, Learning Center filtering, local import/export, and personal-dictionary lookup never create provider requests.

### Background-only provider access

Reader can run inside a page context, where cross-origin model requests inherit page restrictions. Callers therefore open an `ai` runtime Port and send a `start` message with a task (`edit`, `explain`, `reading`, or `translate`), context, prompts, and an optional output budget, or, for a whole transcript, a `start-job` message (see [[#Durable transcript jobs]]). The background gateway resolves the profile for that task from stored settings and performs the provider request.

Credentials stay in the existing Interpreter settings. Gateway messages never contain a provider URL or API key. API requests stream (SSE for OpenAI-compatible, Azure, Anthropic, Hugging Face, and Perplexity; NDJSON for Ollama) so the MV3 service worker keeps receiving data; a request fails with a retryable `timeout` after 60 seconds without data or five minutes in total. The client pings the Port every 20 seconds while a job is pending. While any job is unfinished, the gateway also calls an extension API every 20 seconds, because a pending `fetch` alone does not keep the service worker alive. When the caller disconnects, `interpret`, `edit`, and `explain` calls are aborted, while a single-call `translate` or `reading` (still accepted for `src/cli.ts` and tests; Reader no longer sends one) finishes and its outcome stays available to `attach` for 60 seconds. A disconnect never cancels a durable transcript job. Gateway errors are `AiError` values with closed codes; the runtime converts them back to the legacy Reader error codes until the Reader card moves to `describeAiError`. In Codex CLI mode, the background resolves `interpreterCodexModel` and `interpreterCodexReasoningEffort` from stored Interpreter settings. Native Messaging protocol v5 carries optional canonical `model` and `effort` values only for Codex, and emits a heartbeat every 10 seconds on Port connections while a CLI runs. The extension and Host both validate effort against `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; the Host passes effort as separate `-c` and `model_reasoning_effort="value"` spawn arguments. A protocol mismatch with an older Host requires reinstalling the Host. Model support is left to Codex CLI, and failures do not trigger fallback. The host only launches the configured `grok` or `codex` executable. Both the extension and Host enforce the optional Codex model's 200-code-unit limit. The Host passes a model override as separate `--model` and model-ID spawn arguments. Grok execution disables built-in tools, web search, plan/subagent behavior, and cross-session memory, uses one turn, and sends the interpreter prompt verbatim.

The same port carries cancellation. The Host maps request IDs to child processes, sends `SIGTERM`, and falls back to `SIGKILL` after two seconds. A separate explicit health request verifies the protocol and configured executable path without including page content; it intentionally does not make a model request. Host errors carry stable codes and optional details so Reader can localize recovery while keeping raw output inside collapsed technical details.

The Settings readiness assistant combines local configuration checks with that explicit CLI health request. API mode is ready only when Interpreter is enabled and the enabled model has a configured provider, base URL, and any required API key. CLI mode is ready only after the selected Host/CLI connection passes its check. On supported Chrome/macOS and Chrome/Linux source builds, Webpack emits local-only `native-host-install.json`; Settings uses it with `browser.runtime.id` to copy a cwd-independent one-time installer command. Release ZIPs exclude that source-path metadata, and the extension never attempts to write or execute a Native Messaging Host from its sandbox.

### MV3-safe network client

`src/ai/adapters/http.ts` must remain DOM-free. The background imports the gateway and adapters synchronously. Do not dynamically import them from the background or generate a runtime-loaded network chunk: Chrome MV3 service workers cannot depend on a new chunk being imported after installation.

The Interpreter uses the same gateway through `runAiTask('interpret', …)`, passing the model selected in the popup as the profile.

### Transcript alignment

Each task has an output contract in `src/ai/contracts.ts`. Transcript segments are sent as JSON `{ "segments": [{ "id", "text" }] }`, where `id` is the segment's global source index. Translations come back as `{ "translations": [{ "id", "text" }] }` and readings as `{ "readings": [{ "id", "tokens": [{ "text", "reading" }] }] }`. The contract keeps only items whose id was requested in that group, the first answer for each id, non-blank translations, and reading items whose token texts reproduce the source segment with a reading on every kanji token, and the result is placed back at that index. Model reordering therefore cannot change subtitle timing, and an unsolicited id cannot overwrite a checkpoint from an earlier group. A reply with no usable item is a `bad-response` error: the job stops with completed groups checkpointed, and retry continues with the missing segments.

Where the connection supports it, the provider enforces the shape: OpenAI-style `response_format` (`json_schema` for `api.openai.com` and Azure, `json_object` for other compatible servers), a forced Anthropic tool call, an Ollama `format` schema, or Codex `--output-schema`. Hugging Face, Perplexity, and Grok rely on the prompt rules and a tolerant parser that accepts a fenced or prose-wrapped JSON object. If a provider answers HTTP 400 or 422 naming the structured-output parameter, or a Codex CLI rejects `--output-schema`, the gateway retries once without it. Only when that retry succeeds does it remember the downgrade per connection and base URL in `storage.local` (`ai_structured_output`). The parser picks the reply list with the most valid requested items, so an echoed shape example does not win, and it salvages complete items from a reply cut off by the output limit. Reading groups default to 2,500 prompt characters because token objects cost several output tokens per source character. `edit` and `explain` return plain text and never request structured output.

Prompt groups target a character-count limit, measured on each segment's JSON form plus the instruction, and run in a bounded concurrent pool. Each source segment remains atomic, so one segment longer than the limit can produce an oversized group. Translation groups target 6,000 characters for every connection kind. Japanese reading groups target 2,500 characters for API and Codex CLI connections and 1,600 in Grok CLI mode, because their aligned output is substantially larger than the source and Grok was observed timing out on the larger grouping. After a CLI timeout, the runner halves the group budget for that job, down to 1,200 characters for translations and 600 for readings; the intermediate timeout is not surfaced in Reader. A blank source segment (an empty one for readings) counts as complete and is never requested. The Reader UI accepts the result only when the returned array length matches the source length and every segment with source text has a value. Otherwise, it displays an error and keeps the action retryable.
Japanese reading tokens are `{ text, reading }` objects, because strict schemas cannot express tuples; the parser still accepts `[text, reading]` tuples from older prompts. Because the `reading` contract drops incomplete or misaligned items, they count as missing before ruby elements are committed to the DOM; `language-learning.ts` re-exports `isCompleteTranscriptReadings` to validate restored readings. The reading output budget is five times the source characters, between 2,000 and 16,000 tokens; a translation group asks for 1.2 times its source characters plus 15 tokens per segment, between 1,600 and 8,000 tokens.

For a transcript classified as non-Japanese, Reader runs fixed-target `Japanese` translation before reading annotation. Explicit `ja`/`jpn` language tokens take precedence over the kana fallback. Ordinary translations, Japanese translations, and readings have independent job identities. Restore loads the Japanese translation before readings keyed by that exact Japanese text; missing state never triggers a request. Translation must be complete and aligned before annotation begins.

Translation batches report `completed`, `total`, and an aligned partial translation array; Japanese reading progress additionally reports `completedSegments`, `totalSegments`, and aligned partial token arrays. While a group waits to retry, progress also carries `retry: { delayMs, attempt }`, which Reader shows as `readerTranscriptRetrying` until the next progress. Reader merges a selected task range back into the full transcript and renders completed segments immediately while preserving stable source indexes.

Every finished group is checkpointed by the background job, so the next explicit try sends only incomplete or invalid segments (see [[#Durable transcript jobs]]). The job identity covers the task, the response language where applicable, and the exact ordered task text, but not the profile, so an explicit execution-mode switch sends the next engine only incomplete segments. Toggle actions await an in-progress local restore before deciding whether work is missing, preventing an immediate click from racing the restore into a duplicate paid request. Reader may restore a result when the saved bilingual or Japanese-reading visibility preference is enabled; only a `completed` record is restored, and a missing, running, or incomplete record never triggers an automatic provider request. Translation and ruby edits update the record without making a model request.

For non-Japanese source text, Reader keeps the original subtitle and ordinary bilingual translation unchanged and renders validated Japanese reading tokens in a separate `.transcript-segment-japanese` line. One trusted action owns both stages, which run one after the other, and one cancellation signal stops whichever stage is active. A completed Japanese translation is reused when annotation fails, is cancelled, or is regenerated; **Regenerate readings** clears only the readings job record.

Page-owned AI controls expose a compact task bar with engine, selected segment count, approximate batch count, elapsed time, progress, and a visible cancel action. The range selector supports the active segment, the next five minutes, or the full transcript. Failed transcript requests remain retryable through the error card, which reports completed work, offers an explicit execution-mode switch, and keeps raw error text collapsed. Japanese readings additionally expose an explicit regenerate action because a corrected or context-sensitive reading may require a fresh model request. Editable translations and ruby readings use textbox semantics and labels; non-editing ruby elements support keyboard hide/reveal practice. Dialogs make their background siblings inert, trap focus, close with Escape, restore focus, and release inert state during SPA cleanup.

Manual ruby corrections are also written to a persistent personal dictionary. Before generating readings, the configured runtime resolves known surfaces locally and sends only segments with unresolved kanji. Personal entries override matching model tokens. If every kanji occurrence in the requested range is known, the runtime returns aligned tokens without loading a configured assistant or sending a background request.

### Durable transcript jobs

A whole transcript task (`translate` or `reading`) runs as one durable job in the background. `runTranscriptJob` computes the job id `job:<task>:<namespace>:<hash>` from the task, the identity namespace, and a cyrb53 hash of the identity scope and ordered segment texts, then sends `start-job` with the instruction, segments whose ids equal their index, and the identity; the message carries no credentials. The gateway recomputes the id and answers `Invalid AI request.` on a mismatch. One job accepts up to 20,000 segments and 1.5 million characters; the namespace is at most 100 characters and the scope at most 500. A `start-job` for a running id attaches to it instead of duplicating work. For a stored record of the same transcript, it reuses the accepted results and plans only the missing ids, which is how **Continue remaining** works.

The runner dispatches groups in source order while fewer than `maxConcurrency` are in flight: `Connection.maxConcurrency` when set, otherwise 3 for hosted APIs and 1 for Ollama and CLI kinds. The connection and its concurrency are re-resolved before each dispatch, so a model or key change applies at the next group. Progress (`job-progress` deltas) is emitted in source order even when a later group finishes first. After each group, the runner merges the accepted items into the record and queues a whole-record write; the store serializes writes per job, so concurrent groups cannot lose updates. A 20-second heartbeat refreshes `updatedAt` while the job runs. A fatal group error stops dispatch, lets in-flight groups finish and checkpoint because they are already billed, and ends the job `failed`. A job ends `completed` when every segment has a result, and `incomplete` when every group finished but the model omitted or the contract rejected some ids; the runner never re-requests those on its own.

Each group retries `rate-limited` (never `quota`) and `provider-error` with status 500, 502, 503, 504, or 529, up to 2 times, within a per-run budget of `min(8, 2 + floor(groups / 2))`. The delay is `min(30 s, 1 s × 2^(attempt − 1)) × (0.5 + random())` and never shorter than the provider's `Retry-After` (seconds or an HTTP date, parsed by `http.ts` into `AiError.retryAfterMs`); a `Retry-After` longer than 60 seconds is not retried. Each wait sends `job-retry`, and cancel aborts the wait without another request. `timeout`, `network`, and every other error are never retried for API kinds. On a CLI `timeout`, the runner halves the CLI group budget (not below the floors above, at most 3 times per run), persists it as `cliPromptChars`, and re-plans the remaining ids; **Continue remaining** keeps the reduced budget. When no split is left, the job fails with the timeout, which the runtime maps to the retryable `readerTranscriptTranslationBatchFailed` card once the run has split.

Records live under `aiJob:<jobId>` and each job's input under `aiJobInput:<jobId>` in `browser.storage.session`; without session storage the store falls back to memory for the worker's lifetime. The store keeps 20 records, pruning by `updatedAt` and skipping `running` records unless more than 20 run, and a quota error evicts the oldest non-running record and retries the write once. Gateway init removes the Phase 3 `languageLearningTranscriptCheckpointV1:*` keys without migrating them.

Reader restore sends `checkpoint-get`, which only reads: it never starts, resumes, or attaches to a job. Manual translation and ruby corrections send `checkpoint-put`, whose items are validated by the task contract and stored as `completed` or `incomplete`; it is refused while that job runs. `checkpoint-clear` cancels and removes a job. Restore and saves do not require Interpreter to be enabled. When the Port disconnects, the client reconnects after 250, 500, 1,000, 2,000, and 4,000 ms and sends `attach`, which replays a full `job-state` snapshot; after five failed reconnects it rejects with `network` while the job keeps running. The gateway keepalive covers active durable jobs. On gateway init, `running` records updated within `RESUME_WINDOW_MS` (10 minutes) resume from their missing ids and older ones become `incomplete`; `completed`, `incomplete`, `failed`, and `cancelled` records never resume automatically. An `attach` or `start-job` for a `running` record with no live job resumes it at once, and resume is idempotent, so init and an early `attach` cannot run a job twice. With Safari's message-based Native Messaging, cancel stops dispatch but cannot abort the in-flight CLI request; its late result is still checkpointed.

### Safe content application

An AI-edit preview records the full source value and replacement range. Apply succeeds only when the current note-content value still equals that source snapshot. Replacement updates only the selected range, and undo restores the pre-apply value once.

### Language resolution

The response language is resolved for every action in this order:

1. Trimmed `readerSettings.learningResponseLanguage`.
2. `navigator.language`.
3. `English`.

Preset instructions may contain `{{responseLanguage}}`; the runtime resolves the token before sending the instruction.

## Reader interaction details

- The Reader exposes **Reading**, **Study tools**, and **Split view** layouts. The selected mode is stored in `readerSettings.transcriptLayout`; the internal `notebook` value remains stable for stored-setting compatibility. Switching modes moves the existing controls without recreating transcript, translation, reading, or explanation state and never sends a provider request.
- Study tools and Split view use wider Reader content widths on desktop and fall back to the single-column reading flow below the responsive breakpoint.
- Reading exposes a persisted compact-player toggle. It changes only layout visibility, so the existing media element and playback position remain intact. Compact-player, bilingual-subtitle, and Japanese-reading visibility preferences share the Reader settings object and can also be configured from Settings.
- Primary transcript actions—including bilingual subtitles and Japanese readings—stay visible while pinning, scrolling, highlighting, range, vocabulary, and playback-study controls live under a closed-by-default **More** disclosure. At 768 pixels and below, the primary actions keep 44-pixel touch targets and that disclosure becomes a modal bottom drawer; opening it adds transcript clearance and centers the active line. At 480 pixels and below, the open drawer temporarily collapses the existing player and limits its own height so controls and the active segment remain usable without recreating media. The drawer traps focus, supports Escape and backdrop close, restores focus to its trigger, locks page scrolling, and cleans up its listeners and temporary DOM state.
- Original segment text is captured before translations are appended.
- Japanese readings are rendered as ruby elements only after the explicit **Japanese readings** action; the original text remains selectable and can be toggled back to its unannotated form.
- **Edit translations** and **Edit readings** put generated output into labeled content-editable controls. Corrections do not create a provider request and are written to the session job record through `checkpoint-put`.
- A non-editing ruby token is a keyboard-operable disclosure control. Its click is excluded from transcript seeking.
- Explanation cards expose trusted favorite, copy, and Obsidian-note actions. Favorites are validated, capped at 500 entries, and stored in `browser.storage.local`; model output is still inserted only with `textContent`.
- The Learning Center validates imported vocabulary and personal-reading entries, caps their local stores, and exposes search, filtering, bulk actions, import/export, and clear-all without provider access.
- **Study** controls use only the existing player adapter. Sentence repeat, A–B, auto-pause, speed, and shortcuts are independent from language-model state.
- Cross-segment selections find both range endpoints and build context from every covered source segment. CJK selections use sentence punctuation, common polite endings, and a shorter word-length limit so unspaced Japanese sentences do not default to the word prompt.
- Word and sentence explanations are cached by response language, selection kind, selected text, and context for the current wired transcript.
- An `AbortController` removes document and transcript listeners when Reader content changes.
- SPA cleanup removes the selection action and explanation card even when navigation lands on content without a transcript.
- The transcript click guard delays a normal seek and can restore the original playback time when a slower operating-system double-click arrives after that delay.

## Error behavior

| Condition | Result |
| --- | --- |
| Interpreter disabled | Localized configuration error; no request is sent |
| No enabled model | Localized model error; no request is sent |
| Empty model response | Preview or explanation reports an empty response |
| Incomplete transcript response | Completed aligned segments remain visible and checkpointed; the user can continue missing segments |
| Clipping changed after preview | Apply is rejected and the preview is cleared |
| Provider request failure | The background returns an error for the calling UI to display; a transcript group first retries a rate limit or transient 5xx automatically |
| Provider request timeout | The background aborts the request after 60 seconds without data or five minutes in total and returns a retryable timeout error. A transcript job never retries an API timeout; a CLI timeout halves the remaining groups up to three times before failing. Completed groups stay checkpointed for **Continue remaining** |
| Native Host protocol/configuration failure | Reader shows a localized recovery message, collapsed technical detail, retry, and explicit engine switch; Settings health check reports the exact Host/CLI seam |
| Final response parsing failure | The LLM client returns an empty response set; callers display an empty- or incomplete-response error |
| Reader SPA navigation | Old controls, cards, and listeners are cleaned up |

## Security and privacy

- The host page cannot trigger paid actions through synthetic clicks or double-clicks.
- Content scripts have no session-storage bridge; Reader reads and writes transcript results only through `checkpoint-*` messages on the `ai` Port, which the gateway validates against the job id and task contract. Provider credentials and unrelated session data remain inaccessible.
- Model credentials are resolved from extension storage only in the background/client path.
- Model output is inserted with `textContent`, not interpreted as HTML.
- The feature does not add telemetry or send requests to an Obsidian-owned intermediary.
- Provider terms, retention, privacy, and pricing still apply to every request.
- Firefox declares `websiteContent` as required transmitted data because an explicit language-learning action can send clipping or transcript content to the configured provider. Granting the permission does not start a request. The disclosure requires Firefox 140 or newer on desktop and Firefox for Android 142 or newer.

## Verification

Focused coverage lives in:

- `src/utils/language-learning.test.ts`
- `src/utils/language-learning-runtime.test.ts`
- `src/utils/language-learning-center.test.ts`
- `src/utils/language-learning-readiness.test.ts`
- `src/utils/japanese-reading-dictionary.test.ts`
- `src/utils/native-cli-health.test.ts`
- `src/utils/native-cli-service.test.ts`
- `src/utils/language-learning-popup.test.ts`
- `src/utils/transcript-language-learning.test.ts`
- `src/utils/reader-transcript.test.ts`
- `src/utils/bilibili-transcript.test.ts`
- `src/utils/bilibili-page-fetch.test.ts`
- `src/utils/bilibili-player-page.test.ts`
- `src/utils/bilibili-reader.test.ts`
- `src/utils/transcript-study.test.ts`
- `src/utils/transcript-layout.test.ts`
- `src/ai/adapters/http.test.ts`
- `src/ai/gateway.test.ts`
- `src/ai/client.test.ts`
- `src/ai/job-identity.test.ts`
- `src/ai/job-store.test.ts`
- `src/ai/job-runner.test.ts`
- `src/ai/job-client.test.ts`
- `src/utils/i18n.test.ts`
- `src/utils/storage-utils.test.ts`
- `src/utils/focus-trap.test.ts`
- `src/previews/png-visual-diff.test.ts`
- `src/manifest.test.ts`
- `src/webpack-config.test.ts`
- `native-host/obsidian-clipper-host.test.ts`

Run the complete verification gate with:

```sh
TZ=America/Los_Angeles npm test
npx tsc --noEmit --module es2020
npm run build
npm run test:bundle-boundaries
npm run test:bundle-size
npm run build:cli
npm run build:api
npm run test:transcript-preview
npm run test:e2e:chrome
npm run test:e2e:firefox
npm run test:package:safari
git diff --check
```

`npm run preview:transcript` builds and serves the deterministic transcript layout at `http://127.0.0.1:4173/`. `npm run test:transcript-preview` verifies runtime-ready, selected-layout, responsive-control, touch-target, and horizontal-overflow markers in headless Chrome, then compares dimension-checked captures for Reading, Study tools, and Split view at 1440×1000 plus closed and open-control Split view states at 768×900 and 390×844 against the PNG baselines in `tests/visual/transcript/`. The default per-pixel change limit is 0.25%. Use `npm run update:transcript-preview` only after reviewing an intentional visual change. Each open mobile state is produced by opening, closing, and reopening **More**; the gate waits for two painted frames and rejects the capture unless the drawer is inside the viewport and the active segment remains between the sticky controls and drawer.

Reader extraction, syntax highlighting, Markdown conversion, language-learning code, Popup learning controls, and Settings Interpreter management are lazy chunks. Injected Reader chunks use native module imports with an extension URL established by `extension-public-path.ts`, so they execute inside the content-script isolated world instead of registering a JSONP callback in the host page. Generated chunks and runtime locale files are web-accessible, while `background.js` remains a synchronous MV3 service-worker entry with no runtime-loaded network chunk. Webpack cleans each output directory before writing so deleted chunk names cannot survive as stale assets.

`npm run test:bundle-boundaries` enforces those entry/chunk seams for Chrome, Firefox, and Safari. `npm run analyze:bundles` reports raw and gzip sizes, and `npm run test:bundle-size` enforces explicit raw-size budgets. The Chrome E2E gate loads the real unpacked extension through the DevTools Extensions domain, verifies Chinese settings and saved Reader preferences, seeds `completed` `aiJob:` records and their `aiJobInput:` inputs for bilingual subtitles and Japanese readings, opens a fixture tab, and proves that Reader restores both through the `ai` Port without an automatic language-model request. Against a task-aware mock provider, it also stops the service worker (`ServiceWorker.stopWorker`) during a three-group job and checks that the client reconnects and attaches, the job completes with every result, and the first group's ids are requested only once; a second test answers the first request with HTTP 429 and `Retry-After: 1` and checks for a `job-retry` message, a second request for the same ids, and completion. The Firefox E2E gate installs the real temporary extension through WebDriver BiDi and validates the same localization, dynamic-import, preference, and restore behavior. The Safari package gate converts `dist_safari` with Apple's converter, rejects unsupported manifest-key warnings, builds an unsigned macOS container app with Xcode, and checks that the generated extension bundle contains the Reader chunks plus English and Simplified Chinese locale files. Enabling and interacting with the converted Safari extension still requires Safari's normal user-controlled extension approval.

## Known limitations and future seams

- Transcript results persist only for the extension/browser session, and the job store keeps 20 records. Durable study history would require a separately versioned storage policy and migration path.
- A job resumes after a worker restart only when the worker starts again within 10 minutes; nothing (such as `chrome.alarms`) wakes a stopped worker that has no listener. Omitted segments are never re-requested automatically.
- `Connection.maxConcurrency` is honored but not yet set by the v1 settings view, so the defaults apply.
- Japanese readings can still be ambiguous for names or polyphonic kanji. Personal corrections improve repeated terms but do not replace full morphological analysis.
- The response language is shared by translations and explanations. Separate source, translation, and explanation language settings may be added without changing the assistant interface.
- Explanation prompts explicitly require the configured response language for explanation text, labels, and translations.
- The Learning Center is not a spaced-repetition system. Obsidian export uses the configured learning vault and folder.
- Task estimates use source characters and configured prompt-group targets; they are approximate batch counts, not token or billing estimates.
