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
2. In **Interpreter**, enable Interpreter and configure at least one enabled provider and model. For setup instructions, see [[Interpret web pages#Get started|Get started with Interpreter]].
3. In **Reader** → **Transcripts**, optionally enter an **AI response language**, such as `Simplified Chinese`, `Japanese`, or `English`.

If the response-language field is empty, Web Clipper uses your browser language. The setting controls transcript translations, word and sentence explanations, and presets that use a response language.

## Revise clipped content with AI

The AI editing controls appear in the extension popup and side panel when Interpreter is enabled and at least one model is enabled.

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

Web Clipper translates the transcript in aligned batches. Each translation remains attached to its original timed segment. Long transcripts may require multiple model requests. If the model omits a segment, Web Clipper shows an incomplete-translation error and lets you retry instead of treating the partial result as complete.

After translations load, select **Bilingual subtitles** again to hide or show them without another model request.

> [!note] Temporary Reader content
> Bilingual transcript lines are displayed for the current Reader session. They are not persisted across a reload and are not automatically added to the clipping.

## Explain a word

Double-click a word in a YouTube transcript. Web Clipper opens an explanation card containing:

- The lemma and pronunciation.
- The meaning in the current transcript context.
- A concise usage note.
- An example sentence.

Double-clicking a word does not intentionally seek playback. The Reader delays or restores the normal single-click seek when it detects a double-click.

## Explain a phrase or sentence

Select a phrase, sentence, or text spanning adjacent transcript segments. Then select **Explain with AI** next to the selection.

The explanation includes a natural translation, the grammar structure, and important expressions in context. The same selection and context are cached for the current Reader session, so reopening the same explanation does not create another model request.

The selection action also works with touch selection on mobile browsers that support Reader transcripts.

## Model selection and requests

Language-learning tools use the selected Interpreter model when it is enabled. If that model is unavailable, Web Clipper uses the first enabled Interpreter model.

All provider requests run in the extension background using the provider configuration already stored by Interpreter. API keys are not inserted into the page or transcript DOM.

The following actions can create model-provider usage:

- Generating an AI-edit preview.
- Translating a transcript. A long transcript can create multiple sequential requests.
- Explaining a new word, phrase, or sentence that is not already cached for the session.

Applying, cancelling, undoing, hiding, or showing an existing result does not make another model request.

## Troubleshoot language learning

### AI editing controls are missing

Confirm that Interpreter is enabled and at least one Interpreter model is enabled. Reload the popup after changing model settings.

### YouTube language controls are missing

The controls are available only when Reader detects both a supported YouTube player and a transcript. Some videos do not provide a transcript.

### A translation is incomplete

Retry the translation. If the problem continues, choose a model with a larger context window or process a shorter video.

### The provider returns an error

Check the provider URL, API key, enabled model, quota, and local-model server. For general setup and provider help, see [[Interpret web pages#Models|Interpreter models]] and [[Troubleshoot Web Clipper]].

## Current limitations

- Reader translations and explanation caches are session-local.
- AI output quality and language accuracy depend on the selected model.
- Transcript translation does not currently support editing an individual translated segment.
- Vocabulary is not automatically saved to a flashcard or spaced-repetition system.

## Developer reference

For implementation boundaries, request flow, invariants, and verification commands, see [[development/Language learning MVP|Language learning MVP technical design]].
