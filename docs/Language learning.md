---
permalink: web-clipper/language-learning
aliases:
  - Language learning with Web Clipper
description: Use AI to revise clipped text, translate YouTube transcripts, and explain words or sentences.
---
The language-learning tools in [[Introduction to Obsidian Web Clipper|Web Clipper]] use your configured [[Interpret web pages|Interpreter]] model to revise clipped content, display bilingual YouTube transcripts, and explain selected language in context.

> [!warning] Model usage and privacy
> Each AI action sends the relevant clipped text or transcript context to the model provider you configured. The provider may charge for the request. Web Clipper does not run these actions automatically.

## Set up language learning

1. Open Web Clipper **Settings**.
2. In **Interpreter**, open the language-learning setup assistant. Enable Interpreter and either configure at least one enabled provider and model, or choose a local **Grok CLI**/**Codex CLI** execution mode. For Native Messaging setup, see [[Interpret web pages#Local Grok and Codex CLI modes|Local Grok and Codex CLI modes]].
3. Run the readiness check. For a local CLI, it verifies the Native Messaging Host and selected executable without sending page content. A successful check shows that language learning is ready.
4. In **Reader** → **Transcripts**, optionally enter or choose an **AI response language**, such as `Simplified Chinese`, `Japanese`, or `English`. You can also choose the Obsidian vault and folder used for learning notes.

If the response-language field is empty, Web Clipper uses your browser language. The setting controls transcript translations, word and sentence explanations, and presets that use a response language.

Word and sentence explanations instruct the model to use this language for all explanation text, labels, and translations.

## Revise clipped content with AI

The AI editing controls appear in the extension popup and side panel when Interpreter is enabled and either an API model or a configured local CLI mode is available.

1. Capture a page normally.
2. In the note-content field, select the text you want to change. Leave the selection empty to process the entire clipping.
3. Choose a preset or enter a custom instruction.
4. Select **Preview AI edit**.
5. Review the generated Markdown, then select **Apply** or **Cancel**.
6. After applying an edit, select **Undo** to restore the previous clipping content.

| Preset | Result |
| --- | --- |
| **Bilingual** | Keeps each original sentence and places a translation below it |
| **Simplify** | Rewrites the content at approximately CEFR B1 while preserving facts |
| **Polish** | Improves clarity, grammar, and natural phrasing without adding facts |
| **Study notes** | Creates a summary with vocabulary, grammar patterns, and examples |
| **Custom** | Runs the instruction you enter |

The preview stores a snapshot of the clipping. If the clipping changes before you select **Apply**, Web Clipper rejects the stale preview and asks you to generate it again.

## Read YouTube transcripts bilingually

Open Reader on a YouTube page that has an available transcript, then select **Bilingual subtitles** in the transcript controls.

Use the transcript layout switcher to choose **Reading**, **Notebook**, or **Split view**. Reading keeps the video above a centered transcript, Notebook moves the learning controls into a left study rail, and Split view keeps the player beside the transcript on wider screens. Web Clipper remembers the selected layout. Changing layouts only rearranges the existing player, controls, transcript, and explanation state; it does not start an AI request. On narrower screens, Notebook and Split view fall back to a single-column layout.

Before starting, use **AI range** to choose the current segment, the next five minutes, or the entire transcript. The task bar shows the selected engine, segment count, estimated batch count, elapsed time, and completed batches. A smaller range is useful when testing a local CLI or studying only the current part of a long video.

Web Clipper translates the transcript in aligned batches. Each translation remains attached to its original timed segment, and completed lines appear while later batches are still running. You can cancel an in-flight request. Successful batches are checkpointed in extension session storage, so an explicit retry or Reader reload continues with only missing segments when the browser supports session storage. If the model omits a segment, Web Clipper keeps the completed lines and shows a localized error card with **Continue remaining** instead of treating the partial result as complete.

After translations load, select **Bilingual subtitles** again to hide or show them without another model request.

Open **Study** for local playback tools that do not use AI: repeat the active sentence, set an A–B loop, pause after each sentence, or change playback speed. Keyboard shortcuts are `R` for sentence repeat, `P` for auto-pause, `[` and `]` for speed, and `Shift+A`/`Shift+B` for loop points. Existing playback shortcuts such as Space, K, J, and L continue to work.

Select **Edit translations** to correct a generated line in place. Corrections are saved to the same session checkpoint and do not make a model request.

For Japanese transcripts, select **Japanese readings** to add hiragana readings above kanji in the original transcript. Select it again to hide or show the readings without another model request. Select or press Enter on an individual ruby annotation to hide it for recall practice, then activate it again to reveal the answer. The control is hidden when the transcript does not appear to contain Japanese kanji.

Long transcripts are processed in sequential batches, with smaller batches in local CLI modes so progress updates more often and individual requests are less likely to time out. Progress counts completed subtitle segments rather than model batches. If a later batch fails or is cancelled, completed segments remain checkpointed; selecting **Continue remaining** or **Japanese readings** again sends only missing segments. After a CLI timeout, the next explicit retry also uses a smaller batch size. Web Clipper never starts a paid retry automatically.

After readings load—even for **Current segment** or **Next 5 minutes**—select **Edit readings**, edit a reading directly above its kanji, then select **Done editing**. Select **Regenerate readings** when the model chose the wrong reading; this explicitly starts a fresh request for the selected range while preserving readings outside that range. Corrections are stored with the transcript checkpoint and in your persistent personal reading dictionary. Known words are reused in later transcripts, and a segment whose kanji are all covered by the dictionary is annotated locally without an AI request.

> [!note] Session checkpoints
> Transcript translations, Japanese readings, and manual corrections are stored in extension session storage, not in the webpage. They survive Reader and service-worker reloads in Chromium but can be cleared when the browser session ends. Browsers without extension session storage use an in-memory fallback. These results are not automatically added to the clipping.

## Explain a word

Double-click a word in a YouTube transcript. Web Clipper opens an explanation card containing:

- The lemma and pronunciation.
- The meaning in the current transcript context.
- A concise usage note.
- An example sentence.

Double-clicking a word does not intentionally seek playback. The Reader delays or restores the normal single-click seek when it detects a double-click.

From the explanation card, you can **Favorite** the item, **Copy** the text, or **Add to Obsidian**. Favorites are stored locally in the extension and appear in the **Learning Center**. Saving to Obsidian uses the vault and folder selected in Reader settings and does not make another AI request.

The Learning Center supports search, word/sentence filters, multi-select removal or Obsidian export, JSON import/export, and clear-all. Its **Japanese readings** tab lets you add, remove, import, or export personal readings. Export copies versioned JSON to the clipboard; import reads a JSON file. These local management actions do not call a model.

## Explain a phrase or sentence

Select a phrase, sentence, or text spanning adjacent transcript segments. Then select **Explain with AI** next to the selection.

The explanation includes a natural translation, the grammar structure, and important expressions in context. The same response language, selection kind, text, and context are cached for the current Reader session, so reopening the same explanation does not create another model request. Changing the response language creates a new explanation instead of reusing one in the previous language. New explanations can be cancelled and failed explanations can be retried from the card.

The selection action also works with touch selection on mobile browsers that support Reader transcripts. Press Escape to close an explanation or error card and return focus to the control that opened it.

## Model selection and requests

Language-learning tools use the selected Interpreter model in API mode. In Grok CLI or Codex CLI mode, requests are sent to the selected local CLI through the background service worker and do not require an Interpreter API model.

All provider and local CLI requests run in the extension background. API keys are not inserted into the page or transcript DOM. Local CLI mode sends the relevant content to the local Native Messaging Host and then to the selected CLI.

The following actions can create model-provider usage:

- Generating an AI-edit preview.
- Translating a transcript. A long transcript can create multiple sequential requests.
- Generating Japanese readings for a transcript. A long transcript can create multiple sequential requests.
- Explaining a new word, phrase, or sentence that is not already cached for the session.

Applying, cancelling, undoing, hiding, or showing an existing result does not make another model request.

Cancelling a Reader request stops the extension from waiting for or applying that result. In API mode it aborts the provider fetch. In local CLI mode, protocol version 2 sends cancellation over the same Native Messaging port; the Host terminates the selected CLI process and force-kills it if it does not exit promptly.

## Troubleshoot language learning

### AI editing controls are missing

Confirm that Interpreter is enabled. In API mode, at least one Interpreter model must be enabled; in CLI mode, confirm that the Native Messaging Host is installed and the selected CLI is installed and authenticated. Reload the popup after changing Interpreter settings.

For CLI mode, open **Settings** → **Interpreter** and select **Check connection**. A protocol mismatch means the extension was rebuilt without reinstalling the Host. A configuration error means the selected executable was not detected at install time or no longer exists.

### YouTube language controls are missing

The controls are available only when Reader detects both a supported YouTube player and a transcript. Some videos do not provide a transcript.

### A translation is incomplete or stops partway

Select **Continue remaining**. Completed lines are kept, and only missing segments are sent. If the problem continues, choose **Current segment** or **Next 5 minutes**, switch execution mode from the error card, or use a model with a larger context window.

### Japanese readings time out in CLI mode

Rebuild and reload the Chromium extension, then rerun the Native Messaging installer so the installed host matches the extension source. Confirm the selected CLI is authenticated. Grok reading requests run as single-turn transformations without built-in tools, web search, or cross-session memory; long transcripts still create multiple sequential requests. After a timeout, **Retry** resumes from the last completed subtitle segment and reduces the remaining batch size. Repeated timeouts reduce it again, down to a safe minimum for atomic subtitle segments.

### The provider returns an error

Check the provider URL, API key, enabled model, quota, local-model server, or Native Messaging Host installation as appropriate. For general setup and provider help, see [[Interpret web pages#Models|Interpreter models]] and [[Troubleshoot Web Clipper]].

## Current limitations

- Transcript checkpoints are session-scoped rather than permanent study history. Saved vocabulary is persistent local extension data.
- AI output quality and language accuracy depend on the selected model.
- Japanese names and context-dependent kanji readings may need manual correction.
- The Learning Center does not implement spaced repetition or flashcard scheduling.
- Transcript checkpoints remain session-scoped even though vocabulary and personal Japanese readings are persistent local data.

## Developer reference

For implementation boundaries, request flow, invariants, and verification commands, see [[development/Language learning MVP|Language learning MVP technical design]].
