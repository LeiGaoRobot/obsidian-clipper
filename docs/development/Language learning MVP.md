---
description: Architecture, invariants, verification, and known limitations for the Web Clipper language-learning MVP.
---
This document describes the implemented language-learning MVP and the interfaces that must remain stable when it evolves.

## Goals

- Let users revise selected or complete clipped Markdown through a preview-and-apply workflow.
- Add manually triggered, segment-aligned bilingual YouTube transcripts.
- Add manually triggered hiragana readings for Japanese kanji in YouTube transcripts.
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
| `src/utils/transcript-checkpoint-storage.ts` | Bounded, validated transcript checkpoints backed by extension session storage with an in-memory fallback |
| `src/utils/transcript-layout.ts` | Pure Reader transcript-layout switching, selected-state semantics, and layout class management |
| `src/utils/reader-transcript.ts` | Player integration and single-click versus double-click seek coordination |
| `src/utils/transcript-study.ts` | Local sentence repeat, A–B loop, auto-pause, speed, and shortcut controller |
| `src/utils/language-learning-service.ts` | Background validation, stored-model resolution, and local CLI dispatch |
| `src/utils/llm-client.ts` | DOM-free provider adapter and response parser shared with Interpreter |
| `src/utils/native-cli-service.ts` | Background Native Messaging bridge for local Grok/Codex execution |
| `src/utils/native-cli-health.ts` | Settings-page client for explicit Host and CLI diagnostics |
| `src/background.ts` | `languageLearningRequest` message handler and background execution seam |

The request path is:

```text
Popup or Reader
  → configuredLanguageLearning
  → browser.runtime languageLearningRequest
  → background language-learning service
  → DOM-free LLM client or Native Messaging Host
  → configured Interpreter provider or local CLI
```

The model interface is intentionally small. Popup and Reader know only how to transform content, explain a selection, translate ordered segments, or annotate Japanese readings. The configured runtime adds local checkpoint and execution-mode behavior and composes the separate vocabulary adapter without exposing provider URLs, credentials, request formats, or response parsing rules to Reader DOM code.

## Core interfaces

`createLanguageLearningAssistant(sendRequest)` accepts a request adapter and returns three operations:

- `transformContent(content, instruction)` returns revised Markdown.
- `explainSelection(selection, responseLanguage)` returns a contextual explanation.
- `translateTranscript(segments, targetLanguage, onProgress?, signal?)` returns translations in the same order and length as the source segments and reports sequential batch progress.
- `annotateJapaneseTranscript(segments, onProgress?, signal?)` returns source-aligned text/reading tokens for Japanese kanji and reports sequential batch progress.

This seam is also the primary pure-test surface. Runtime configuration and DOM behavior are tested separately.

## Invariants

### Explicit cost

Remote work starts only after a user invokes an explicit action:

- Selecting **Preview AI edit**.
- Selecting **Bilingual subtitles** before translations exist.
- Selecting **Japanese readings** before readings exist.
- Double-clicking a transcript word.
- Selecting **Explain with AI** for a transcript selection.

Selection changes, transcript loading, page loading, applying, cancelling, undoing, and show/hide toggles must not create provider requests. Reader controls that run in the page DOM reject synthetic cost-incurring events with `event.isTrusted`. The popup controls run in an extension-owned document that host-page scripts cannot access; their click listener does not separately inspect `event.isTrusted`.

Changing the transcript task range, editing a generated result, revealing a ruby reading, opening saved vocabulary, copying, favoriting, and saving an existing explanation do not create provider requests. Switching execution mode from an error card retries only after a trusted user action.

Playback study controls, Learning Center filtering, local import/export, and personal-dictionary lookup never create provider requests.

### Background-only provider access

Reader can run inside a page context, where cross-origin model requests inherit page restrictions. Callers therefore send a structured request through `browser.runtime`; the background resolves the stored enabled model and performs the provider request.

