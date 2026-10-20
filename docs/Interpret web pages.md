---
permalink: web-clipper/interpreter
aliases:
  - Interpreter
---
Interpreter is a [[Introduction to Obsidian Web Clipper|Web Clipper]] feature that lets you interact with web pages using natural language. Interpreter helps you capture and modify data that you want to save to Obsidian. For example:

- Extract specific text fragments.
- Summarize or explain information.
- Convert text from one format to another.
- Translate text to a different language.

Interpreter leverages language models to process information on a web page, and return results using [[Variables]] that you can add to your [[Obsidian Web Clipper/Templates|Web Clipper Templates]].

> [!tip] Language learning
> The same connections and models power AI clipping edits, bilingual YouTube transcripts, and contextual word or sentence explanations. You choose a model per task in **Settings → AI → Task routing**. See [[Language learning]].

![[web-clipper-interpreter-demo.mp4#interface]]

## Examples of prompts

Prompts use the [[Variables|variable]] syntax `{{"your prompt"}}`. You can use this syntax with any natural language query, e.g.

- `{{"a summary of the page"}}` to extract a summary of the page.
- `{{"a three bullet point summary, translated to French"}}` to extract bullet points about the page, and translate them to French.
- `{{"un resumé de la page en trois points"}}` to extract three bullet points using a prompt in French.

The output of your prompts can be further manipulated using [[Filters]]. Filters are processed after the prompt response is received from the model. For example: `{{"a summary of the page"|blockquote}}` will turn the response into a blockquote.

## Get started

Interpreter works with almost any language model provider, including options that run privately on your device. To set up Interpreter:

1. Go to the **AI** section in Web Clipper settings.
2. Under **Connections**, select **Add API provider**, choose your provider (or **Custom**), and enter its API key. See [[Interpret web pages#Models|models]] below.
3. Under **Models**, add the model you want to use for that connection. The first model you add becomes the **Default model** in **Task routing**.
4. Optionally select **Test** on the connection to check the key and the model. See [[Interpret web pages#Test a connection|Test a connection]].
5. At the top of the **AI** section, turn on **Enable AI features**. Adding a model does not turn it on: if it is off when you add your first model, a note next to the switch says so.
6. Add [[Variables|prompt variables]] to your [[Obsidian Web Clipper/Templates|templates]].
7. If your template includes prompt variables, the Interpreter section will be visible when you [[Clip web pages|clip a page]]. Click **interpret** to process the prompt variables.

> [!info] API keys stay on this device
> API keys are stored only on the device where you enter them, in the browser's local extension storage, as plain text. They are not encrypted and do not sync to your other devices, which also keeps them out of the browser's sync storage limits. Connections, models, and task routing do sync. On another device a synced connection that needs a key shows **Key missing on this device** until you enter the key there.

> [!note] Upgrading from the Interpreter settings section
> The first time this version runs, it copies your providers, models, selected model, and Interpreter options into the **AI** section once, and leaves the previous settings unchanged in sync storage so an older version still works. API keys saved by the previous version are imported on each device where they are still present. A key you enter afterwards must be entered on each device. If you used **Grok CLI** or **Codex CLI** as the execution mode, that CLI is carried over as a connection; add the other one with **Add local CLI**. Model ordering is no longer used; choose the model per task in **Task routing** instead.

### Test a connection

Select **Test** on a connection in **Settings → AI → Connections** to check it. A Test runs only when you select it; adding, editing, or loading a connection never sends a request.

- For an API provider, Test first lists the provider's models with your key, which is free. The result says how many of the connection's models the provider lists, a model it does not list shows **Model not listed** under **Models**, and the listed models become the model ID suggestions.
- For a compatible server other than OpenAI's own API, such as DeepSeek, OpenRouter, or Gemini, Test then sends one minimal request to find the structured-output mode the server accepts: JSON schema, JSON object, or none. The mode is stored with the connection and used for later requests. This request needs a model, so a connection without one is only listed. If such a server has no model list, Test still sends the request. Providers without a model list, such as Azure OpenAI, Hugging Face, and Perplexity, get a minimal 1-token request instead.
- A Test that only lists models never falls back to a billable request. If the provider answers that it has no model list (HTTP 404, 405, or 501), the Test fails with that status and says what to check: the base URL, or, for a compatible server without a model, adding one so the next Test can send its minimal request.
- For a local CLI, Test checks the Native Messaging Host, then runs the CLI once with a short prompt: once for each enabled Codex CLI model, or once for Grok CLI.

> [!warning] Test may send a billable request
> A Test that sends a structured-output probe, a 1-token request, or a CLI run may be billed by the provider or count against your CLI plan. The connection shows this note above **Test** whenever it applies. A Test that only lists models, such as for OpenAI, Anthropic, or Ollama, is not billed.

The result is stored on this device. The connection's badge shows **OK**, or **Failing** with the reason, and a failing Test shows the error with an action such as **Try again** or **Copy install command**. **Test** waits while a settings change is being saved, and its result appears once a detected structured-output mode has been saved with the connection; if that save fails, the result shows the save error as well. Changing a connection's base URL clears its status and its detected structured-output mode; changing its API key, or a model of the connection, clears its status.

If a request on this device was rejected for its structured-output option and succeeded without it, this device keeps using requests without it for that connection. A Test that detects a mode replaces that, and a successful Test that sends no structured-output request, such as for OpenAI, Anthropic, or Ollama, clears it, so the connection's stored mode or its default applies again. In Safari, the Host check is a single message, and **Cancel** stops waiting but cannot stop a CLI run that has already started.

### Diagnostics

**Settings → AI → Diagnostics** lists the last 100 model runs and connection Tests in this browser, newest first: the task, connection, outcome, HTTP status, duration, structured-output mode, and, for transcript jobs, the number of groups and retries. Prompts, page content, API keys, and provider error text are never recorded. The list lives in the browser's session storage, so it is cleared when the browser closes. **Copy as JSON** copies it, for example for a bug report, and **Clear** empties it.

### Local Grok and Codex CLI connections

On Chrome, Interpreter can send the page context to a locally installed and authenticated Grok or Codex CLI through Native Messaging. This is useful when you want to reuse a CLI login instead of configuring an API provider.

1. Build and load the Chromium extension from this repository.
2. In **Settings → AI → Connections**, select **Add local CLI**, then **Add Codex CLI** or **Add Grok CLI**. Each CLI can be added once, and it gets a default model.
3. Select **Copy install command**. A local unpacked build inserts the current extension ID and source path for you.
4. Run the copied command once from any Terminal directory, then reload the extension.
5. In **Task routing**, choose the CLI's model for the tasks that should use it, or make it the **Default model**.

The installer records the executable paths it finds for `grok` and `codex`. Rerun the installer after updating the repository so the installed Host protocol stays in sync. This version uses Host protocol 5; an older Host reports an outdated-Host error until you rerun the installer. Chrome does not allow an extension page to silently register a Native Messaging Host, so the copied command remains a one-time explicit system-installation step. The local source path is available to an unpacked development build but is excluded from packaged release ZIPs; packaged builds use the separately distributed Native Messaging Host companion. The CLI request runs in a read-only/ephemeral mode and returns one JSON response for all prompt variables. Grok runs as a single-turn transformation without built-in tools, web search, or cross-session memory. The guided Native Messaging installer currently supports Google Chrome on macOS and Linux; install and authenticate the selected CLI before using it. This action sends the page context to the local CLI and may use that CLI's account or subscription. Firefox has no Native Messaging support here, so **Add local CLI** is hidden there, and a CLI connection synced from another browser shows **Unsupported in this browser**.

> [!note] Firefox data disclosure
> Firefox lists website content as required transmitted data because Interpreter can send the current page context to the provider or local CLI you choose. Granting the permission does not start a request. Manual Interpreter and language-learning actions send content only after you activate them; **Automatically run** sends content only when you have explicitly enabled that setting. This disclosure requires Firefox 140 or newer on desktop and Firefox for Android 142 or newer.

A Codex CLI model has an optional model ID and **Reasoning effort**. Add several Codex models to keep different model and effort combinations, and route each task to the one you want. Either value can be left at its default independently. Reasoning effort choices are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; availability depends on the selected model. Higher effort can take longer and use more tokens. Unsupported model and effort combinations are shown as retryable CLI failures without automatic fallback. Changing either setting does not run a request. For Interpreter answers, transcript translations, and Japanese readings, Codex CLI responses are constrained to the expected JSON shape through Codex's `--output-schema` option, using a temporary schema file that the Host deletes after each run. If the installed Codex CLI does not support that option, Web Clipper retries once without it and remembers the result for that connection.

## How it works

When AI features are enabled *and* your template contains [[Variables#Prompt variables|prompt variables]], a compact AI bar is displayed at the bottom of the extension window, directly above the vault and the **Add to Obsidian** button. The bar says how many AI prompts the template has (for example "2 AI prompts in this template"), and offers a model menu and **Run**. The model menu lists every enabled model, grouped by connection, and starts on the model **Task routing** names for Interpreter. Choosing another model there changes the Interpreter row of **Task routing**; choosing the default model sets the row back to **Use default**. The bar, the vault, and **Add to Obsidian** stay in view at the bottom of the window, in the popup and in the side panel, while the note above them scrolls.

Until Interpreter fills them, properties whose value is a prompt variable show a compact **✦ AI fills this** chip instead of the raw `{{"…"}}` prompt. Hover over the chip to see the prompt. Click the chip to show the original value and edit it. While Interpreter runs, the chip says **AI is filling this…**; after a failed run, or for a prompt the model left unanswered, it says **Not filled**. The chip only changes what the window shows: the note you add contains exactly what the property holds, and an unfilled prompt is saved as its `{{"…"}}` placeholder, as before.

When you click **Run**, Interpreter sends the page context to your selected model, along with *all* the prompts in your template in one request. Depending on the model provider you choose, this can be an external call or local to your device. The model evaluates your prompts against the page context, and returns its responses. Interpreter then replaces the prompt variables with the response data. When it is done, the bar turns quiet: it says the prompts were filled, how long it took, and which model filled them.

While Interpreter runs, the bar shows the elapsed time and a **Cancel** button in place of **Run**. Select **Cancel** to stop the request: the bar says the request was cancelled and offers **Run** again, Web Clipper sends no further request for that run, and nothing is filled in or saved. The provider may still bill for the part of the request it already processed. Select **Run** to run it again, also when **Automatically run** started the first run. If **Add to Obsidian** started or was waiting for the run you cancel, the note is not saved and the window stays open.

Interpreter asks the model for one JSON object with an answer for every prompt variable. Where the provider supports structured output (OpenAI, Azure OpenAI, Anthropic, Ollama, and most OpenAI-compatible servers), the provider enforces that shape; if a server rejects the structured-output option, Interpreter retries once without it and remembers that for the provider. If the model leaves out some prompts, Interpreter fills in the answers it did get and marks the result as partial instead of done. The unanswered prompts stay as `{{"…"}}` placeholders in the note, and a warning lists them. You can fill them in yourself, or add the note to Obsidian as it is. To interpret again, reopen Web Clipper. If you select **Add to Obsidian** while Interpreter is still running and the result comes back partial, Web Clipper keeps the window open so you can see the warning, and does not save the note. If the model answers none of the prompts, Interpreter shows an error instead. The command-line tool rejects a partial answer, because its output has no way to mark unanswered prompts.

The whole process can take milliseconds or more than 30 seconds depending on the model you use and the amount of data you are processing. API responses are streamed, so long answers keep arriving instead of stalling. A request stops with a timeout error after 60 seconds without any data, or after five minutes in total. Closing the extension window cancels a running Interpreter request.

If a request fails, the AI bar becomes a compact error card: a title that says what went wrong (for example a rejected API key, an unavailable model, a rate limit, or a missing local CLI), and one line naming the connection and model that failed, with the HTTP status when there is one. Select **Try again** to send the request again with the context and model the window shows at that moment. Selecting **Add to Obsidian** after an error also runs Interpreter again; if that run fails too, the error card stays and nothing is saved. When the fix is in Settings, such as a missing or rejected API key, AI features that are not set up, or a Native Messaging Host or CLI that is not installed, the card also offers **Open AI settings**, which opens the **AI** section of Web Clipper settings. Select **Details** to see what to do next and the provider's raw message. To choose another model first, close the card with **×**: the bar returns to the model menu and **Run**. The whole card, its buttons included, stays visible at the bottom of the window.

## Context

The term *context* refers to the page data that Interpreter uses to process prompts. The smaller the context, the faster Interpreter runs. 

By default, Interpreter uses the entire page HTML as its context, however this can make prompts slower and more expensive than necessary.

You can override the default context with **Default interpreter context** in **Settings → AI → Interpreter**, and define context per [[Obsidian Web Clipper/Templates|template]].

To define a more targeted context use [[Variables#Selector variables|selector variables]] (or other variable types) to interpret a section of the page. For example, you could use the following selector variable in your template's Interpreter context:

```
{{selectorHtml:#main}}
```

 This would only run Interpreter on the `#main` element of a web page, if it exists. [[Filters#HTML processing|HTML processing filters]] like `remove_html`, `strip_tags` and `strip_attr` can be useful to further reduce the context length and speed up processing.

## Models

> [!warning] Privacy
> By using a third-party model provider you agree to their terms and privacy policy. Interpreter requests are sent directly to the provider you choose. Obsidian does not gather or store any data about your requests.

### Preset providers

**Add API provider** lists several preset providers. To use these providers you need an API key which you can get by logging into your provider's account. You will also need to decide which model(s) to use.

| Provider           | API&nbsp;key                                                | Models                                                                               |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Anthropic          | [API&nbsp;key](https://console.anthropic.com/settings/keys) | [Models](https://docs.anthropic.com/en/docs/about-claude/models)                     |
| Azure&nbsp;OpenAI  | [API&nbsp;key](https://oai.azure.com/portal/)               | [Models](https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models) |
| DeepSeek           | [API key](https://platform.deepseek.com/api_keys)           | [Models](https://api-docs.deepseek.com/quick_start/pricing)                          |
| Google&nbsp;Gemini | [API&nbsp;key](https://aistudio.google.com/apikey)          | [Models](https://ai.google.dev/gemini-api/docs/models/gemini)                        |
| Hugging Face       | [API key](https://huggingface.co/settings/tokens)           | [Models](https://huggingface.co/models?pipeline_tag=text-generation&sort=trending)   |
| Meta               | [API key](https://llama.developer.meta.com)                 | [Models](https://llama.developer.meta.com/docs/models)                               |
| Ollama             | n/a                                                         | [Models](https://ollama.com/search)                                                  |
| OpenAI             | [API&nbsp;key](https://platform.openai.com/api-keys)        | [Models](https://platform.openai.com/docs/models)                                    |
| OpenRouter         | [API&nbsp;key](https://openrouter.ai/settings/keys)         | [Models](https://openrouter.ai/models)                                               |
| Perplexity         | [API key](https://www.perplexity.ai/settings/api)           | [Models](https://docs.perplexity.ai/guides/model-cards)                              |
| xAI Grok           | [API key](https://console.x.ai/team/default/api-keys)       | [Models](https://docs.x.ai/docs/models)                                              |

The DeepSeek preset suggests `deepseek-v4-flash` and `deepseek-v4-pro`. Existing models saved with the legacy `deepseek-chat` or `deepseek-reasoner` IDs keep their IDs; Web Clipper does not automatically migrate them. Edit the model ID if the provider no longer accepts a legacy ID.

### Choosing a model

In general we recommend using small models with Web Clipper because they are faster and perform fairly accurately for this task. Examples of smaller models include **Anthropic's Claude Haiku**, **Google Gemini Flash**, **Llama** with 3B or 8B parameters, or **OpenAI's Mini** series of models.

### Custom providers and models

To add a custom provider and/or model go to Web Clipper **[[Settings]]** → **AI**:

- **Connections → Add API provider** to configure preset and custom providers. Choose **Custom** for any other endpoint. Turn off **Requires API key** for a local server that accepts requests without a key. The option appears for **Custom** and for presets that can run without a key, such as Ollama; presets that always need a key, such as OpenAI, do not show it. Under **Advanced**, **Max concurrent requests** limits how many requests a long job, such as a transcript translation, sends to the connection at once.
- **Models → Add model** to add a model to a connection. The model ID field suggests the preset's popular models. Use the toggle to disable a model without deleting it; only enabled models appear in **Task routing** and model menus.
- **Task routing** to choose the **Default model** and, optionally, a different model for each task.

When adding a custom provider, we recommend that you use their chat completions endpoint for the **Base URL** — it typically ends with `/chat/completions`.

### Local models

Interpreter can use local models which offer greater privacy and offline compatibility. Several options for running local models exist. One of the easiest to configure is Ollama.

#### Ollama

[Ollama](https://ollama.com/) lets you run language models locally and privately on your device. 

Once you have downloaded and installed Ollama, add Ollama using **Add API provider** in **Settings → AI**. Ollama does not require an API key. Then choose a model from the [model list](https://ollama.com/search). For example if you want to use [Llama 3.2](https://ollama.com/library/llama3.2), select **Add model** under the Ollama connection, then:

- **Model ID:** `llama3.2`, this must exactly match the model ID from Ollama.
- **Display name:** Llama 3.2, this value is optional and customizable.

**Start the Ollama server**

To allow a browser extension to interact with Ollama you must [give it explicit instruction](https://github.com/ollama/ollama/issues/2308) when running the server, or else you will see a `403` error. 

Close the Ollama app, and run the following command in your terminal. The protocol should be changed to your browser's extension protocol if you don't use Chrome or Firefox.

```
OLLAMA_ORIGINS=moz-extension://*,chrome-extension://*,safari-web-extension://* ollama serve
```

Then run your model with Ollama the normal way, e.g.

```
ollama run llama3.2
```

**Context length**

Ollama's context window defaults to 2048 tokens. This is the maximum number of tokens for the message and response. When clipping a long web page you can easily exceed this limit. Ollama will silently fail and return irrelevant results. Some options:

- Increase Ollama's `num_ctx` parameter. Be mindful that longer context requires more memory.
- Use the [[#Context]] field in your template to provide a more targeted section of the page, or trim the context using a [[Filters|filter]] e.g. `{{content|slice:0,1000}}`.
