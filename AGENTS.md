# AGENTS.md

## Scope

These instructions apply to the entire repository. A more specific `AGENTS.md` in a subdirectory overrides this file for that subtree.

## Project overview

Obsidian Web Clipper is a TypeScript browser extension built with Webpack for Chromium, Firefox, and Safari. Source files live in `src/`; local production outputs are generated in `dist/`, `dist_firefox/`, `dist_safari/`, and `builds/` and must not be committed.

Keep changes surgical. Match the existing TypeScript, SCSS, localization, and Obsidian Help Markdown conventions. Do not refactor unrelated code while implementing a feature or fix.

## Important module seams

| Module | Responsibility | Constraint |
| --- | --- | --- |
| `src/utils/language-learning.ts` | Pure prompt construction, text replacement, and response alignment; transcript tasks delegate grouping to an injected `runJob` | No DOM, storage, or browser runtime dependencies; cancellation is `AiError('cancelled')` from `src/ai/abort.ts` |
| `src/utils/language-learning-runtime.ts` | Configured language-learning interface used by Popup and Reader callers | Loads settings and sends model work to the background through `runAiTask`, and whole transcripts through `runTranscriptJob`; Reader restore and manual saves use the job client's checkpoint helpers |
| `src/utils/language-learning-popup.ts` | Popup and side-panel AI-edit UI on the shared action controller; model errors render the shared error card into `#ai-edit-error` | Preview against a source snapshot before applying; Retry reuses the same content, instruction, and snapshot |
| `src/utils/interpreter.ts` | Popup Interpreter UI (the footer AI bar) on the shared action controller: Run, Cancel, the compact shared error card in `#interpreter-error`, `resetInterpreterBar` when the fields are rebuilt, `waitForInterpreter` for Clip; `prompt-chips.ts` shows unfilled prompt properties as chips (display only) | A cancelled run sends no further request, and a Clip that waited on it saves nothing |
| `src/reader/learning/` | Reader transcript learning: `index.ts` wires the features and re-exports the public names; `task-bar.ts`, `card.ts` (learning dialog hosting the shared error card), `translations.ts`, `readings.ts`, `explain.ts`, `selection.ts`; pure `cache.ts`, `japanese.ts`, `readings-render.ts`, `types.ts` | Remote calls follow trusted user actions; one action controller for transcript tasks and one for explanations; cleanup on SPA navigation, including to an article without a transcript |
| `src/utils/reader-transcript-loader.ts` | The Reader's handle on the lazily loaded transcript modules (`reader-language-learning` chunk) | Type imports only; a page that never shows a transcript loads nothing; once loaded, every navigation and `teardownContent` clean up the previous transcript first |
| `src/ai/` | AI domain core: connection kinds, derived v2 settings view, `resolveProfile`, `AiError`, output contracts (`contracts.ts`), structured-output capabilities, Port protocol, transcript job identity (`job-identity.ts`), transcript job limits shared by the runner and the lazy chunks (`job-limits.ts`), cancellation helpers (`abort.ts`), and the shared action controller and error card (`ui/`) | No DOM, storage, or browser runtime dependencies, except `error-messages.ts` (UI-side i18n), `ui/error-card.ts` (DOM only), `client.ts`, `job-client.ts`, `gateway.ts`, and `adapters/native-cli.ts`. See `docs/superpowers/specs/2026-10-19-ai-subsystem-redesign-design.md` |
| `src/ai/adapters/http.ts` | Provider request construction, streaming (SSE, NDJSON, JSON fallback), idle and hard timeouts | Must remain DOM-free and safe in an MV3 service worker |
| `src/ai/adapters/listing.ts` | Model listing for a connection: the listing URL derived from the chat URL, the kind's credential header, `GET` with a timeout, and the parsed model ids | DOM-free; the free first step of a connection Test |
| `src/ai/test-connection.ts` | Connection Test: the per-kind plan (`connectionTestPlan`, whose `billable` drives the cost note), listing, then a structured-output probe or a minimal completion, or the CLI Host health check and one exec per profile; `statusFromTestResult` | Pure over injected adapters and the health check; redacts the credential from error details |
| `src/ai/diagnostics.ts` | Redacted diagnostics log in `storage.session` (`ai_diagnostics`, last 100 entries), serialized writes, memory fallback | Entries are whitelisted: no prompt, content, key, detail, or job id |
| `src/ai/gateway.ts` | Background `ai` Port handler: resolves the profile from stored settings, renders the task contract, runs the adapter with the connection's effective structured-output mode (`effectiveStructuredOutput`), validates the reply, streams progress, cancels, replays outcomes on `attach`; hosts durable transcript jobs (`start-job`, `checkpoint-get`/`put`/`clear`) and resumes recent `running` jobs on init; runs connection Tests (`test`), stores `ai_connection_status`, and records diagnostics | The only place model work executes |
| `src/ai/job-runner.ts` | Durable transcript jobs: group budgets, bounded concurrent pool, serialized checkpoints, 429/5xx retries, CLI timeout splits, resume | Pure with injected store, execute, clock, and timers; statically imported into the background |
| `src/ai/job-store.ts` | `aiJob:` records and `aiJobInput:` inputs in `storage.session` (in-memory fallback), per-job serialized writes, 20-record pruning, quota eviction | Storage area is injected; no browser runtime imports |
| `src/ai/client.ts` | `runAiTask(task, input, options)` for Popup, Settings, and Reader callers; `testConnection(connectionId, options)` for the Settings Test button | Sends keepalive pings while a job is pending; rejects with `AiError`; a Test message carries only the connection id |
| `src/ai/job-client.ts` | `runTranscriptJob` and the `loadTranscriptCheckpoint`/`saveTranscriptCheckpoint`/`clearTranscriptCheckpoint` round trips | Reconnects and re-`attach`es after a disconnect; a restore never starts or resumes a job |
| `src/ai/ui/` | `action.ts`: `createAiAction`, the shared run, cancel, retry, and stale-result controller behind the popup Interpreter, AI edit, and Reader; `error-card.ts`: `renderAiErrorCard` / `clearAiErrorCard`, the shared error card used by the popup, the Reader, and Settings | `action.ts` is pure and never starts a run on its own; `error-card.ts` is DOM-only with no Settings, storage, or browser imports; neither checks `isTrusted`, so page-DOM callers wrap the card handlers |
| `src/settings/ai/` | Settings AI section (lazy `settings-ai` chunk): status card with the master switch, providers with their models and Test, Tasks (default model, response language, per-task routing), Interpreter, Diagnostics | Test starts only from a trusted click and waits for pending saves; never imported by the background |