Credentials stay in the existing Interpreter settings. Language-learning messages contain context, prompts, and an optional output budget, but never a provider URL or API key. In CLI mode, the background service worker uses Native Messaging protocol version 2 with request IDs over a connected port to `com.obsidian.web_clipper`; the host only launches the configured `grok` or `codex` executable. Grok execution disables built-in tools, web search, plan/subagent behavior, and cross-session memory, uses one turn, and sends the interpreter prompt verbatim.

The same port carries cancellation. The Host maps request IDs to child processes, sends `SIGTERM`, and falls back to `SIGKILL` after two seconds. A separate explicit health request verifies the protocol and configured executable path without including page content. Host errors carry stable codes and optional details so Reader can localize recovery while keeping raw output inside collapsed technical details.

The Settings readiness assistant combines local configuration checks with that explicit CLI health request. API mode is ready only when Interpreter is enabled and the enabled model has a configured provider, base URL, and any required API key. CLI mode is ready only after the selected Host/CLI connection passes its check.

### MV3-safe network client

`llm-client.ts` must remain DOM-free. The background imports it synchronously. Do not dynamically import `interpreter.ts` from the background or generate a runtime-loaded network chunk: Chrome MV3 service workers cannot depend on a new chunk being imported after installation.

`interpreter.ts` re-exports the same network client so the established Interpreter interface remains compatible without duplicating provider logic.

### Transcript alignment

Each source segment is sent as `ID|||text`, where `ID` is its global source index. Responses must use `ID|||translation`. Parsing places each response back into an array at that index, so model reordering cannot change subtitle timing.

Prompt groups target a character-count limit and are sent sequentially. Each source segment remains atomic, so one segment longer than the limit can produce an oversized group. API-mode transcript prompts retain the 6,000-character target. Japanese reading prompts start with a 1,600-character target in Grok CLI mode and a 2,500-character target in Codex CLI mode because their aligned output is substantially larger than the source and Grok was observed timing out on the larger grouping. The Reader UI accepts the result only when the returned array length matches the source length and every segment is non-empty. Otherwise, it displays an error and keeps the action retryable.
Japanese reading responses use compact `[text, reading]` tuples to reduce generated tokens. The parser still accepts the earlier object form, reconstructs each source segment from returned text tokens, and rejects incomplete or misaligned output before ruby elements are committed to the DOM. Each batch accepts only the global segment IDs included in that request, so an unsolicited model line cannot overwrite a completed checkpoint from an earlier batch.

Translation batches report `completed`, `total`, and an aligned partial translation array; Japanese reading progress additionally reports `completedSegments`, `totalSegments`, and aligned partial token arrays. Reader merges a selected task range back into the full transcript and renders completed segments immediately while preserving stable source indexes.

After each successful batch, the runtime stores an aligned partial checkpoint keyed by response language where applicable and the exact ordered task text. Checkpoints are shared across an explicit execution-mode switch so the next engine receives only incomplete segments. `browser.storage.session` uses one key per checkpoint to avoid lost updates between Reader tabs, with a bounded 20-entry set and an in-memory fallback. A later explicit retry or Reader reload loads the checkpoint and sends only incomplete or invalid segments. When a local CLI reports a timeout, that transcript's next explicit retry halves the Japanese-reading prompt target down to a 600-character minimum; successful completion clears this adaptive limit. No automatic provider retry is created. Complete checkpoints remain available for reuse until session storage is cleared. Translation and ruby edits update the checkpoint without making a model request.

Page-owned AI controls expose a compact task bar with engine, selected segment count, approximate batch count, elapsed time, progress, and a visible cancel action. The range selector supports the active segment, the next five minutes, or the full transcript. Failed transcript requests remain retryable through the error card, which reports completed work, offers an explicit execution-mode switch, and keeps raw error text collapsed. Japanese readings additionally expose an explicit regenerate action because a corrected or context-sensitive reading may require a fresh model request. Editable translations and ruby readings use textbox semantics and labels; non-editing ruby elements support keyboard hide/reveal practice. Dialogs close with Escape and restore focus.

Manual ruby corrections are also written to a persistent personal dictionary. Before generating readings, the configured runtime resolves known surfaces locally and sends only segments with unresolved kanji. Personal entries override matching model tokens. If every kanji occurrence in the requested range is known, the runtime returns aligned tokens without loading a configured assistant or sending a background request.

