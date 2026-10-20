# Non-Japanese Transcript Readings Translation Design

## Goal

Extend **Japanese readings** so a learner can use it with a non-Japanese YouTube or Bilibili transcript. Preserve the source subtitle, translate the selected transcript range into Japanese, add hiragana readings above kanji in that Japanese translation, and keep any ordinary bilingual translation visible as a separate line.

## Product behavior

### Japanese source transcripts

Keep the current behavior. When the transcript is Japanese and contains kanji, **Japanese readings** annotates the original transcript text with ruby readings. Toggling the action hides or shows the readings without another model request.

### Non-Japanese source transcripts

Show **Japanese readings** even though the source has no Japanese kanji. The first explicit activation processes the selected AI range in two sequential stages:

1. Translate the aligned source segments into Japanese.
2. Annotate the aligned Japanese segments with hiragana readings for every kanji.

Render the completed result in a dedicated `.transcript-segment-japanese` line below the original subtitle. If ordinary **Bilingual subtitles** are also visible, keep their `.transcript-segment-translation` line unchanged so the transcript can contain three independent layers:

1. Original subtitle.
2. Ordinary bilingual translation.
3. Japanese translation with ruby readings.

Toggling **Japanese readings** off hides the entire Japanese learning line for a non-Japanese source. It does not hide the original subtitle or ordinary bilingual translation. Toggling it on again reuses the completed local result and does not make another model request.

## Source-language classification

Classify the transcript once, rather than independently classifying each segment.

1. If `data-transcript-language` is present, normalize it and treat an independent `ja` or `jpn` language token as Japanese. This covers values such as `ja`, `ja-JP`, and Bilibili-style `ai-ja`. Treat other explicit language codes as non-Japanese.
2. Without reliable metadata, treat the transcript as Japanese when its source text contains hiragana or katakana.
3. Otherwise treat it as non-Japanese and run the translation stage.

For a transcript classified as Japanese, hide the action when there is no kanji to annotate. For a transcript classified as non-Japanese, show the action for any non-empty transcript because the Japanese translation may contain kanji.

This fallback deliberately avoids a separate language-detection model request. An unlabelled Japanese transcript containing only kanji can be classified as non-Japanese and receive a redundant Japanese translation; this is preferable to adding an automatic paid detection request.

## Architecture

### Pure model interface

Keep the existing low-level `LanguageLearningAssistant.translateTranscript(segments, targetLanguage, onProgress?, signal?)` operation. It already accepts an explicit target language, preserves source IDs, validates aligned output, batches long transcripts sequentially, and checkpoints completed batches.

No combined “translate and annotate” prompt will be introduced. Translation and reading annotation remain independently validated operations.

### Configured runtime

Add a dedicated configured-runtime operation for fixed-target Japanese translation. It must:

- Pass `Japanese` as the target language regardless of `readerSettings.learningResponseLanguage`.
- Use the existing background-only Interpreter or local CLI execution path.
- Use a translation checkpoint scope dedicated to Japanese, separate from the ordinary response-language translation scope.
- Expose a loader for a complete saved Japanese translation so Reader can restore it without loading an Interpreter or making a request.
- Preserve the existing request cancellation and partial-checkpoint behavior.

Ordinary bilingual translation remains keyed by the configured response language. Japanese translation is keyed by the exact ordered source segments and the fixed Japanese target. The two results must not overwrite each other even when both are visible.

### Reader controller

Extend `TranscriptLanguageLearning` with the smallest dedicated Japanese-translation methods required by the Reader. Keep these values separate from existing `translationValues` and `japaneseReadings` state:

- Aligned Japanese translation strings.
- Whether the Japanese learning line is visible.
- Whether the source was classified as Japanese.

For a non-Japanese range, the controller first obtains a complete Japanese translation and then passes those translated strings to `annotateJapaneseTranscript`. The personal reading dictionary therefore resolves and overrides readings against Japanese translated surfaces, not against the non-Japanese source.

Generalize the existing ruby element construction just enough to render the same validated reading tokens either in the original subtitle container or in the dedicated Japanese line. Do not refactor unrelated transcript rendering.

### DOM and styling

Use a dedicated `.transcript-segment-japanese` element. It must not reuse `.transcript-segment-translation`, because ordinary bilingual translations and Japanese learning output can coexist.

The Japanese line contains the same accessible `<ruby>`, base text, and `<rt>` behavior as current Japanese-source readings:

- Individual readings can be hidden or revealed with pointer or keyboard activation.
- Editing mode gives `<rt>` textbox semantics and accessible labels.
- The Japanese line is hidden as a whole when the feature is toggled off.

Transcript click guards must treat the Japanese line and its ruby controls as learning UI so clicking or editing them does not seek the video.

## Request and progress flow

All paid or remote work remains behind the existing trusted **Japanese readings** action. Page load, transcript load, selection changes, layout changes, saved preference restoration, and synthetic page events must not start either stage.

For non-Japanese source text, the task bar exposes two sequential stages:

1. **Translating to Japanese** reports aligned translation batch progress.
2. **Adding Japanese readings** reports completed translated subtitle segments with valid readings.

Both stages use the selected AI range: current segment, next five minutes, or all transcript segments. One cancel action aborts whichever stage is active and propagates through the existing background request ID.

