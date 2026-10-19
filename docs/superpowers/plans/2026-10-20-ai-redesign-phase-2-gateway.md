# AI Redesign Phase 2: Gateway, Adapters, Host v5

Spec: [[2026-10-19-ai-subsystem-redesign-design]]. Previous: [[2026-10-19-ai-redesign-phase-1-domain-core]]. Branch: `ai-redesign`.

**Goal:** Route every model call through one background gateway. The gateway resolves the profile with `resolveProfile`, dispatches it to an explicit-kind adapter, and reports typed `AiError`s.

- Language learning moves first, then the popup Interpreter.
- Native CLIs move to Host protocol v5, which adds heartbeats and a shared argv builder.
- Prompt and response formats stay byte-compatible: the `prompts_responses` envelope is retired in Phase 3, not here.

## Constraints

- **Parity.** For every kind, the request URL, headers, and body match today's `llm-client.ts` branch. The only intended change is `stream: true` (below). The final text goes through the same envelope parser.
- **Settings stay v1-only.** Nothing writes v2. The gateway reads v1 through `deriveAiSettings`.
- **Static imports only.** Adapters and the gateway are DOM-free and statically imported into `background.ts`. No runtime chunk; `npm run test:bundle-boundaries` must stay green.
- **User actions only.** No request starts without an explicit user action. The client never retries automatically; the D4 retries arrive in Phase 4 with the JobRunner.
- **No credentials in messages.** Credentials never cross a message boundary. The gateway reads them from storage itself.
- **Prompt groups unchanged.** Transcript batching, checkpoints, and the CLI adaptive limits in `language-learning-runtime.ts` stay unchanged. Each prompt group becomes one gateway job.

## Decisions made here

1. **Streaming.** API adapters send `stream: true` and accumulate the stream:
   - OpenAI-style SSE for `openai-compatible`, `azure-openai`, `huggingface`, and `perplexity`;
   - Anthropic SSE `content_block_delta`;
   - Ollama NDJSON.

   An endpoint that ignores `stream` and answers `application/json` is parsed as before. Streaming makes bytes arrive within Chrome's 30 s `fetch` window and keeps the worker alive. It also prepares Phase 6's streamed `edit` and `explain`.
2. **Timeouts.** Timeouts become *idle* timeouts: 60 s without a byte (the v1 total limit), plus a 5 min hard cap, which matches the MV3 single-event limit. A long but steadily streaming answer no longer fails at 60 s.
3. **Keepalive.** While a job is pending, the client pings over its Port every 20 s. Port messages reset the service-worker idle timer, and `connectNative` keeps CLI jobs alive.
4. **Cooldown removed.** The 60 s Interpreter cooldown is removed. It was per-popup module state, and the Interpret button is disabled after any result, so it was unreachable. The gateway does not reintroduce a global cooldown.
5. **Legacy error codes for language learning.** Language-learning errors are converted back to the legacy `LanguageLearningRequestError` codes (`timeout`, `unavailable`, `protocol-mismatch`, `config`, …). This keeps the Reader card copy and engine-switch UI unchanged until Phase 6. API errors use the localized `describeAiError` text instead of raw provider text.
6. **Interpreter errors.** The popup Interpreter shows `describeAiError` title and body, with the raw detail in the console. It honors the popup's model select through an explicit `profileId`.
7. **Host v5.**
   - `executeCli` requests may set `heartbeat: true`. Only the port path sets it, because the `sendNativeMessage` path takes the first message as the response.
   - The Host then emits `{ type: 'heartbeat', requestId, elapsedMs }` every 10 s.
   - A v4 Host rejects v5 requests with `protocol-mismatch`, which maps to `host-outdated` (copy the install command).
   - The installer and the companion package copy `cli-invocation.mjs` beside the Host.

## Files