All model work goes through `runAiTask` or `runTranscriptJob` and the background gateway. Do not call providers or the Native Messaging Host from UI modules, and do not duplicate provider logic outside `src/ai/adapters/`.

## Language-learning invariants

- Never run a paid or remote language-learning request automatically on page load, transcript load, or selection change. A user must explicitly request an edit, translation, or explanation. A transcript job the user started may resume automatically after a service-worker restart only while its record is still `running` and was updated within `RESUME_WINDOW_MS`; a Reader restore (`checkpoint-get`) never starts or resumes a job.
- Page-DOM controls that can create model costs must reject synthetic events with `event.isTrusted`. Every Reader learning-card handler (Retry, Continue remaining, Switch and retry, Open AI settings) and the task bar's Cancel require a trusted click. Programmatic controller methods may exist for isolated tests, but must not be exposed to host-page scripts.
- A connection Test runs only after a trusted click on **Test**. It may send a minimal billable request (a structured-output probe, a 1-token completion, or one CLI exec per profile); show the cost note before it runs whenever the plan has a billable step. Free checks (model listing, Host health) come first.
- Store the detected structured-output mode per device in `ai_connection_status[id].structuredOutput` and, after a Test, on the synced connection (`connection.structuredOutput`). The old `ai_structured_output` cache is removed on gateway init.
- Diagnostics entries hold only the whitelisted fields in `src/ai/diagnostics.ts`. Never add prompts, page content, keys, provider detail, or job ids.
- Execute provider requests in the extension background. Do not fetch model providers directly from Reader or page content scripts.
- Keep the background network path synchronous in the bundle. Do not dynamically import `interpreter.ts` or create a runtime chunk for Chrome MV3 service workers.
- Never pass provider credentials through page DOM or language-learning messages. Resolve the connection, API key, and model profile from stored AI settings (`ai_*` sync items and the local-only `ai_credentials`) in the background.
- Preserve transcript alignment. Every source segment has a stable numeric ID equal to its source index, long transcripts run as one background job in bounded concurrent groups with stable ids and serialized checkpoint writes, and the UI must reject incomplete translations instead of displaying a partial result as complete. Keep each source segment atomic; one oversized segment may exceed the group target.
- Resolve the response language from `ai_routing.responseLanguage` (**AI response language** under **Tasks** in the Settings AI section), then fall back to the browser language.
- AI edits operate on the selected portion of the clipping, or the full clipping when there is no selection. Applying a preview must fail if the source content changed after the preview was generated.
- Run every AI entry point on `createAiAction`: a superseded or cancelled run's late settlement changes nothing, and `cancel` ends the state as `cancelled` at once. Retry re-runs the same request: the same Interpreter input and profile, the same AI-edit content and instruction, or the same transcript range. The Reader task bar's Cancel stops both explanation and transcript work.
- Errors reach the UI as `AiError` carrying `task`, `profileId`, and `recovery`, and are rendered with `describeAiError` through the shared error card. Do not map them back to legacy error codes or copy.
- Clean up Reader controls and listeners during SPA navigation, including navigation from a transcript to an article without one. Explanation caching is session-local and keyed by selection kind, selected text, and context.

