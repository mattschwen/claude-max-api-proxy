# Architecture

This doc explains what happens inside the proxy when a request comes in. It is intended for contributors and for anyone trying to understand why the proxy behaves the way it does.

## High level

### Default Claude route

```
┌───────────────────────────────────────────────┐
│ Your client                                   │
│ OpenAI SDK / curl / editor / agent            │
└──────────────────────┬────────────────────────┘
                       │ POST /v1/chat/completions
                       ▼
┌───────────────────────────────────────────────┐
│ claude-max-api-proxy (:3456)                  │
│ adapter -> queue -> session -> subprocess     │
│ metrics -> health -> /ops -> /launch          │
└──────────────────────┬────────────────────────┘
                       │ spawn("claude", ...)
                       ▼
┌───────────────────────────────────────────────┐
│ claude CLI                                    │
│ --print --output-format stream-json           │
└──────────────────────┬────────────────────────┘
                       │ authenticated Claude Max session
                       ▼
┌───────────────────────────────────────────────┐
│ Anthropic / Claude                            │
│ default provider path                         │
└───────────────────────────────────────────────┘
```

### Explicit external route

```
┌───────────────────────────────────────────────┐
│ Your client                                   │
│ model = gemini-* / glm-* / external id        │
└──────────────────────┬────────────────────────┘
                       │ POST /v1/chat/completions
                       ▼
┌───────────────────────────────────────────────┐
│ claude-max-api-proxy (:3456)                  │
│ exact external model match required           │
└──────────────────────┬────────────────────────┘
                       │ provider transport
                       ▼
┌───────────────────────────────────────────────┐
│ External provider                             │
│ Gemini CLI / Z.AI / OpenAI-compatible HTTP    │
└───────────────────────────────────────────────┘
```

Configured external providers such as Gemini CLI or Z.AI are explicit side
routes. Multiple providers and models can coexist behind the registry. They are
advertised on `/v1/models`, while `/v1/capabilities` exposes provider probe
state and model-specific reasoning, tools, vision, structured-output, context,
and timeout metadata. They never become the implicit default when a request
asks for Claude.

## Module layout (`src/`)

```
src/
├── agents.ts             Built-in agent profiles and prompt injection
├── adapter/              OpenAI ↔ Claude CLI shape conversion
│   ├── openai-to-cli.ts     request  → subprocess args + prompt
│   └── cli-to-openai.ts     subprocess stream → OpenAI chunks
├── server/               HTTP surface
│   ├── routes.ts            Request validation, model resolution, health/admin routes
│   ├── request-context.ts   Conversation identity and per-call policy
│   ├── turn-admission.ts    Durable idempotency gate
│   ├── request-queue.ts     Same-conversation queue + cancellation state
│   ├── chat-execution.ts    Streaming/non-streaming subprocess lifecycle
│   └── standalone.ts        Startup probes, graceful shutdown, CLI entry
├── subprocess/           Claude CLI subprocess lifecycle
│   ├── manager.ts           ClaudeSubprocess + global registry
│   └── pool.ts              CLI warm-up loop + /health pool status
├── session/              Conversation → CLI session-id mapping
│   └── manager.ts           Resume logic, failure tracking, invalidation
├── store/                SQLite conversation store
├── types/                Shared TypeScript types
├── config.ts             Timeouts, policies, per-family tuning
├── logger.ts             Structured JSON log events
├── model-availability.ts Startup model probes
├── feature-scanner.ts    Periodic Claude/external provider probes
├── models.ts             Known model IDs, alias expansion
└── claude-cli.inspect.ts Auth / version / probe helpers
```

## Request lifecycle

1. **HTTP in.** `POST /v1/chat/completions`, `POST /v1/responses`, or the scoped `/v1/agents/:agentId/*` variants hit `server/routes.ts`. Request validation and model/reasoning resolution stay there. Same-conversation queueing and cancellation are delegated into `server/request-queue.ts`. Timeout, retry, and SSE behavior are delegated into `server/chat-execution.ts`, which remains the single owner of request-lifecycle timers instead of the subprocess manager.

