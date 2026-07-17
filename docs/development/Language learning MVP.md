---
description: Architecture, invariants, verification, and known limitations for the Web Clipper language-learning MVP.
---
This document describes the implemented language-learning MVP and the interfaces that must remain stable when it evolves.

## Goals

- Let users revise selected or complete clipped Markdown through a preview-and-apply workflow.
- Add manually triggered, segment-aligned bilingual YouTube transcripts.
- Add manually triggered hiragana readings for Japanese kanji in YouTube transcripts.
- Let users correct generated Japanese readings directly in the Reader.
- Explain a double-clicked word or a selected phrase or sentence in transcript context.
- Reuse the existing Interpreter provider, model, and credential configuration, or use the configured local Grok/Codex CLI execution mode.
- Keep every remote action explicit so the extension does not create surprise model costs.

## Non-goals

- Automatically translating every transcript on load.
- Persisting Reader translations or explanation history.
- Managing vocabulary lists, flashcards, or spaced repetition.
- Adding a second provider configuration system for language learning.
- Streaming partial responses into the UI.

## Module map

| Module | Interface and responsibility |
| --- | --- |
| `src/utils/language-learning.ts` | Pure `LanguageLearningAssistant` interface for content transformation, selection explanation, aligned transcript translation, and Japanese readings |
| `src/utils/language-learning-runtime.ts` | `configuredLanguageLearning`, the configured interface used by Popup and Reader callers |
| `src/utils/language-learning-popup.ts` | Popup and side-panel preview, apply, cancel, and undo state |
| `src/utils/transcript-language-learning.ts` | Bilingual and Japanese-reading controls, selection extraction, explanation card, caching, and cleanup |
| `src/utils/transcript-layout.ts` | Pure Reader transcript-layout switching, selected-state semantics, and layout class management |
| `src/utils/reader-transcript.ts` | Player integration and single-click versus double-click seek coordination |
| `src/utils/language-learning-service.ts` | Background validation, stored-model resolution, and local CLI dispatch |
| `src/utils/llm-client.ts` | DOM-free provider adapter and response parser shared with Interpreter |
| `src/utils/native-cli-service.ts` | Background Native Messaging bridge for local Grok/Codex execution |
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

The interface is intentionally small. Popup and Reader know only how to transform content, explain a selection, translate ordered segments, or annotate Japanese readings. They do not know provider URLs, credentials, request formats, or response parsing rules.

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

### Background-only provider access

Reader can run inside a page context, where cross-origin model requests inherit page restrictions. Callers therefore send a structured request through `browser.runtime`; the background resolves the stored enabled model and performs the provider request.

Credentials stay in the existing Interpreter settings. Language-learning messages contain context, prompts, and an optional output budget, but never a provider URL or API key. In CLI mode, the background service worker sends a fixed-mode request to `com.obsidian.web_clipper`; the host only launches the configured `grok` or `codex` executable.

### MV3-safe network client

`llm-client.ts` must remain DOM-free. The background imports it synchronously. Do not dynamically import `interpreter.ts` from the background or generate a runtime-loaded network chunk: Chrome MV3 service workers cannot depend on a new chunk being imported after installation.

`interpreter.ts` re-exports the same network client so the established Interpreter interface remains compatible without duplicating provider logic.

### Transcript alignment

Each source segment is sent as `ID|||text`, where `ID` is its global source index. Responses must use `ID|||translation`. Parsing places each response back into an array at that index, so model reordering cannot change subtitle timing.

Prompt groups target a character-count limit and are sent sequentially. Each source segment remains atomic, so one segment longer than the limit can produce an oversized group. The Reader UI accepts the result only when the returned array length matches the source length and every segment is non-empty. Otherwise, it displays an error and keeps the action retryable.
Japanese reading responses also reconstruct each source segment from returned text tokens before ruby elements are committed to the DOM; incomplete or misaligned responses are rejected.

Translation and reading batches report `completed` and `total` counts to the Reader while they run. Both complete results are cached by the exact ordered transcript text (and response language for translations) for the current extension session. Editing a ruby reading updates that cache only when all kanji readings remain complete; an incomplete correction invalidates the cached result. Reader request controllers abort API fetches and prevent late results from being applied. Native CLI cancellation stops the extension-side wait; the host process is not forcibly terminated by the browser messaging API.

Page-owned AI controls expose a visible cancel action while a request is active. Failed transcript requests remain retryable through the error card. Japanese readings additionally expose an explicit regenerate action because a corrected or context-sensitive reading may require a fresh model request. Editable ruby readings use textbox semantics and labels so keyboard and assistive-technology users can correct them.

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
- **Edit readings** puts ruby annotations into a local content-editable mode. Corrections do not create a provider request and are reused after Reader SPA rewiring while the ordered transcript text is unchanged.
- Cross-segment selections find both range endpoints and build context from every covered source segment.
- Word explanations are cached by selection kind, selected text, and context for the current wired transcript.
- An `AbortController` removes document and transcript listeners when Reader content changes.
- SPA cleanup removes the selection action and explanation card even when navigation lands on content without a transcript.
- The transcript click guard delays a normal seek and can restore the original playback time when a slower operating-system double-click arrives after that delay.

## Error behavior

| Condition | Result |
| --- | --- |
| Interpreter disabled | Localized configuration error; no request is sent |
| No enabled model | Localized model error; no request is sent |
| Empty model response | Preview or explanation reports an empty response |
| Incomplete transcript response | No translation nodes are committed; the user can retry |
| Clipping changed after preview | Apply is rejected and the preview is cleared |
| Provider request failure | The background returns an error for the calling UI to display |
| Provider request timeout | The background aborts the request after the default LLM timeout and returns a retryable timeout error |
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
- `src/utils/language-learning-popup.test.ts`
- `src/utils/transcript-language-learning.test.ts`
- `src/utils/reader-transcript.test.ts`
- `src/utils/transcript-layout.test.ts`
- `src/utils/llm-client.test.ts`
- `src/webpack-config.test.ts`

Run the complete verification gate with:

```sh
TZ=America/Los_Angeles npm test
npx tsc --noEmit --module es2020
npm run build
npm run build:cli
npm run build:api
git diff --check
```

Background or provider changes also require an unpacked Chromium smoke test that sends a request to a local mock provider. Confirm that `background.js` starts without DOM globals or runtime chunk loading and that the parsed response reaches the extension page.

## Known limitations and future seams

- Reader results are not persisted. Persistence should be added behind a separate storage interface rather than inside transcript DOM code.
- Japanese readings are model-generated and can be ambiguous for names or polyphonic kanji; the Reader supports session-local manual correction but does not persist a dictionary.
- The response language is shared by translations and explanations. Separate source, translation, and explanation language settings may be added without changing the assistant interface.
- Explanation prompts explicitly require the configured response language for explanation text, labels, and translations.
- Transcript translation retries the complete operation. Per-batch retry metadata would belong inside the assistant implementation.
- Explanation cards are plain text. Structured learning objects should be introduced only when there is a second adapter, such as flashcard export or vocabulary storage.
- There is no request-cost estimate. Any estimate must account for multiple transcript batches and provider-specific tokenization.