### Safe content application

An AI-edit preview records the full source value and replacement range. Apply succeeds only when the current note-content value still equals that source snapshot. Replacement updates only the selected range, and undo restores the pre-apply value once.

### Language resolution

The response language is resolved for every action in this order:

1. Trimmed `readerSettings.learningResponseLanguage`.
2. `navigator.language`.
3. `English`.

Preset instructions may contain `{{responseLanguage}}`; the runtime resolves the token before sending the instruction.

## Reader interaction details

- The Reader exposes **Reading**, **Notebook**, and **Split view** layouts. The selected mode is stored in `readerSettings.transcriptLayout`; switching modes moves the existing controls without recreating transcript, translation, reading, or explanation state and never sends a provider request.
- Notebook and Split view use wider Reader content widths on desktop and fall back to the single-column reading flow below the responsive breakpoint.
- Original segment text is captured before translations are appended.
- Japanese readings are rendered as ruby elements only after the explicit **Japanese readings** action; the original text remains selectable and can be toggled back to its unannotated form.
- **Edit translations** and **Edit readings** put generated output into labeled content-editable controls. Corrections do not create a provider request and are written to the session checkpoint.
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
| Provider request failure | The background returns an error for the calling UI to display |
| Provider request timeout | The background aborts the request after the default LLM timeout and returns a retryable timeout error; Japanese reading checkpoints from earlier batches remain available for an explicit retry |
| Native Host protocol/configuration failure | Reader shows a localized recovery message, collapsed technical detail, retry, and explicit engine switch; Settings health check reports the exact Host/CLI seam |
| Final response parsing failure | The LLM client returns an empty response set; callers display an empty- or incomplete-response error |
| Reader SPA navigation | Old controls, cards, and listeners are cleaned up |

## Security and privacy

- The host page cannot trigger paid actions through synthetic clicks or double-clicks.
- Model credentials are resolved from extension storage only in the background/client path.
- Model output is inserted with `textContent`, not interpreted as HTML.
- The feature does not add telemetry or send requests to an Obsidian-owned intermediary.
- Provider terms, retention, privacy, and pricing still apply to every request.

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
- `src/utils/transcript-study.test.ts`
- `src/utils/transcript-layout.test.ts`
- `src/utils/llm-client.test.ts`
- `src/webpack-config.test.ts`
- `native-host/obsidian-clipper-host.test.ts`
- `src/webpack-config.test.ts`

Run the complete verification gate with:

```sh
TZ=America/Los_Angeles npm test
npx tsc --noEmit --module es2020
npm run build
npm run test:bundle-boundaries
npm run build:cli
npm run build:api
npm run test:transcript-preview
git diff --check
```

`npm run preview:transcript` builds and serves the deterministic transcript layout at `http://127.0.0.1:4173/`. The automated preview gate executes and verifies the page's runtime-ready marker in headless Chrome, then writes a dimension-checked screenshot under the system temporary directory.

Reader language-learning code and Settings Interpreter management are lazy chunks. Generated chunks are web-accessible for Reader content-script execution, while `background.js` remains a synchronous MV3 service-worker entry with no runtime-loaded network chunk. Background or provider changes also require an unpacked Chromium smoke test that sends a request to a local mock provider. Confirm that `background.js` starts without DOM globals or runtime chunk loading and that the parsed response reaches the extension page.

## Known limitations and future seams

- Transcript results persist only for the extension/browser session. Durable study history would require a separately versioned storage policy and migration path.
- Japanese readings can still be ambiguous for names or polyphonic kanji. Personal corrections improve repeated terms but do not replace full morphological analysis.
- The response language is shared by translations and explanations. Separate source, translation, and explanation language settings may be added without changing the assistant interface.
- Explanation prompts explicitly require the configured response language for explanation text, labels, and translations.
- The Learning Center is not a spaced-repetition system. Obsidian export uses the configured learning vault and folder.
- Task estimates use source characters and configured prompt-group targets; they are approximate batch counts, not token or billing estimates.