Do not start annotation until every translated segment in the selected range is non-empty and aligned. Partial Japanese translations are checkpointed but are not rendered as a completed Japanese learning line. Once translation is complete, valid reading segments may render progressively while later reading batches continue.

## Checkpoints, caching, and restoration

Keep three independent result identities:

- Ordinary bilingual translations: configured response language plus ordered source segments.
- Japanese translations: fixed Japanese target plus ordered source segments.
- Japanese readings: exact ordered Japanese text being annotated.

After each successful model batch, save the aligned partial checkpoint through extension session storage. A later explicit retry sends only missing segments.

If translation succeeds and reading annotation fails or is cancelled, retain the complete Japanese translation checkpoint. The next explicit activation starts at reading annotation and must not repeat the translation request.

On Reader reload with the saved Japanese-readings visibility preference enabled:

- Japanese source: restore only a complete readings checkpoint, as today.
- Non-Japanese source: load the complete Japanese translation first, then load readings keyed by that translation, and render only when both are complete.
- Missing or incomplete local state leaves the action available and never starts a request automatically.

In-page caches follow the same independent keys and retain the existing bounded-entry policy.

## Editing and regeneration

For a Japanese source, keep current editing and regeneration behavior.

For a non-Japanese source:

- **Edit readings** edits only the `<rt>` values above the Japanese translation.
- A non-empty edit updates the transcript readings checkpoint and the persistent personal reading dictionary.
- Removing an edit removes the corresponding personal override under the existing rules.
- **Regenerate readings** clears and regenerates only the selected reading checkpoint. It retains the Japanese translation, original subtitle, ordinary bilingual translation, and personal dictionary.

Editing or regenerating the Japanese translation text itself is outside this change. A successfully returned but semantically poor Japanese translation has no dedicated correction control in this first scope; the UI must not imply that **Regenerate readings** retranslates it.

## Error handling

- Incomplete, empty, or misaligned Japanese translation output shows the translation-stage error and never starts annotation.
- Incomplete or misaligned reading output shows the existing reading-stage error and does not mark the selected range complete.
- Completed batches remain checkpointed after cancellation or failure.
- Retry is always an explicit trusted user action.
- Switching Interpreter execution mode from an error card resumes from compatible partial checkpoints.
- CLI timeout adaptation continues to apply to the reading stage. Translation retains its existing batching behavior.
- Raw provider or CLI details remain collapsed in the existing technical-details UI.

## Localization and documentation

Add English and Simplified Chinese messages for the Japanese-translation stage and any distinct error/retry label introduced by the implementation. Do not hardcode user-facing strings.

Update:

- `docs/Introduction to Obsidian Web Clipper.md`
- `docs/Language learning.md`
- `docs/development/Language learning MVP.md`

The user documentation must state that non-Japanese transcripts require a translation stage followed by a reading stage, long selections may create multiple sequential billable requests in each stage, ordinary bilingual translations remain separate, and no request starts automatically.

## Test design

Follow RED-GREEN development. Add focused coverage for:

### Pure and runtime behavior

- Transcript classification recognizes `ja`, `ja-JP`, and `ai-ja` metadata, rejects explicit non-Japanese metadata, uses kana only when metadata is absent, and documents the all-kanji fallback.
- Fixed-target Japanese translation uses `Japanese`, not the configured response language.
- Japanese and ordinary translation checkpoints do not collide.
- Complete Japanese translations load without requiring an enabled Interpreter.
- Partial Japanese translation checkpoints resume only missing segments.
- Existing API, Grok CLI, Codex CLI, cancellation, and aligned parsing paths remain shared.

### Reader DOM behavior

- An explicit Japanese-readings action on a non-Japanese source calls Japanese translation before reading annotation.
- A Japanese source bypasses Japanese translation.
- No request starts on initialization, saved-state restoration, or a synthetic page event.
- The original subtitle, ordinary translation, and annotated Japanese line coexist.
- Toggling off hides only the complete Japanese learning line.
- A translation-stage failure does not call reading annotation.
- A reading-stage failure followed by retry does not repeat completed translation.
- AI range selection is applied to both stages.
- Cancellation works during either stage.
- Reload restores a complete two-stage result without a request and never restores an incomplete result as complete.
- Reading edits update the Japanese ruby tokens and personal dictionary.
- Regeneration clears only readings and preserves both translation layers.
- Transcript click handling ignores interaction inside the Japanese line.

### Verification commands

Run focused tests during implementation:

```sh
npx vitest run src/utils/language-learning.test.ts
npx vitest run src/utils/language-learning-runtime.test.ts
npx vitest run src/utils/transcript-language-learning.test.ts
npx vitest run src/utils/reader-transcript.test.ts
```

Before completion, run:

```sh
TZ=America/Los_Angeles npm test
npx tsc --noEmit --module es2020
npm run build
git diff --check
```

Because the change affects Reader DOM behavior and background model work, a real unpacked Chromium smoke test is preferred but must be reported separately from automated verification if it cannot be run.

## Non-goals

- Automatic language detection through a paid model request.
- Automatic translation or reading generation on page or transcript load.
- Replacing or changing the configured AI response language.
- Reusing the ordinary bilingual DOM line for Japanese learning output.
- A combined translation-and-reading prompt.
- Editing or regenerating Japanese translation text.
- Persisting transcript results as permanent study history or adding them to the clipping.
- Changing existing provider selection, credentials, or saved model behavior.
