# Codex CLI Model Setting Design

## Goal

Allow users to choose a model for every Codex CLI-backed Interpreter and language-learning request without changing their global Codex configuration. Leaving the setting empty preserves the Codex CLI default.

## Scope

- Add one optional Codex model setting under **Settings → Interpreter**.
- Apply the setting to all Codex CLI requests, including Interpreter edits, bilingual subtitles, explanations, and other language-learning actions.
- Keep Grok CLI and API execution unchanged.
- Keep the existing explicit-user-action rule: changing the setting never starts a model request.

Reasoning effort, Codex profiles, provider selection, and dynamic model-catalog discovery are outside this change.

## User Interface

Add a localized **Codex model** text input that is visible only while **Execution mode** is **Codex CLI**. The input uses an HTML `datalist` to suggest these current model IDs while remaining editable:

- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`

The description explains that an empty value uses the Codex CLI default. Saving trims leading and trailing whitespace; an empty trimmed value is stored as absent.

## Settings and Data Flow

Add an optional `interpreterCodexModel` string to the existing general settings model and storage serialization. Existing installations receive no migration value and therefore retain current behavior.

For a Codex CLI request:

1. The existing Interpreter or language-learning caller reads `interpreterCodexModel` from loaded settings.
2. The Native CLI request builder includes the trimmed model as an optional `model` field.
3. The background Native Messaging service forwards the validated request unchanged.
4. The Native host adds `--model` and the model ID as separate `spawn` arguments before the prompt input marker.
5. Codex CLI resolves and executes the selected model.

When the model is absent, the request omits the field and the host emits the existing argument list unchanged. Grok requests must not carry or consume the Codex model field.

## Validation and Security

The extension accepts an editable model ID rather than maintaining a closed catalog. The request contract accepts the optional field only for Codex mode, trims it before construction, and rejects an explicitly supplied empty value or any value longer than 200 UTF-16 code units. The Native host repeats the same checks because it is the process boundary.

The model is passed as one argument in the existing `spawn(command, args)` call. It is never interpolated into a shell command, so spaces or punctuation cannot create additional CLI flags or commands.

## Error Handling

Unsupported, unavailable, or unauthorized model IDs are reported by Codex CLI. The Native host preserves the CLI failure and the existing UI presents it in the retry card's technical details. No automatic fallback to another model occurs because that would conceal the configured choice.

The connection health check continues to verify the host protocol and Codex executable without making a paid request. It does not validate model availability.

## Documentation and Localization

Add English and Simplified Chinese strings for the label, description, and placeholder. Update the Interpreter and language-learning documentation to explain:

- the setting affects every Codex CLI action;
- an empty value uses the CLI default;
- model availability depends on the user's Codex account and authentication;
- model requests may create usage or cost according to the user's Codex setup.

## Testing

Cover the behavior through existing seams:

- settings loading, trimming, visibility, saving, and empty-value fallback;
- storage round-trip for `interpreterCodexModel`;
- Native CLI request construction and validation for Codex versus Grok;
- all Codex execution callers forwarding the configured value;
- Native host invocation including `--model <id>` and preserving the previous arguments when unset;
- localized settings markup and affected documentation/build checks.

Completion requires focused tests, the full timezone-pinned test suite, TypeScript checking, the Chrome build, Native host packaging, and `git diff --check`.
