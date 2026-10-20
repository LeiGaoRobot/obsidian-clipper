---
permalink: web-clipper/language-learning
aliases:
  - Language learning with Web Clipper
description: Use AI to revise clipped text, translate YouTube and Bilibili transcripts, and explain words or sentences.
---
The language-learning tools in [[Introduction to Obsidian Web Clipper|Web Clipper]] use the models you set up in **Settings → AI** (see [[Interpret web pages|Interpreter]]) to revise clipped content, display bilingual YouTube and Bilibili transcripts, and explain selected language in context.

> [!warning] Model usage and privacy
> Each AI action sends the relevant clipped text or transcript context to the model provider you configured. The provider may charge for the request. Web Clipper does not run these actions automatically.

## Set up language learning

1. Open Web Clipper **Settings** and go to **AI**.
2. Under **Connections**, add an API provider with **Add API provider**, or, on Chrome, a local CLI with **Add local CLI**. API keys are stored only on this device, in the browser's local extension storage as plain text, and do not sync to your other devices. For a local source build, select **Copy install command**, run the generated command once from any Terminal directory, and reload the extension. For details, see [[Interpret web pages#Local Grok and Codex CLI connections|Local Grok and Codex CLI connections]].
3. Under **Models**, add and enable at least one model. A Codex CLI model has an optional model ID and **Reasoning effort**; leave either at its default to use the CLI default. Reasoning effort choices are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`, and availability depends on the selected model. An unsupported model and effort combination is shown as a retryable CLI failure, with no fallback to another model. Higher effort can take longer and use more tokens.
   Optionally select **Test** on the connection to check the key and models. A Test may send one minimal request that the provider may bill, or run a local CLI once per model; the connection shows a note when it does. See [[Interpret web pages#Test a connection|Test a connection]].
4. Under **Task routing**, choose the **Default model**. Optionally choose a different model for **AI edit**, **Subtitle translation**, **Japanese readings**, or **Explanations**; each row shows the status of the connection its model uses.
5. Under **Language**, optionally enter or choose an **AI response language**, such as `Simplified Chinese`, `Japanese`, or `English`.
6. At the top of the **AI** section, turn on **Enable AI features**. Adding a model does not turn it on: if it is off when you add your first model, a note next to the switch says so.
7. In **Reader** → **Transcripts**, optionally set the default compact-player, bilingual-subtitle, and Japanese-reading visibility, and choose the Obsidian vault and folder used for learning notes.

If the response-language field is empty, Web Clipper uses your browser language. The setting controls transcript translations, word and sentence explanations, and presets that use a response language. It moved from the Reader settings to **Settings → AI → Language**; a language you set there before is carried over once.

Word and sentence explanations instruct the model to use this language for all explanation text, labels, and translations.

On Firefox, the install or update prompt discloses website-content transmission because these tools can send selected clipping or transcript content to your configured provider. Granting that permission does not start a language-learning request; the actions described below remain user initiated. This release requires Firefox 140 or newer on desktop and Firefox for Android 142 or newer so that disclosure is available.

## Revise clipped content with AI

The AI editing controls appear in the extension popup and side panel when AI features are enabled and **Task routing** names a model for **AI edit** (its own choice or the default model). When that model's key is missing on this device, or it is a local CLI this browser cannot reach, the controls still appear and the error card explains what to set up. They start collapsed behind a dashed **✦ Edit with AI…** button below the note content; select it to show them, and select it again to hide them. Showing the controls sends nothing. They stay as you left them until the window closes.

1. Capture a page normally.
2. Select **✦ Edit with AI…** to show the AI editing controls.
3. In the note-content field, select the text you want to change. Leave the selection empty to process the entire clipping.
4. Choose a preset or enter a custom instruction.
5. Select **Preview AI edit**.
6. Review the generated Markdown, then select **Apply** or **Cancel**.
7. After applying an edit, select **Undo** to restore the previous clipping content.

| Preset | Result |
| --- | --- |
| **Bilingual** | Keeps each original sentence and places a translation below it |
| **Simplify** | Rewrites the content at approximately CEFR B1 while preserving facts |
| **Polish** | Improves clarity, grammar, and natural phrasing without adding facts |
| **Study notes** | Creates a summary with vocabulary, grammar patterns, and examples |
| **Custom** | Runs the instruction you enter |

The preview stores a snapshot of the clipping. If the clipping changes before you select **Apply**, Web Clipper rejects the stale preview and asks you to generate it again.

While the preview is being generated, select **Cancel** below **Preview AI edit** to stop the request; the button appears only while a request runs. The clipping is not changed. If the request fails, an error card says what went wrong and what to do next. **Try again** sends the same text and instruction again and previews the result against the same snapshot. If the clipping changed after the failed request, **Try again** sends nothing, because that preview could not be applied, and asks you to generate the preview again. When the fix is in Settings, such as a missing or rejected API key or a Native Messaging Host that is not installed, the card also offers **Open AI settings**, which opens the **AI** section of Web Clipper settings. Select **Technical details** to see the provider's raw message.

## Read YouTube and Bilibili transcripts bilingually

Open Reader on a YouTube page that has an available transcript or open the in-page Reader on a public Bilibili video with an available timed subtitle track in Chromium or Firefox, then select **Bilingual subtitles** in the transcript controls. For Bilibili, Web Clipper prefers an available Chinese track, including Bilibili-generated AI subtitles, and otherwise uses another unlocked track. Loading a Bilibili subtitle is separate from Interpreter and does not create a model request.

Use the transcript layout switcher to choose **Reading**, **Study tools**, or **Split view**. Reading keeps the video above a centered transcript; select **Compact player** to hide the media without recreating it or losing the playback position. Study tools moves the learning controls into a left study rail, and Split view keeps the player beside the transcript on wider screens. Web Clipper remembers the selected layout, compact-player state, and whether bilingual subtitles or Japanese readings were visible. On reload, it restores only a complete result already saved for the current browser session. If no complete result exists, it leaves the action available and does not start an AI request. Changing layouts only rearranges the existing player, controls, transcript, and explanation state; it does not start an AI request. On narrower screens, Study tools and Split view fall back to a single-column layout.

The most common transcript actions stay in the main control row, including **Bilingual subtitles**, **Japanese readings**, and the compact-player action when it applies to the current layout. Open **More** for player pinning, auto-scroll, active-line highlighting, AI range, saved vocabulary, and local playback study controls. On screens up to 768 pixels wide, these primary actions remain visible while **More** opens as a bottom drawer, keeps the active transcript line above the drawer, traps keyboard focus while open, closes with Escape or the backdrop, and returns focus to **More**. On phone-width screens, opening the drawer temporarily collapses the player without recreating it so the active line and scrollable controls both remain usable; closing the drawer restores the same player.

Before starting, use **AI range** to choose the current segment, the next five minutes, or the entire transcript. When a transcript task starts, a task bar appears below the transcript controls, outside **More**, so you can follow it and select **Cancel** without opening **More**. It shows the selected engine, segment count, estimated batch count, elapsed time, and completed batches. A smaller range is useful when testing a local CLI or studying only the current part of a long video.

Web Clipper translates the transcript as one background job made of aligned batches. Each translation remains attached to its original timed segment, and completed lines appear while later batches are still running. With a hosted API provider, up to three batches run at the same time; Ollama and local CLI modes run one batch at a time. You can cancel the job at any time, including while it waits to retry. Every completed batch is saved for the browser session, so **Continue remaining** or a Reader reload continues with only missing segments. If the model omits a segment, Web Clipper keeps the completed lines and shows a localized error card with **Continue remaining** instead of treating the partial result as complete. Each batch asks for translations with their segment IDs in a fixed JSON shape, which the provider enforces when it supports structured output. Complete lines from a reply cut off by the provider's output limit are kept. A batch whose reply cannot be read at all stops the run with completed lines kept, and **Continue remaining** resumes from there.

After translations load, select **Bilingual subtitles** again to hide or show them without another model request.

Open **Study** for local playback tools that do not use AI: repeat the active sentence, set an A–B loop, pause after each sentence, or change playback speed. Keyboard shortcuts are `R` for sentence repeat, `P` for auto-pause, `[` and `]` for speed, and `Shift+A`/`Shift+B` for loop points. Existing playback shortcuts such as Space, K, J, and L continue to work.

Select **Edit translations** to correct a generated line in place. Corrections are saved with the transcript's session result and do not make a model request.

For Japanese transcripts from either source, select **Japanese readings** to add hiragana readings above kanji in the original transcript. Select it again to hide or show the readings without another model request. Select or press Enter on an individual ruby annotation to hide it for recall practice, then activate it again to reveal the answer. For a transcript identified as Japanese, the control is hidden when there is no kanji to annotate.

For a non-Japanese transcript, **Japanese readings** first translates the selected range into Japanese and then generates readings for the Japanese text. Each stage can create multiple provider or local CLI requests for a long range, as described for translations. Both stages start only from the explicit action; restoring a saved result on reload never starts a request.

The original subtitle remains visible. If **Bilingual subtitles** is also enabled, its ordinary translation remains a separate line, followed by the Japanese translation with readings. Turning off **Japanese readings** hides the entire Japanese learning line. **Regenerate readings** regenerates only hiragana readings; it does not retranslate the Japanese text or clear personal reading overrides.

Long transcripts are processed in batches, with smaller batches for Japanese readings because their output is larger than the source text. Progress counts completed subtitle segments rather than model batches. If a batch fails or is cancelled, completed segments remain saved; selecting **Continue remaining** or **Japanese readings** again sends only missing segments.

When an API provider reports that it is rate limited (HTTP 429) or has a temporary server error (HTTP 500, 502, 503, 504, or 529), Web Clipper waits and retries that batch automatically, up to two times per batch and within a limit for the whole job. The task bar shows how long it will wait, such as *Provider busy, retrying in 5 s…*. Web Clipper waits at least as long as the provider's `Retry-After` header asks, and does not retry when the provider asks for more than 60 seconds. Quota, authentication, and network errors, and API request timeouts, are never retried automatically.

After a local CLI timeout, for translations and Japanese readings alike, Web Clipper automatically halves the batch size and continues with the remaining segments, up to three times per run and not below a safe minimum, without showing an intermediate timeout card. If the smaller batches still time out, the error card says that some batches could not be completed and offers **Continue remaining**, which sends only the remaining part with the smaller batch size.

The job runs in the extension background, not in the Reader page. Closing or reloading the Reader tab does not stop it: completed batches keep being saved. When you return, selecting the same action for the same range joins the running job or shows its saved result instead of starting over. Selecting **Cancel**, loading another transcript in the same Reader, or navigating the Reader to an article without a transcript stops the job. If the browser stops the extension background while a job runs, Web Clipper resumes the job when the background starts again within 10 minutes and sends only the missing batches; an older job is kept as incomplete for **Continue remaining**.

After readings load—even for **Current segment** or **Next 5 minutes**—select **Edit readings**, edit a reading directly above its kanji, then select **Done editing**. Select **Regenerate readings** when the model chose the wrong reading; this explicitly reruns reading generation for the selected range while preserving readings outside that range. Corrections are stored with the transcript's session result and in your persistent personal reading dictionary. Known words are reused in later transcripts, and a segment whose kanji are all covered by the dictionary is annotated locally without an AI request.

> [!note] Session results
> Transcript translations, Japanese readings, and manual corrections are stored in extension session storage, not in the webpage. Reader reads and saves them through the extension background, so the host page cannot access them. They survive closing or reloading the Reader and extension background restarts in supported Chromium and Firefox versions, but are cleared when the browser session ends. Web Clipper keeps up to 20 recent transcript results and removes the oldest first. Browsers without extension session storage keep results in memory only while the extension background runs. Restoring a saved result and saving corrections never send a request and work even while AI features are disabled. These results are not automatically added to the clipping.

## Explain a word

Double-click a word in a supported Reader transcript. Web Clipper opens an explanation card containing:

- The lemma and pronunciation.
- The meaning in the current transcript context.
- A concise usage note.
- An example sentence.

Double-clicking a word does not intentionally seek playback. The Reader delays or restores the normal single-click seek when it detects a double-click.

From the explanation card, you can **Favorite** the item, **Copy** the text, or **Add to Obsidian**. Favorites are stored locally in the extension and appear in the **Learning Center**. Saving to Obsidian uses the vault and folder selected in Reader settings and does not make another AI request.

The Learning Center supports search, word/sentence filters, multi-select removal or Obsidian export, JSON import/export, and clear-all. Its **Japanese readings** tab lets you add, remove, import, or export personal readings. Export copies versioned JSON to the clipboard; import reads a JSON file. These local management actions do not call a model.

## Explain a phrase or sentence

Select a phrase, sentence, or text spanning adjacent transcript segments. Then select **Explain with AI** next to the selection.

The explanation includes a natural translation, the grammar structure, and important expressions in context. The same response language, selection kind, text, and context are cached for the current Reader session, so reopening the same explanation does not create another model request. Changing the response language creates a new explanation instead of reusing one in the previous language. While a new explanation is loading, its card shows **Cancel**; selecting it, closing the card, or pressing Escape cancels that explanation, so no late result or error appears. A running transcript task is not affected. A failed explanation can be retried from its error card.

The selection action also works with touch selection on mobile browsers that support Reader transcripts. While an explanation or error card is open, the Reader behind it is inactive and keyboard focus stays inside the card. Press Escape to close it and return focus to the control that opened it.

## Model selection and requests

Each language-learning task uses the model **Settings → AI → Task routing** names for it: **AI edit** for AI edits, **Subtitle translation** for bilingual transcripts, **Japanese readings** for readings (and the Japanese translation before them), and **Explanations** for word and sentence explanations. A task set to **Use default** uses the default model. When a Reader request fails, the error card lists your enabled models; **Switch and retry** routes the task that failed to the chosen model and runs it again. A Codex CLI model's model ID and reasoning effort apply to each of its requests; effort availability depends on the selected model, and higher effort can take longer and use more tokens.

The Reader error card shows what went wrong and what to do next, with the provider's raw message under **Technical details**. Its actions are:

- **Try again** runs the same request again: the same transcript range or the same selection. After a transcript job completed part of its range, the button reads **Continue remaining** and sends only the missing segments.
- **Switch and retry**, next to a list of your enabled models, as described above. As in **Task routing**, the list shows each model's name under its connection, and it starts on the model the failed request used.
- **Open AI settings**, when the fix is in Settings, such as a missing or rejected API key, AI features that are not set up, or a Native Messaging Host or CLI that is not installed. It opens the **AI** section of Web Clipper settings in a new tab.

The card's buttons respond only to your own clicks, not to clicks generated by the web page.

All provider and local CLI requests run in the extension background. API keys are not inserted into the page or transcript DOM. A local CLI connection sends the relevant content to the local Native Messaging Host and then to the selected CLI.

The following actions can create model-provider usage:

- Generating an AI-edit preview.
- Translating a transcript. A long transcript can create multiple requests, up to three at the same time for a hosted API provider, plus automatic retries.
- Generating Japanese readings for a transcript. For non-Japanese source subtitles, the preceding Japanese translation and the reading stage can each create multiple requests in the same way.
- Explaining a new word, phrase, or sentence that is not already cached for the session.
- Selecting **Test** on a connection in **Settings → AI**, when the connection shows the cost note: a structured-output probe or a 1-token request for an API provider, or one CLI run per Codex CLI model (one for Grok CLI). A Test without the cost note only lists models; if the provider has no model list, that Test fails instead of sending a billable request.

Applying, cancelling, undoing, hiding, or showing an existing result does not make another model request.

> [!warning] Transcript jobs can create several billable requests
> One transcript action can send several batch requests to a hosted API provider at the same time. Each automatic retry after a rate limit or temporary provider error is a separate request that the provider may bill, and a job that resumes after an extension background restart sends its remaining batches without another click. Use **AI range** to limit the work, and select **Cancel** to stop further requests.

The task bar shows **Cancel** while a transcript task or an explanation runs, and selecting it stops both. Closing a loading explanation card, or selecting its **Cancel**, stops only that explanation. Cancelling a Reader request stops the extension from waiting for or applying that result. For a transcript job, it also stops further batches and any retry wait; completed batches stay saved. In API mode it aborts the provider fetch. In local CLI mode, protocol version 5 sends cancellation over the same Native Messaging port; the Host terminates the selected CLI process and force-kills it if it does not exit promptly.

## Troubleshoot language learning

### AI editing controls are missing

The controls start collapsed: look for **✦ Edit with AI…** below the note content. If it is missing, confirm that **Enable AI features** is on in **Settings → AI**, and that **Task routing** names an enabled model for **AI edit** or as the default model. For a local CLI, confirm that the Native Messaging Host is installed and the CLI is installed and authenticated. Reload the popup after changing AI settings.

For a local CLI, **Local CLI host is out of date** means the extension was rebuilt without reinstalling the Host. **CLI not found** means the CLI's executable was not detected at install time or no longer exists; install the CLI, then run the install command again.

### Transcript language controls are missing

The controls are available only when Reader detects a supported YouTube or Bilibili player and a timed transcript. Bilibili transcript loading currently requires Chromium or Firefox. Some videos do not provide a transcript. On Bilibili, subtitle availability is determined by the player and can change.

### A translation is incomplete or stops partway

Select **Continue remaining**. Completed lines are kept, and only missing segments are sent. If the task bar shows *Provider busy, retrying*, the provider is rate limiting requests; wait for the retry or select **Cancel** and try again later. If the problem continues, choose **Current segment** or **Next 5 minutes**, choose another model with **Switch and retry** on the error card, or use a model with a larger context window.

### Japanese readings time out in CLI mode

Rebuild and reload the Chromium extension, then rerun the Native Messaging installer so the installed host matches the extension source. Confirm the selected CLI is authenticated. Grok reading requests run as single-turn transformations without built-in tools, web search, or cross-session memory; long transcripts still create multiple requests, one at a time. After a timeout, Web Clipper automatically halves the remaining batch size and continues from the last completed subtitle segment, up to three times per run and down to a safe minimum for atomic subtitle segments. If batches still time out, select **Continue remaining** to try again with the smaller batches.

### The provider returns an error

Check the connection's base URL and API key on this device, the routed model, quota, local-model server, or Native Messaging Host installation as appropriate. Select **Test** on the connection in **Settings → AI** to check it, and see **Settings → AI → Diagnostics** for recent requests with their outcome and HTTP status. For general setup and provider help, see [[Interpret web pages#Models|Interpreter models]] and [[Troubleshoot Web Clipper]].

## Current limitations

- Saved transcript results are session-scoped rather than permanent study history, and only the 20 most recent are kept. Saved vocabulary is persistent local extension data.
- A transcript job whose results grow too large for extension session storage keeps running and shows every result, but its progress is no longer saved: it cannot resume after an extension background restart, and a Reader reload does not restore it.
- Bilibili integration requires Chromium or Firefox, a public video with a Bilibili-provided timed subtitle track, and the in-page Reader; the standalone `reader.html` view does not have the live player session needed to load Bilibili subtitles.
- AI output quality and language accuracy depend on the selected model.
- Japanese names and context-dependent kanji readings may need manual correction.
- The separate Japanese translation created for non-Japanese subtitles cannot currently be edited or regenerated; **Regenerate readings** changes only the hiragana readings.
- The Learning Center does not implement spaced repetition or flashcard scheduling.

## Developer reference

For implementation boundaries, request flow, invariants, and verification commands, see [[development/Language learning MVP|Language learning MVP technical design]].