2. **Agent profile injection.** If the caller selects a built-in agent (or the operator configured `CLAUDE_PROXY_DEFAULT_AGENT`), `agents.ts` prepends the canonical developer prompt and any agent-level defaults before request adaptation.

3. **Route decision.** If the caller explicitly asked for one of the configured external model IDs, the request is handed to that provider. Otherwise the implicit route stays Claude-first.

4. **Adapter: OpenAI → CLI input.** `adapter/openai-to-cli.ts` pulls out system messages, assistant turns, and the final user message. It produces a `CliInput` with a prompt, an optional resolved system prompt, and session metadata. Multi-part content arrays (`[{type:"text", text:"..."}]`) are flattened.

5. **Identity and durable admission.** `conversation_id` (body, metadata, or
header) becomes the primary thread key, with legacy `user`, an endpoint-scoped
hash of `Idempotency-Key`, and request-ID fallbacks. The turn is persisted
before it enters the queue, and an idempotency key can replay a completed
non-streaming result without running the provider twice.

6. **Conversation queue.** `server/request-queue.ts` atomically sequences and
admits work. Under `latest-wins`, a new request for the same key cancels
in-flight work and drops older queued work. Under `queue`, it waits FIFO.
Independent conversation keys run concurrently up to the global limit.

7. **Session fork decision.** `session/manager.ts` reads only the last committed
Claude session. Resumed turns run with `--resume <sessionId> --fork-session`;
the child session is committed atomically only after success. Cancellation,
timeout, and disconnect never advance the parent checkpoint.

8. **Context reconstruction.** Stateless external-provider calls and fresh
Claude fallbacks merge the committed transcript with the new request.
Overlap detection avoids duplicating history when a client already resends the
full conversation. A successful external-provider turn clears the incompatible
Claude checkpoint; failed or cancelled attempts do not.

9. **Subprocess spawn.** Every real Claude request spawns a fresh `claude` process via `spawn("claude", args, { env: cleanEnv })`. Base args include `--print --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions --model <id>`; session fork, `--fallback-model sonnet`, and `--effort <level>` are added when needed.

10. **Stream parsing and response.** Stdout is parsed line-by-line as
newline-delimited JSON. Each message is classified (`assistant`, `result`,
`content_delta`) and emitted as a typed event. Chunks are written as SSE, or
buffered into one non-streaming completion.

11. **Terminal commit.** Exactly one terminal path wins. Success persists the
assistant result and child session. Supersession, explicit cancellation,
timeout, or disconnect stops the provider and records a terminal turn without
persisting partial output.

## Subprocess safety model

The subprocess manager owns four invariants that keep the proxy stable under load:

### 1. Single ownership of timeouts

`ClaudeSubprocess.start()` does **not** install any timeout itself. The caller (`server/chat-execution.ts`, invoked from the route layer) is the sole owner. This prevents the "dual-timeout" class of bug where the subprocess kills itself while the HTTP layer is still streaming, or vice versa. See the `Phase 1c` comment in `manager.ts`.

### 2. Kill escalation

`ClaudeSubprocess.kill()` sends `SIGTERM` immediately and starts a 5 second timer. If the process hasn't exited when the timer fires, it escalates to `SIGKILL`. The escalation timer is cleared if the process exits normally. This guarantees every subprocess eventually dies.

### 3. Clean environment

`getCleanClaudeEnv()` strips `CLAUDE_CODE_ENTRYPOINT`, `CLAUDECODE`, `CLAUDE_CODE_SESSION`, and `CLAUDE_CODE_PARENT` before spawning. If the proxy itself is being run from inside a Claude Code session, those vars would leak and confuse the child `claude` CLI's session tracking.

### 4. Global subprocess registry

Every spawned subprocess registers itself with a module-level `SubprocessRegistry`. On `SIGTERM` / `SIGINT`, the standalone server calls `subprocessRegistry.killAll()` to ensure no orphaned `claude` processes survive a graceful shutdown.

## CLI warm-up loop

