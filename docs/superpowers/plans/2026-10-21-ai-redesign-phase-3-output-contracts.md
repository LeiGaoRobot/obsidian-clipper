# AI Redesign Phase 3: Output Contracts

Spec: [[2026-10-19-ai-subsystem-redesign-design]]. Previous: [[2026-10-20-ai-redesign-phase-2-gateway]]. Branch: `ai-redesign`.

**Goal:** Give every AI task a typed output contract and remove the `prompts_responses` envelope and its regex repair. Where a connection supports it, the provider enforces the output shape through structured output.

## Constraints

- **Same callers, typed results.** `runAiTask(task, input)` takes a task-specific input and resolves a task-specific output. Popup, Reader, and `src/cli.ts` change in this phase; their UI does not.
- **Prompts stay with their feature.** `language-learning.ts` still builds the feature instructions ("Translate into X", the ruby rules). `src/ai/contracts.ts` adds only the output rules, the schema, and validation.
- **Alignment invariant.** Transcript groups keep stable numeric segment IDs. A contract returns only items whose IDs were requested and whose values validate. Missing segments stay missing, so the existing checkpoint and "retry only missing" behavior is unchanged. A transcript is never reported as complete while a segment is missing.
- **No new settings.** Structured-output capability is detected and cached, not configured. The Phase 5 Settings Test replaces the stub probe.
- **MV3 and boundaries.** Contracts are DOM-free and statically imported. `src/cli.ts` (Node) imports the shared contract module too, and `npm run build:cli` must stay green.
- **Host v5 is unreleased.** This branch has not shipped Host v5, so its optional `outputSchema` field is added to v5 without a version bump.

## Decisions made here

1. **Contracts per task.**

   | Task | Input | Output | Shape on the wire |
   | --- | --- | --- | --- |
   | `interpret` | `context`, `prompts: {key, prompt}[]` | `Record<key, string>` | `{ "prompt_1": "…", … }` with every key required |
   | `edit` | `instruction`, `content` | `string` | plain text |
   | `explain` | `instruction`, `content` | `string` | plain text |
   | `translate` | `instruction`, `segments: {id, text}[]` | `{id, text}[]` | `{ "translations": [{ "id": 0, "text": "…" }] }` |
   | `reading` | `instruction`, `segments: {id, text}[]` | `{id, tokens: {text, reading}[]}[]` | `{ "readings": [{ "id": 0, "tokens": [{ "text": "…", "reading": "…" }] }] }` |

   - JSON roots are objects so one schema works with OpenAI `json_schema`, Anthropic tool input, Ollama `format`, and Codex `--output-schema`.
   - Schemas follow the strict subset: every property required, `additionalProperties: false`, and no tuples.
   - Readings move from `[text, reading]` tuples to objects. The `reading` output budget rises from 2.5× to 4× the source characters, still capped at 12 000 tokens.
2. **Messages.** Each contract renders a system message (role, output rules, and the shape in prose) and one user message with the content. All kinds now send a single user message. v1 sent two, and Perplexity already needed one. Ollama no longer forces `format: 'json'` on text tasks.
3. **Structured output modes.**

   | Kind | Default when unknown | Mechanism |
   | --- | --- | --- |
   | `openai-compatible` | `json_schema` for `api.openai.com`, otherwise `json_object` | `response_format` |
   | `azure-openai` | `json_schema` | `response_format` |
   | `anthropic` | `tool` | forced `tool_choice` on one `respond` tool with `input_schema`; streamed `input_json_delta` is accumulated |
   | `ollama` | `format` | `format: <schema>` |
   | `huggingface`, `perplexity` | `none` | prompt rules only |
   | `cli-codex` | `schema` | Host writes the schema to a temp file and passes `--output-schema` |
   | `cli-grok` | `none` | prompt rules only |

   Text tasks never request structured output.
