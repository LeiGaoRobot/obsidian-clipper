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
> The same configured providers and models power AI clipping edits, bilingual YouTube transcripts, and contextual word or sentence explanations. See [[Language learning]].

![[web-clipper-interpreter-demo.mp4#interface]]

## Examples of prompts

Prompts use the [[Variables|variable]] syntax `{{"your prompt"}}`. You can use this syntax with any natural language query, e.g.

- `{{"a summary of the page"}}` to extract a summary of the page.
- `{{"a three bullet point summary, translated to French"}}` to extract bullet points about the page, and translate them to French.
- `{{"un resumé de la page en trois points"}}` to extract three bullet points using a prompt in French.

The output of your prompts can be further manipulated using [[Filters]]. Filters are processed after the prompt response is received from the model. For example: `{{"a summary of the page"|blockquote}}` will turn the response into a blockquote.

## Get started

Interpreter works with almost any language model provider, including options that run privately on your device. To set up Interpreter:

1. Go to the **Interpreter** section in Web Clipper settings.
2. Toggle on **Enable Interpreter**.
3. Configure your provider and model, see [[Interpret web pages#Models|models]] section below.
4. Add [[Variables|prompt variables]] to your [[Obsidian Web Clipper/Templates|templates]].
5. If your template includes prompt variables, the Interpreter section will be visible when you [[Clip web pages|clip a page]]. Click **interpret** to process the prompt variables.

### Local Grok and Codex CLI modes

On Chrome, Interpreter can send the page context to a locally installed and authenticated Grok or Codex CLI through Native Messaging. This is useful when you want to reuse a CLI login instead of configuring an API provider.

1. Build and load the Chromium extension from this repository.
2. In **Settings → Interpreter**, choose **Grok CLI** or **Codex CLI** under **Execution mode**.
3. Select **Copy install command**. A local unpacked build inserts the current extension ID and source path for you.
4. Run the copied command once from any Terminal directory, then reload the extension.
5. Select **Check connection** to verify the Host protocol and detected executable path without sending page content.

The installer records the executable paths it finds for `grok` and `codex`. Rerun the installer after updating the repository so the installed Host protocol stays in sync. This version uses Host protocol 5; an older Host reports an outdated-Host error until you rerun the installer. Chrome does not allow an extension page to silently register a Native Messaging Host, so the copied command remains a one-time explicit system-installation step. The local source path is available to an unpacked development build but is excluded from packaged release ZIPs; packaged builds use the separately distributed Native Messaging Host companion. The CLI request runs in a read-only/ephemeral mode and returns one JSON response for all prompt variables. Grok runs as a single-turn transformation without built-in tools, web search, or cross-session memory. The guided Native Messaging installer currently supports Google Chrome on macOS and Linux; install and authenticate the selected CLI before using it. This action sends the page context to the local CLI and may use that CLI's account or subscription.

> [!note] Firefox data disclosure
> Firefox lists website content as required transmitted data because Interpreter can send the current page context to the provider or local CLI you choose. Granting the permission does not start a request. Manual Interpreter and language-learning actions send content only after you activate them; **Automatically run** sends content only when you have explicitly enabled that setting. This disclosure requires Firefox 140 or newer on desktop and Firefox for Android 142 or newer.

When you select **Codex CLI**, optional **Codex model** and **Codex reasoning effort** controls appear. Both apply to every Codex CLI Interpreter and language-learning action, and either can be left at its default independently. Reasoning effort choices are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; availability depends on the selected model. Higher effort can take longer and use more tokens. Unsupported model and effort combinations are shown as retryable CLI failures without automatic fallback. Changing either setting does not run a request, and **Check connection** verifies only the Host and executable. Codex CLI responses are constrained to the expected JSON shape through Codex's `--output-schema` option, using a temporary schema file that the Host deletes after each run.

## How it works

When Interpreter is enabled *and* your template contains [[Variables#Prompt variables|prompt variables]], a new Interpreter section is displayed in the extension window, above the **Add to Obsidian** button. This section lets you select a model and run Interpreter for the current page.

When you click **interpret**, Interpreter sends the page context to your selected model, along with *all* the prompts in your template in one request. Depending on the model provider you choose, this can be an external call or local to your device. The model evaluates your prompts against the page context, and returns its responses. Interpreter then replaces the prompt variables with the response data.

The whole process can take milliseconds or more than 30 seconds depending on the model you use and the amount of data you are processing. API responses are streamed, so long answers keep arriving instead of stalling. A request stops with a timeout error after 60 seconds without any data, or after five minutes in total. Closing the extension window cancels a running Interpreter request.

If a request fails, Interpreter shows what went wrong (for example a rejected API key, an unavailable model, a rate limit, or a missing local CLI) and what to do next. Select **Technical details** to see the provider's raw message.

## Context

The term *context* refers to the page data that Interpreter uses to process prompts. The smaller the context, the faster Interpreter runs. 

By default, Interpreter uses the entire page HTML as its context, however this can make prompts slower and more expensive than necessary.

You can override the default context in Interpreter **Advanced settings** and define context per [[Obsidian Web Clipper/Templates|template]].

To define a more targeted context use [[Variables#Selector variables|selector variables]] (or other variable types) to interpret a section of the page. For example, you could use the following selector variable in your template's Interpreter context:

```
{{selectorHtml:#main}}
```

 This would only run Interpreter on the `#main` element of a web page, if it exists. [[Filters#HTML processing|HTML processing filters]] like `remove_html`, `strip_tags` and `strip_attr` can be useful to further reduce the context length and speed up processing.

## Models

> [!warning] Privacy
> By using a third-party model provider you agree to their terms and privacy policy. Interpreter requests are sent directly to the provider you choose. Obsidian does not gather or store any data about your requests.

### Preset providers

Interpreter includes several preset providers. To use these providers you need an API key which you can get by logging into your provider's account. You will also need to decide which model(s) to use.

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

The DeepSeek preset recommends `deepseek-v4-flash` and `deepseek-v4-pro`. Existing models saved with the legacy `deepseek-chat` or `deepseek-reasoner` IDs remain editable as custom models; Web Clipper does not automatically migrate them. Update the model ID manually if the provider no longer accepts a legacy ID.

### Choosing a model

In general we recommend using small models with Web Clipper because they are faster and perform fairly accurately for this task. Examples of smaller models include **Anthropic's Claude Haiku**, **Google Gemini Flash**, **Llama** with 3B or 8B parameters, or **OpenAI's Mini** series of models.

### Custom providers and models

To add a custom provider and/or model go to Web Clipper **[[Settings]]** → **Interpreter**:

- **Add provider** to configure preset and custom providers.
- **Add model** to configure preset and custom models.

When adding a custom provider, we recommend that you use their chat completions endpoint for the **Base URL** — it typically ends with `/chat/completions`.

### Local models

Interpreter can use local models which offer greater privacy and offline compatibility. Several options for running local models exist. One of the easiest to configure is Ollama.

#### Ollama

[Ollama](https://ollama.com/) lets you run language models locally and privately on your device. 

Once you have downloaded and installed Ollama, add Ollama using **Add provider** in Interpreter settings. Ollama does not require an API key. Then choose a model from the [model list](https://ollama.com/search). For example if you want to use [Llama 3.2](https://ollama.com/library/llama3.2), click **Add model**, then:

- **Provider:** Ollama
- **Display name:** Llama 3.2, this value is customizable.
- **Model ID:** `llama3.2`, this must exactly match the model ID from Olllama.

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
