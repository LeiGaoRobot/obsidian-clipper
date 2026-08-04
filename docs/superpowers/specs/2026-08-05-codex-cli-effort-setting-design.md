# Codex CLI Effort Setting Design

**Date:** 2026-08-05

## Goal

Allow users to choose the reasoning effort used by every explicit Codex CLI action in Web Clipper. Preserve existing behavior by leaving the setting unset by default, which lets Codex CLI and the selected model choose their own default effort.

## Scope

This change applies only to the existing Codex CLI execution mode. It does not change API-provider or Grok CLI requests, model selection, automatic-run safeguards, credentials, sandboxing, or retry behavior.

## User experience

Add a `Codex reasoning effort` select below the existing Codex model field. Show both controls only when the execution mode is Codex CLI.

The select contains:

- `Default` (stored as no value)
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`
- `max`
- `ultra`

`max` and `ultra` remain selectable because current Codex model guidance exposes them, although support depends on the selected model. The extension does not attempt to infer model compatibility.

## Persistence

Add an optional `interpreterCodexReasoningEffort` setting with a closed string union for the seven explicit values. Loading settings accepts only allowlisted values; missing or unknown stored values normalize to `undefined`, which appears as `Default`. Saving `Default` omits the property.

The model and effort settings are independent. Either may be unset, set alone, or set together.

## Request flow

1. The Interpreter or language-learning caller loads the stored settings in the background.
2. Only Codex mode forwards the optional effort alongside the optional model.
3. Native Messaging protocol version increases from 3 to 4 and adds an optional canonical `effort` field to Codex execution requests.
4. The extension validates the field against the closed allowlist when building the request.
5. The Native Messaging Host repeats the same allowlist validation and rejects effort on Grok requests.
6. When effort is set, the Host launches Codex with two separate spawn arguments:

   ```text
   -c
   model_reasoning_effort="max"
   ```

7. When effort is unset, the Host adds no related arguments, preserving the Codex CLI or model default.

The Host continues to pass arguments directly to `spawn` without a shell. Model and effort values never travel through page DOM, content-script controls, or credentials-bearing messages.

## Compatibility

Protocol v4 intentionally makes an older v3 Host incompatible so it cannot silently ignore the new setting. Existing protocol-mismatch handling tells the user to reinstall the Native Messaging Host.

The setting does not check whether a selected model supports a particular effort. If Codex CLI rejects the combination, the request uses the existing `cli-failed` path and shows the failure. The extension does not silently downgrade effort, retry with another value, or change the selected model.

## Safety and cost behavior

This setting does not create requests by itself. All existing trusted-event and explicit-user-action requirements remain in force. Higher effort may increase latency and token usage, so the settings description and user documentation must state that consequence.

## Validation and errors

- Stored missing or unknown effort values normalize to `Default`.
- Explicit invalid values passed to the extension request builder throw a validation error.
- The Host rejects unknown values and rejects effort on non-Codex requests.
- Empty strings are not canonical request values; callers omit the field instead.
- CLI/model incompatibility is reported through the existing CLI failure UI.

## Testing

Add focused tests for:

- normalization of all seven explicit values, empty values, and unknown values;
- settings load, save, omission, and invalid stored data;
- Codex-only visibility and form persistence in the settings UI;
- protocol-v4 request construction and validation;
- Host validation and the exact `-c`, `model_reasoning_effort="value"` argument pair;
- unset, effort-only, model-only, and model-plus-effort invocations;
- Interpreter, language-learning, and observable Native Port forwarding;
- Grok and API isolation;
- cancellation behavior remaining unchanged;
- protocol mismatch behavior for an older Host.

Run the focused tests during implementation, then the repository's full test, type-check, and browser build commands. Package and reinstall the Native Messaging Host before a non-billable protocol-v4 health smoke test. If browser policy permits, verify the Codex-only settings controls and persistence in the unpacked extension without sending page content.

## Documentation and localization

Add English and Simplified Chinese strings for the label, description, default option, and compatibility/cost wording. Update the Interpreter, language-learning, introduction, and development documentation to describe the optional effort override, protocol v4, model-dependent support, and the absence of automatic fallback.

## Non-goals

- No generic arbitrary Codex configuration input.
- No model/effort preset pairing.
- No automatic effort selection based on model.
- No automatic fallback from unsupported effort values.
- No change to Grok CLI or API-provider behavior.
