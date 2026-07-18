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
2. In **Interpreter**, enable Interpreter and either configure at least one enabled provider and model, or choose a local **Grok CLI**/**Codex CLI** execution mode. For Native Messaging setup, see [[Interpret web pages#Local Grok and Codex CLI modes|Local Grok and Codex CLI modes]].
3. In **Reader** → **Transcripts**, optionally enter or choose an **AI response language**, such as `Simplified Chinese`, `Japanese`, or `English`.

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

Web Clipper translates the transcript in aligned batches. Each translation remains attached to its original timed segment. Long transcripts may require multiple sequential model requests; the control shows the current batch while they run. You can cancel an in-flight request. A completed translation is reused for the same transcript and response language during the current Reader session. If the model omits a segment, Web Clipper shows an error card with **Retry** instead of treating the partial result as complete.

After translations load, select **Bilingual subtitles** again to hide or show them without another model request.

For Japanese transcripts, select **Japanese readings** to add hiragana readings above kanji in the original transcript. Select it again to hide or show the readings without another model request. The control is hidden when the transcript does not appear to contain Japanese kanji. Long transcripts are processed in sequential batches, with smaller batches in local CLI modes so progress updates more often and individual requests are less likely to time out. Progress counts completed subtitle segments rather than model batches. If a later batch fails or is cancelled, completed segments are retained for the current extension session; selecting **Retry** or **Japanese readings** again sends only the missing segments. After readings load, select **Edit readings**, then edit a reading directly above its kanji and select **Done editing**. Select **Regenerate readings** when the model chose the wrong reading; this explicitly starts a fresh AI request. A successful result, including your corrections, is reused for the same transcript during the current Reader session.

> [!note] Temporary Reader content
> Bilingual transcript lines and Japanese readings are displayed for the current Reader session. They are not persisted across a reload and are not automatically added to the clipping. Manual reading corrections are session-local too.

## Explain a word

Double-click a word in a YouTube transcript. Web Clipper opens an explanation card containing:

- The lemma and pronunciation.
- The meaning in the current transcript context.
- A concise usage note.
- An example sentence.

Double-clicking a word does not intentionally seek playback. The Reader delays or restores the normal single-click seek when it detects a double-click.

## Explain a phrase or sentence

Select a phrase, sentence, or text spanning adjacent transcript segments. Then select **Explain with AI** next to the selection.

The explanation includes a natural translation, the grammar structure, and important expressions in context. The same response language, selection kind, text, and context are cached for the current Reader session, so reopening the same explanation does not create another model request. Changing the response language creates a new explanation instead of reusing one in the previous language. New explanations can be cancelled and failed explanations can be retried from the card.

The selection action also works with touch selection on mobile browsers that support Reader transcripts.

## Model selection and requests

Language-learning tools use the selected Interpreter model in API mode. In Grok CLI or Codex CLI mode, requests are sent to the selected local CLI through the background service worker and do not require an Interpreter API model.

All provider and local CLI requests run in the extension background. API keys are not inserted into the page or transcript DOM. Local CLI mode sends the relevant content to the local Native Messaging Host and then to the selected CLI.

The following actions can create model-provider usage:

- Generating an AI-edit preview.
- Translating a transcript. A long transcript can create multiple sequential requests.
- Generating Japanese readings for a transcript. A long transcript can create multiple sequential requests.
- Explaining a new word, phrase, or sentence that is not already cached for the session.

Applying, cancelling, undoing, hiding, or showing an existing result does not make another model request.

Cancelling a Reader request stops the extension from waiting for or applying that result. In API mode it also aborts the provider fetch. In local CLI mode, the extension stops waiting immediately, but the Native Messaging host may continue until the CLI process exits.

## Troubleshoot language learning

### AI editing controls are missing

Confirm that Interpreter is enabled. In API mode, at least one Interpreter model must be enabled; in CLI mode, confirm that the Native Messaging Host is installed and the selected CLI is installed and authenticated. Reload the popup after changing Interpreter settings.

### YouTube language controls are missing

The controls are available only when Reader detects both a supported YouTube player and a transcript. Some videos do not provide a transcript.

### A translation is incomplete

Retry the translation. If the problem continues, choose a model with a larger context window or process a shorter video.

### Japanese readings time out in CLI mode

Rebuild and reload the Chromium extension, then rerun the Native Messaging installer so the installed host matches the extension source. Confirm the selected CLI is authenticated. Grok reading requests run as single-turn transformations without built-in tools, web search, or cross-session memory; long transcripts still create multiple sequential requests. After a timeout, **Retry** resumes from the last completed subtitle segment in the current extension session.

### The provider returns an error

Check the provider URL, API key, enabled model, quota, local-model server, or Native Messaging Host installation as appropriate. For general setup and provider help, see [[Interpret web pages#Models|Interpreter models]] and [[Troubleshoot Web Clipper]].

## Current limitations

- Reader translations, explanations, and Japanese reading results are session-local.
- AI output quality and language accuracy depend on the selected model.
- Japanese names and context-dependent kanji readings may need manual correction.
- Transcript translation does not currently support editing an individual translated segment.
- Vocabulary is not automatically saved to a flashcard or spaced-repetition system.

## Developer reference

For implementation boundaries, request flow, invariants, and verification commands, see [[development/Language learning MVP|Language learning MVP technical design]].
