# Codebase Index

This is a contributor-oriented map of the repository as it exists today.
Use it as the fast path before diving into the source.

## What This Project Is

`claude-max-api-proxy` is a local OpenAI-compatible HTTP proxy that forwards
requests into the authenticated `claude` CLI on the same machine.

On the outside it looks like a small OpenAI-style server.
On the inside every real request becomes a fresh `claude` subprocess with
conversation resume, queueing, retry, and health instrumentation layered around
it.

## Fast Orientation

- Primary runtime entrypoint: `src/server/standalone.ts`
- HTTP app wiring: `src/server/index.ts`
- Route validation and endpoint orchestration: `src/server/routes.ts`
- Conversation queue and cancellation state: `src/server/request-queue.ts`
- Request execution core: `src/server/chat-execution.ts`
- CLI subprocess lifecycle: `src/subprocess/manager.ts`
- Model discovery and runtime capability cache: `src/model-availability.ts`
- Conversation -> Claude session resume mapping: `src/session/manager.ts`
- Persistent local metrics/history store: `src/store/conversation.ts`
- OpenAI/Responses adapters: `src/adapter/`
- Built-in agent catalog: `src/agents.ts`
- Optional host/plugin export: `src/index.ts`

## Runtime Shape

The standalone server starts in this order:

1. `verifyClaude()` checks that the `claude` binary exists.
2. `verifyAuth()` checks `claude auth status`.
3. `modelAvailability.getSnapshot(true)` probes `sonnet`, `opus`, and `haiku`
   and caches the exact versioned model IDs the local CLI resolves.
4. `startServer()` binds the Express app.

While the process is running:

- `src/subprocess/pool.ts` keeps the CLI warm.
- `src/session/manager.ts` keeps machine-local conversation/session mappings.
- `src/store/conversation.ts` lazily initializes a SQLite store.
- `src/auth/proactive-refresh.ts` periodically triggers a quiet token refresh.

## Request Flow

For `POST /v1/chat/completions`:

1. Validate the request body and chosen built-in agent.
2. Apply the built-in agent profile if requested or configured by default.
3. Resolve the requested model against the current runtime availability cache.
   If the caller explicitly named a configured external model ID, route there.
   Otherwise the implicit path remains Claude.
4. Normalize reasoning settings from request body, headers, and runtime default.
5. Choose the conversation key from OpenAI `user` or the request id.
6. Apply the same-conversation policy:
   - `latest-wins`: cancel in-flight work and drop stale queued work
   - `queue`: run FIFO per conversation
7. Get or create a Claude CLI session id from `sessionManager`.
8. Persist conversation metadata and the last user message in SQLite.
9. Convert OpenAI-shaped input into `CliInput`.
10. Spawn a fresh `claude` subprocess and stream or buffer its output.
11. Persist assistant output and request metrics.
12. Mark the session as successful or failed for future resume decisions.

For `POST /v1/responses`:

- `src/adapter/responses.ts` converts the request into a chat request.
- `previous_response_id` is mapped back to a stored conversation id.
- The route reuses `handleChatCompletions()` and wraps the final response back
  into a minimal Responses API payload.
- Streaming Responses API is intentionally not implemented.

## Module Index

| Path | Role | Notes |
| --- | --- | --- |
| `src/server/standalone.ts` | CLI entrypoint | Startup checks, port parsing, graceful shutdown, session save on exit |
| `src/server/index.ts` | Express app setup | Registers routes, CORS, JSON body parsing, optional admin API |
| `src/server/routes.ts` | Route orchestration | Validation, model/reasoning resolution, Responses bridge, health/admin endpoints |
| `src/server/request-queue.ts` | Conversation queue manager | FIFO queueing, latest-wins supersession, active-request cancellation, queue pressure logging |
| `src/server/chat-execution.ts` | Request execution core | Streaming and non-streaming subprocess lifecycle, retries, SSE/error shaping, stall tracking |
| `src/server/auth-retry.ts` | Shared retry helper | Centralizes single retry on upstream auth failures |
| `src/server/runtime-snapshot.ts` | Runtime inspection helpers | Aggregates health/runtime state for `/health` and `/metrics` |
| `src/server/queue-snapshot.ts` | Queue summarizer | Computes queue depth and wait-time rollups for diagnostics |
| `src/server/response-conversations.ts` | Responses API bridge state | Maps `previous_response_id` values back to conversation ids |
| `src/adapter/openai-to-cli.ts` | OpenAI -> CLI adapter | Flattens message content, extracts system/developer text, resume mode |
| `src/adapter/cli-to-openai.ts` | CLI -> OpenAI adapter | Builds chunks/final responses and usage fallbacks |
| `src/adapter/responses.ts` | Responses API bridge | Minimal non-streaming Responses support |
| `src/agents.ts` | Built-in agent catalog | Currently ships one agent: `expert-coder` |
| `src/models.ts` | Stable model registry | Owns family aliases, timeout policy, provider-prefix stripping |
| `src/model-availability.ts` | Runtime model resolver | Caches auth/CLI/model probe results and picks defaults |
| `src/reasoning.ts` | Reasoning normalization | Merges `thinking`, `reasoning`, `reasoning_effort`, header, and defaults |
| `src/subprocess/manager.ts` | `claude` subprocess wrapper | Spawn args, stream parsing, registry, kill escalation |
| `src/subprocess/pool.ts` | CLI warm-up loop | Reduces cold-start latency but does not reuse request workers |
| `src/subprocess/stop-with-escalation.ts` | Shared stop helper | SIGTERM -> SIGKILL with forced release |
| `src/auth/token-gate.ts` | OAuth refresh mutex | Serializes CLI spawns near token expiry to avoid credential corruption |
| `src/auth/proactive-refresh.ts` | Defense-in-depth auth refresh | Quiet refresh tick when access token is near expiry |
| `src/session/manager.ts` | Conversation/session mapping | Resume ids, staleness limits, task limits, failure tracking |
| `src/store/conversation.ts` | SQLite history/metrics store | Conversations, messages, metrics, cleanup, health stats |
| `src/claude-cli.inspect.ts` | CLI inspection helpers | Version parsing, auth status, error classification, model probes |
| `src/logger.ts` | Structured JSON logger | One line per event to stdout |
| `src/types/` | Shared types | OpenAI, Responses, and Claude CLI stream shapes |
| `src/index.ts` | Library/plugin export | Legacy provider/plugin compatibility plus standalone exports |