Cold-starting the Claude CLI is slow — it has to load Node, warm auth, and
resolve model access. `subprocess/pool.ts` reduces that cold-start penalty, but
it is **not** a checkout-and-reuse worker pool. Every user request still
spawns its own `claude` subprocess.

- Pool size defaults to **5**, which is the number of quick warm-up probes run per cycle.
- On initial startup, the warm-up module also runs a one-shot deep warm probe (`claude --print --model haiku "hi"`).
- Every 30 seconds, if warm state has gone stale, the module refreshes the warm-up probes.
- The `/health` endpoint exposes `pool.isWarm`, `pool.poolSize`, `pool.warming`, and `pool.warmedAt`.

## Startup sequence

`server/standalone.ts` performs these checks before binding the HTTP server:

1. `verifyClaude()` — `claude --version`
2. `verifyAuth()` — `claude auth status`
3. `modelAvailability.getSnapshot(true)` — probes each candidate family in parallel via `probeModelAvailability()` with a 60 s timeout per probe
4. `startServer()` — binds the HTTP server to `:3456`

CLI, authentication, or zero-model failures are fatal when
`CLAUDE_PROXY_REQUIRE_CLAUDE=true`. When explicit external providers make
Claude optional, startup continues and those providers are probed by the
background feature scanner. Each external scan has a 30-second deadline, and
scanner shutdown aborts its active external probe.

The session-manager load and CLI warm-up loop are kicked off by imported
modules while the process boots. The SQLite conversation store initializes
lazily on first use.

Total cold start is typically **15–30 seconds**, but the model-probe phase is
allowed to stretch toward **60 seconds** on a slow or completely cold CLI.
That's deliberate — we want the `/health` endpoint to give clients accurate
information from the first request, not lie and then start failing.

> [!NOTE]
> On a truly cold or slow CLI, the startup model probes can still hit the 60 s
> cap because the first `claude` invocations also have to warm auth and model
> resolution. If this leaves Claude absent from `/health.models.available`
> even though auth is valid, restart once more and test
> `claude --print --model sonnet "hi"`
> manually. Repeated 60 s timeouts usually mean the CLI itself is slow or
> wedged. See [TROUBLESHOOTING](./TROUBLESHOOTING.md).

## Structured logging

Every significant event is emitted as a single-line JSON object via `logger.ts`. Common events:

| Event | When |
| --- | --- |
| `server.start` | HTTP server bound successfully |
| `server.shutdown` | `SIGINT` / `SIGTERM` received |
| `request.start` | A chat request began processing |
| `request.complete` | Chat request finished (with `durationMs`, `ttfbMs`) |
| `request.error` | Chat request errored |
| `request.cancel` | In-flight request canceled by `latest-wins` |
| `queue.enqueue` | Queued a request (debug-only unless `DEBUG_QUEUES=true`) |
| `queue.drop` | Dropped a queued request (debug-only) |
| `queue.blocked` | Queue is blocked waiting for in-flight to finish (debug-only) |
| `queue.timeout` | Queue-level timeout fired |
| `subprocess.spawn` | New `claude` subprocess spawned |
| `subprocess.close` | `claude` subprocess exited |
| `subprocess.kill` | Kill signal sent (SIGTERM or SIGKILL) |
| `subprocess.stall` | Stall timer fired — subprocess went silent mid-stream |
| `session.created` | New Claude CLI session ID assigned to a conversation |
| `session.context` | Session-related context event |
| `session.resume_fail` | `claude --resume` failed for an existing session |
| `session.invalidate` | Session ejected after repeated resume failures |
| `token.validation_failed` | A token validation step failed |

Logs go to stdout, one JSON object per line, which makes them trivially grep-friendly and trivially ingestible by structured-log backends.

## Why the proxy defaults to `latest-wins`

Interactive chat clients almost always want: if the user sends a new message, the old one becomes irrelevant. Strict FIFO (`queue`) is what agent frameworks with multi-step pipelines want — they rely on message ordering and never want silent cancellation. Both are reasonable defaults for their use case; the proxy picks the common one and lets you switch with an environment variable.