4. **Fallback.** If a structured request fails with HTTP 400 and the body mentions `response_format`, `json_schema`, `schema`, `tool`, or `format`, the gateway retries once with `none` and caches the downgrade. This is the spec's non-billable correction; it is separate from the D4 retries.
5. **Capability cache.** `storage.local` key `ai_structured_output` maps a connection ID to `{ baseUrl, mode }`. An entry whose `baseUrl` no longer matches is ignored. Phase 5 folds the cache into `Connection.structuredOutput` and fills it from Test. `probeStructuredOutput` exists now as a stub that returns the cached or default mode without sending a request.
6. **Tolerant JSON parsing.** Without enforcement, a JSON response may arrive wrapped in a code fence or in prose. The parser takes the first top-level JSON object that validates, reusing the scanner from `cli-execution-contract.ts`. The quote-repair regexes are deleted.
7. **Validation outcomes.**
   - `interpret`: no JSON object, or no requested key → `bad-response`; some keys missing → the answered keys with `missing` listed. The Interpreter shows a partial result, and the CLI rejects it as `incomplete` (amended after the Phase 3 review). Values are coerced as v1 did: strings stay, other values are stringified.
   - `translate` / `reading`: no JSON object, or no valid item at all → `bad-response`. Otherwise valid requested items are returned and missing ones stay missing (constraint above).
   - `edit` / `explain`: empty text → `bad-response`.
8. **Codex output schema.** `executeCli` requests may carry `outputSchema` (an object, serialized ≤ 20 000 characters, Codex mode only). The Host writes it to a file in a fresh temp directory, appends `--output-schema <file>`, and removes the directory when the CLI settles. `src/cli.ts` keeps prompt rules only.
9. **Envelope removed everywhere.** `src/ai/prompt-envelope.ts` is deleted. The Native CLI prompt (`buildExecutionPrompt`) and `parsePromptResponses` use the `interpret` contract, so the extension, Host requests, and `src/cli.ts` change in the same commit.

## Files

| File | Change |
| --- | --- |
| `src/ai/contracts.ts` | Task inputs and outputs, `renderMessages`, `outputSchema`, `parseOutput`, tolerant JSON extraction |
| `src/ai/capabilities.ts` | Default mode per kind and URL, cache read/write interface, `probeStructuredOutput` stub |
| `src/ai/adapters/http.ts` | Request from `{ system, user, structured? }`; per-kind structured fields; Anthropic `input_json_delta`; no envelope; `finalizeText` removed |
| `src/ai/adapters/native-cli.ts` | Takes a rendered prompt and optional `outputSchema`; returns raw stdout for the contract to parse |
| `native-host/cli-invocation.mjs` + `.d.mts`, `native-host/obsidian-clipper-host.mjs` | `outputSchemaPath` argument; `outputSchema` validation; temp file lifecycle |
| `src/utils/native-cli-contract.ts` | `buildNativeCliRequest(mode, prompt, options)` with optional `outputSchema` |
| `src/ai/protocol.ts` | Task-typed `start` input and `result.output`; per-task validation and size bounds |
| `src/ai/gateway.ts` | Contract dispatch, structured mode resolution, 400 fallback, cache writes |
| `src/ai/client.ts` | `runAiTask<T extends AiTask>(task, input: AiTaskInput<T>) → AiTaskOutput<T>` |
| `src/background.ts` | `storage.local`-backed capability cache |
| `src/utils/language-learning.ts` | Typed `sendRequest`; segment arrays instead of `ID|||` lines; result validation per segment |
| `src/utils/language-learning-runtime.ts`, `src/utils/interpreter.ts` | Typed results |
| `src/utils/cli-execution-contract.ts`, `src/utils/cli-execution.ts` | Interpret contract prompt and parser |
| Deleted | `src/ai/prompt-envelope.ts` and its test |
| `scripts/extension-e2e.mjs` | Mock answers the bare interpret object and asserts `response_format: json_object` |
| Docs | `docs/development/Language learning MVP.md`, `docs/Language learning.md`, `docs/Interpret web pages.md`, AGENTS.md seam table |

## Tasks (each commit green)

1. **Contracts and capabilities** (pure, test-first). Cover messages per task, schemas (strict subset), parsing with fences and prose, missing keys, unknown and duplicate IDs, invalid tokens, empty text, and default modes per kind and URL.
2. **HTTP adapter on contracts.** Cover the request body per kind × mode, Anthropic tool streaming, and JSON fallback bodies.
3. **Codex output schema in the Host.** Cover validation, argv, temp-file cleanup on success, failure, and cancel, plus the request builder and the adapter.
4. **Gateway and protocol on contracts.** Cover typed results, the 400 fallback and cache write, the cached mode, CLI `outputSchema` for Codex only, and validation errors.
5. **Callers on contracts.** Move `language-learning.ts`, the runtime, the Interpreter, and `src/cli.ts`; delete the envelope. Cover transcript alignment, incomplete groups, long batches, retry of missing segments, and reading token validation.
6. **E2E, docs, verify, review.** Run the full suite, tsc, the three builds, `build:cli`, `build:api`, bundle boundaries, the Chrome e2e, and `git diff --check`, then get a Fable review.