| File | Change |
| --- | --- |
| `native-host/cli-invocation.mjs` + `.d.mts` | `buildCliArguments({ mode, prompt, model?, effort? }) → { args, input }`. The argv lives here and nowhere else. |
| `native-host/obsidian-clipper-host.mjs` | Protocol 5, uses the shared builder, heartbeat timer per running request |
| `scripts/install-native-host.mjs`, `scripts/package-native-host.mjs` | Copy `cli-invocation.mjs` |
| `src/utils/native-cli-contract.ts` | Protocol 5, optional `heartbeat`, heartbeat message type |
| `src/utils/native-cli-service.ts` | Forward heartbeats to `onHeartbeat`, never settle on them |
| `src/utils/cli-execution.ts`, `src/cli.ts` | Use the shared builder, add `--model` / `--effort` |
| `src/ai/prompt-envelope.ts` | Envelope system prompt, prompt payload, tolerant parser (moved verbatim from `llm-client.ts`) |
| `src/ai/adapters/http.ts` | Request builders per API kind, stream readers, `executeApiCall` with idle and hard timeouts, abort, `classifyHttpStatus` |
| `src/ai/adapters/native-cli.ts` | `executeCliCall` over `native-cli-service`, mapping kind, model, and effort |
| `src/ai/protocol.ts` | Port message types, `serializeAiError` / `deserializeAiError` |
| `src/ai/gateway.ts` | Background Port handler: job registry, resolve, dispatch, cancel, attach, keepalive, disconnect policy |
| `src/ai/client.ts` | UI-side `runAiTask(task, input, { profileId?, signal?, onProgress? })` over one Port per job |
| `src/background.ts` | Register the gateway. Remove the `languageLearningRequest`, `languageLearningCancel`, and `nativeCliRequest` handlers |
| `src/utils/language-learning.ts` | Requests carry `task` |
| `src/utils/language-learning-runtime.ts` | `sendRequest` → `runAiTask`, plus AiError → legacy error conversion |
| `src/utils/interpreter.ts` | `handleInterpreterUI` → `runAiTask('interpret', …)` |
| Deleted | `src/utils/llm-client.ts`, `src/utils/language-learning-service.ts`, `src/utils/native-cli-client.ts` and their tests (behavior re-covered by the new tests) |
| `scripts/extension-e2e.mjs` | Mock OpenAI-compatible SSE endpoint, end-to-end gateway request from an extension page |
| Docs | `docs/Interpret web pages.md` (reinstall Host for v5, streaming, error messages), `docs/development/Language learning MVP.md` (gateway architecture), AGENTS.md seam table |

## Port protocol (`ai` port)

```ts
// client → gateway
{ type: 'start'; jobId; task: AiTask; profileId?: string; input: PromptsInput }
{ type: 'cancel'; jobId }
{ type: 'attach'; jobId }
{ type: 'ping' }
// gateway → client
{ type: 'progress'; jobId; phase: 'started' | 'heartbeat' | 'receiving'; elapsedMs: number; receivedChars?: number }
{ type: 'result'; jobId; responses: Record<string, unknown>; connectionKind: ConnectionKind }
{ type: 'error'; jobId; error: SerializedAiError }

interface PromptsInput { context: string; prompts: PromptVariable[]; maxTokens?: number }
```

**Registry.** The registry is in memory and keyed by `jobId`. Each entry holds an `AbortController`, its listener ports, and the final outcome for 60 s so that `attach` can replay it. A duplicate `start` for a live `jobId` fails with `provider-error`.

**Disconnect policy.** When the last listener disconnects:

- `interpret`, `edit`, and `explain` jobs are aborted.
- `translate` and `reading` jobs run to completion. A pending `fetch` does not reset Chrome's service-worker idle timer, so while any job is unfinished the gateway calls `runtime.getPlatformInfo()` every 20 s. No caller sends `attach` yet; the 60 s outcome retention is groundwork for Phase 4's durable reattach.

## Tasks (each commit green)

1. **Host v5 and shared invocation.**
   - Tests: the Host argv is unchanged for the Grok and Codex matrix; the CLI argv now includes model and effort; heartbeat emission uses fake timers; there is no heartbeat without the flag; a v4 request gets `protocol-mismatch`; the installer copies both files.
2. **Envelope and HTTP adapters.**
   - Port every `llm-client.test.ts` case to `adapters/http.test.ts`, with a parity table of URL, headers, and body per kind.
   - Add SSE, Anthropic, and NDJSON stream fixtures, including chunk boundaries split mid-line; a JSON fallback; error events mid-stream; HTTP statuses through `classifyHttpStatus`; idle timeout; hard cap; and abort.
3. **CLI adapter.** Model and effort only for Codex, heartbeat to progress, `toAiError` mapping.
4. **Protocol, gateway, and client.**
   - Gateway tests use fake ports: resolve failures; dispatch per kind; cancel; attach replay; the disconnect policy; ping; a duplicate job; error serialization round trip.
   - Client tests: keepalive timer, abort sends `cancel`, and a Port disconnect before a result maps to a retryable `network` error.
5. **Language learning on the gateway.** Runtime tests cover task routing per method, legacy error conversion, and that cancellation still yields `RequestCancelledError`. Delete the service and its handlers.
6. **Interpreter on the gateway.** Interpreter tests cover `profileId` passthrough, the responses mapping, and localized error display. Delete `llm-client.ts`, `native-cli-client.ts`, and the `nativeCliRequest` handler.
7. **E2E and docs.** Run the mock-provider e2e, then update docs, locales (if any), and AGENTS.md.
8. **Verify.**
   - Run the full suite, `tsc`, `npm run build`, `npm run build:cli`, `npm run test:bundle-boundaries`, the Chrome e2e, and `git diff --check`.
   - Confirm `dist/background.js` has no DOM use and no runtime chunk.
   - Fable reviews the diff.

## Out of scope

Persisted v2 settings, task routing UI, removing the envelope and adding structured output (Phase 3), JobRunner, concurrency, and D4 retries (Phase 4), Settings and Test (Phase 5), and UI unification (Phase 6).