## Public HTTP Surface

Always available:

- `GET /health`
- `GET /metrics`
- `GET /v1/models`
- `GET /v1/capabilities`
- `GET /v1/agents`
- `GET /v1/agents/:agentId`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/agents/:agentId/chat/completions`
- `POST /v1/agents/:agentId/responses`

Conditionally available:

- `GET /admin/thinking-budget`
- `POST /admin/thinking-budget`
- `PUT /admin/thinking-budget`

The admin endpoints only exist when `CLAUDE_PROXY_ENABLE_ADMIN_API=true`.

## Built-in Agent Surface

`src/agents.ts` currently defines one built-in profile:

- `expert-coder`

Behavior:

- Prepends a `developer` message containing the repo's canonical coding prompt.
- Applies default reasoning effort `high` when the caller did not already send
  reasoning settings.
- Can be selected by route (`/v1/agents/expert-coder/...`), by request body
  (`agent`), or globally via `CLAUDE_PROXY_DEFAULT_AGENT`.

## Model Behavior

This project does not hard-code versioned model ids in the request path.

Stable families:

- `sonnet`
- `opus`
- `haiku`

Important rules:

- `src/models.ts` recognizes provider-prefixed model names like
  `maxproxy/...`, `claude-code-cli/...`, and `claude-max-api-proxy/...`.
- `src/model-availability.ts` probes the local CLI at startup and caches the
  actual resolved model ids for 10 minutes.
- `resolveRequestedModel()` accepts either the family alias or an exact
  resolved id returned by `/v1/models`.
- Default family preference is `sonnet`, then `opus`, then `haiku`.
- External provider models can also appear in `/v1/models`, but they are
  explicit routes only. Omitting `model` still means Claude.

## Reasoning Behavior

Reasoning input can come from:

- `body.reasoning`
- `body.thinking`
- `body.output_config.effort`
- `body.reasoning_effort`
- `X-Thinking-Budget`
- `DEFAULT_THINKING_BUDGET`

Normalization rules:

- Older or non-adaptive models use fixed token budgets mapped to CLI effort.
- Adaptive reasoning is enabled only for Sonnet/Opus model lines `4.6+`.
- Adaptive reasoning also requires Claude CLI `2.1.111+`.
- `xhigh` CLI effort requires Claude CLI `2.1.112+`; otherwise large budgets
  fall back to `max`.
- Any active reasoning setting multiplies the route hard timeout by `3x`.

## Queueing and Cancellation

Per-conversation queueing lives entirely in `src/server/request-queue.ts`.

Key behavior:

- Conversation key = OpenAI `user` field, else request id
- Default policy = `latest-wins`
- Alternative policy = `queue`
- Maximum queued depth per conversation = `5`
- Queue timeout = request hard timeout + dynamic queue buffer
- Active request supersession returns `409 request_superseded`

Implication:

If a client reuses the same `user` value across unrelated threads, those
threads will interfere with each other by design.

## Session and Persistence Model

There are three distinct layers of state:

1. Claude CLI session mapping
   - File: `SESSION_FILE`
   - Default: `~/.claude-code-cli-sessions.json`
   - Purpose: map conversation ids to Claude session ids for `--resume`

2. Conversation/message/metric history
   - File: `DB_PATH`
   - Default: `~/.claude-proxy-conversations.db`
   - Purpose: machine-local audit trail and `/health` metrics

3. Runtime thinking-budget override
   - File: `RUNTIME_STATE_FILE`
   - Default: `dirname(DB_PATH)/runtime-state.json`
   - Purpose: persist `/admin/thinking-budget` changes

Session lifecycle rules:

- Sessions older than 6 hours are considered stale and recreated.
- Sessions reset after more than 50 tasks.
- Two consecutive resume failures invalidate a session.
- Hard timeouts delete the session.
- Stall timeouts mark the session as failed but do not immediately delete it.

## Subprocess and Auth Safety

Critical invariants:

- Every user request gets a fresh `claude` subprocess.
- The warm-up pool does not hand out reusable workers.
- `src/server/chat-execution.ts` owns request timeout and streaming behavior;
  the subprocess manager does not add its own request timers.
- `kill()` always escalates from `SIGTERM` to `SIGKILL` after 5 seconds.
- A global subprocess registry enables shutdown cleanup and `/health` reporting.

Auth-specific protections:

- `src/auth/token-gate.ts` serializes CLI spawns near OAuth expiry to avoid
  refresh-token rotation races.
- `src/auth/proactive-refresh.ts` refreshes quietly when the token is near
  expiry during idle periods.
- `src/server/auth-retry.ts` retries exactly once on upstream auth failures.
- `src/model-availability.ts` invalidates stale auth/model cache on retry and
  self-exits after 5 consecutive `verifyAuth` failures so a supervisor can
  restart the process.

## Claude CLI Invocation Notes

All real requests use stdin for prompt content instead of argv so very large
prompts do not hit `ARG_MAX`.

System prompt handling is intentionally unusual:

- Client system/developer prompts are wrapped into the user prompt inside
  `<instructions>...</instructions>` instead of being passed via
  `--system-prompt`.
- This is a workaround for Anthropic's third-party-app classifier when using a
  first-party Claude Max session through the CLI.

## Logging and Health

`src/logger.ts` emits structured JSON lines to stdout.

High-signal events include:

- `request.start`
- `request.complete`
- `request.error`
- `request.retry`
- `request.timeout`
- `subprocess.spawn`
- `subprocess.stall`
- `subprocess.kill`
- `subprocess.close`
- `session.created`
- `session.resume_fail`
- `session.invalidate`
- `auth.failure`
- `auth.recovered`
- `pool.warmed`

`GET /health` aggregates:

- auth snapshot
- runtime model availability
- current CLI capabilities
- warm-pool state
- active subprocess pids
- session failure stats
- SQLite metrics and recent errors
- queue status
- stall detection count

`GET /metrics` exposes scrape-friendly operational metrics for:

- generic HTTP request rate, latency, size, and in-flight state
- proxy request starts, outcomes, retries, queue depth, and TTFB
- queue, subprocess, session, auth, pool, CLI error, and token-validation events
- live runtime gauges such as active requests, queued requests, active subprocesses, active sessions, store size, and model availability
- Node process uptime, CPU, and memory

After 3 consecutive auth-check failures, `/health` returns `503`.

## Deployment and Packaging

- Runtime target: Node `>=22`
- Build: `tsc`
- Tests: Node built-in test runner against compiled `dist/**/*.test.js`
- CI: GitHub Actions on Node 22 and 24
- Docker: optional, runs as non-root `node`, persists state under `/data`

## Test Map

The repository currently has strong direct tests for:

- adapters
- agents
- token gate behavior
- CLI output/error parsing
- runtime config parsing
- model resolution
- model availability behavior
- reasoning normalization
- auth retry orchestration
- subprocess stop escalation

What is not directly unit-tested in the same depth:

- the full `src/server/routes.ts` + `src/server/chat-execution.ts`
  orchestration path
- Express endpoint wiring
- real subprocess integration against a live `claude` CLI
- SQLite persistence behavior under concurrent traffic

Those paths are still documented and partially protected by smaller unit-tested
helpers, but they are the highest-value areas to cover if the project grows.

## Change Hotspots

If you need to change behavior, start here:

- API surface and request shaping: `src/server/routes.ts`
- queue semantics and same-conversation behavior: `src/server/request-queue.ts`
- subprocess request lifecycle / streaming behavior: `src/server/chat-execution.ts`
- request/response shape: `src/adapter/`
- auth or retry behavior: `src/server/auth-retry.ts`, `src/auth/`, `src/claude-cli.inspect.ts`
- session continuity: `src/session/manager.ts`
- model resolution/capabilities: `src/model-availability.ts`, `src/models.ts`, `src/reasoning.ts`
- operational diagnostics: `src/logger.ts`, `src/store/conversation.ts`, `/health`

## Known Sharp Edges

- The proxy does not authenticate HTTP clients.
- `latest-wins` is safe for interactive clients but surprising for batch users.
- Responses API support is intentionally minimal and non-streaming only.
- Tool calling, structured outputs, and MCP server behavior are not implemented.
- Machine-local state is not portable across hosts.
- The warm-up pool reduces latency but does not change per-request process cost.