## Development workflow

Install dependencies with:

```sh
npm install
```

During implementation, run the closest test file repeatedly:

```sh
npx vitest run src/utils/<name>.test.ts
npx vitest run src/reader/learning/<name>.test.ts
```

Before committing, run:

```sh
TZ=America/Los_Angeles npm test
npx tsc --noEmit --module es2020
npm run build
git diff --check
```

The explicit timezone avoids the repository's timezone-sensitive test behavior. If shared CLI or API code changes, also run:

```sh
npm run build:cli
npm run build:api
```

When changing background imports, provider requests, or Webpack entry behavior, build Chromium separately and verify `dist/background.js` does not depend on DOM APIs or a runtime-loaded network chunk. A real unpacked-extension smoke test is preferred for MV3 changes.

## Tests

- Put pure behavior tests next to the module using `*.test.ts`.
- Use `// @vitest-environment jsdom` only for DOM behavior.
- Test through the same interface used by callers. Inject provider calls or transformation functions instead of making real model requests.
- Cover user-visible state transitions such as preview, apply, cancel, undo, retry, show/hide, and SPA cleanup.
- For transcript changes, include alignment, incomplete-response, long-batch, word-selection, sentence-selection, and cross-segment-selection cases.

## Documentation and localization

- User documentation uses YAML frontmatter, Obsidian callouts, and `[[wikilinks]]` under `docs/`.
- Add new user-facing features to `docs/Introduction to Obsidian Web Clipper.md` so they are discoverable.
- Update `docs/Language learning.md` and `docs/development/Language learning MVP.md` whenever language-learning behavior, limitations, settings, or architecture changes.
- Do not hardcode user-facing UI text. Add message keys to `src/_locales/en/messages.json` and update `src/_locales/zh_CN/messages.json` for this feature. Other locales may use the English fallback until translated.
- Document when an action may send content to a third-party provider or create multiple billable requests.

## Completion criteria

A change is complete only when its focused tests pass, the full suite and type check pass, affected browser builds succeed, documentation and localization are synchronized, `npm run check-strings` reports no more unused strings than the baseline of 86 (most are dynamically built keys the checker cannot see; remove a key only after a grep confirms it is unused), `git diff --check` is clean, and only files required by the task are changed.
