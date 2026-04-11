# Architecture

This doc explains what happens inside the proxy when a request comes in. It is intended for contributors and for anyone trying to understand why the proxy behaves the way it does.

## High level

```
┌─────────────────┐                                     ┌──────────────────────────────────┐
│  Your client    │    POST /v1/chat/completions        │  claude-max-api-proxy (:3456)   │
│  (OpenAI SDK,   │  ─────────────────────────────────► │                                  │
│   curl, etc.)   │                                     │   ┌──────────────────────────┐   │
└─────────────────┘                                     │   │  Adapter                 │   │
                                                        │   │  openai → cli input      │   │
                                                        │   └────────────┬─────────────┘   │
                                                        │                ▼                 │
                                                        │   ┌──────────────────────────┐   │
                                                        │   │  Conversation queue       │   │
                                                        │   │  (latest-wins | queue)    │   │
                                                        │   └────────────┬──────────────┘   │
                                                        │                ▼                  │
                                                        │   ┌──────────────────────────┐    │
                                                        │   │  Subprocess manager       │    │
                                                        │   │  warm pool + spawn        │    │
                                                        │   └────────────┬──────────────┘    │
                                                        └────────────────┼───────────────────┘
                                                                         ▼
                                                             ┌─────────────────────┐
                                                             │  claude (CLI)       │
                                                             │  --print            │
                                                             │  --output-format    │
                                                             │  stream-json        │
                                                             └──────────┬──────────┘
                                                                        ▼
                                                             ┌─────────────────────┐
                                                             │  Anthropic API      │
                                                             │  (first-party       │
                                                             │   Claude Max auth)  │
                                                             └─────────────────────┘
```

## Module layout (`src/`)

```
src/
├── adapter/              OpenAI ↔ Claude CLI shape conversion
│   ├── openai-to-cli.ts     request  → subprocess args + prompt
│   └── cli-to-openai.ts     subprocess stream → OpenAI chunks
├── server/               HTTP surface
│   ├── routes.ts            Express routes; owns timeouts + streaming
│   └── standalone.ts        Startup probes, graceful shutdown, CLI entry
├── subprocess/           Claude CLI subprocess lifecycle
│   ├── manager.ts           ClaudeSubprocess + global registry
│   └── pool.ts              Warm pool for fast first-token latency
├── session/              Conversation → CLI session-id mapping
│   └── manager.ts           Resume logic, failure tracking, invalidation
├── store/                SQLite conversation store
├── types/                Shared TypeScript types
├── config.ts             Timeouts, policies, per-family tuning
├── logger.ts             Structured JSON log events
├── model-availability.ts Startup model probes
├── models.ts             Known model IDs, alias expansion
└── claude-cli.inspect.ts Auth / version / probe helpers
```

## Request lifecycle

1. **HTTP in.** `POST /v1/chat/completions` hits `server/routes.ts`. Timeouts are installed here (stall + hard), not in the subprocess manager — the route is the single owner of timeout behavior.

2. **Adapter: OpenAI → CLI input.** `adapter/openai-to-cli.ts` pulls out system messages, assistant turns, and the final user message. It produces a `CliInput` with a prompt, an optional resolved system prompt, and session metadata. Multi-part content arrays (`[{type:"text", text:"..."}]`) are flattened.

3. **Conversation queue.** The `user` field becomes the conversation key. Under `latest-wins`, a new request for the same key cancels any in-flight request and drops older queued work. Under `queue`, it waits FIFO. Queue events are emitted as structured logs when `CLAUDE_PROXY_DEBUG_QUEUES=true`.

4. **Session resume decision.** `session/manager.ts` looks up whether this conversation already has a Claude CLI session ID. If so, the subprocess is spawned with `--resume <sessionId>`. Otherwise with `--session-id <newId>`. If resume fails twice in a row, the session is invalidated and the next request creates a fresh one.

5. **Subprocess spawn.** `subprocess/manager.ts` either takes a pre-warmed `claude` process out of the pool or spawns a new one via `spawn("claude", args, { env: cleanEnv })`. Args always include `--print --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions --model <id>`.

6. **Stream parsing.** Stdout is parsed line-by-line as newline-delimited JSON. Each message is classified (`assistant`, `result`, `content_delta`) and emitted as a typed event. `adapter/cli-to-openai.ts` transforms each event into an OpenAI `chat.completion.chunk`.

7. **Streaming back.** Chunks are written to the HTTP response as Server-Sent Events. The final `data: [DONE]` sentinel terminates the stream. For non-streaming requests, chunks are buffered and a single `chat.completion` object is returned at the end.

8. **Cleanup.** On `close`, the subprocess is unregistered from the global registry and session state is updated with the resolved CLI session ID (for future resume).

## Subprocess safety model

The subprocess manager owns four invariants that keep the proxy stable under load:

### 1. Single ownership of timeouts

`ClaudeSubprocess.start()` does **not** install any timeout itself. The caller (route handler) is the sole owner. This prevents the "dual-timeout" class of bug where the subprocess kills itself while the route is still streaming, or vice versa. See the `Phase 1c` comment in `manager.ts`.

### 2. Kill escalation

`ClaudeSubprocess.kill()` sends `SIGTERM` immediately and starts a 5 second timer. If the process hasn't exited when the timer fires, it escalates to `SIGKILL`. The escalation timer is cleared if the process exits normally. This guarantees every subprocess eventually dies.

### 3. Clean environment

`getCleanClaudeEnv()` strips `CLAUDE_CODE_ENTRYPOINT`, `CLAUDECODE`, `CLAUDE_CODE_SESSION`, and `CLAUDE_CODE_PARENT` before spawning. If the proxy itself is being run from inside a Claude Code session, those vars would leak and confuse the child `claude` CLI's session tracking.

### 4. Global subprocess registry

Every spawned subprocess registers itself with a module-level `SubprocessRegistry`. On `SIGTERM` / `SIGINT`, the standalone server calls `subprocessRegistry.killAll()` to ensure no orphaned `claude` processes survive a graceful shutdown.

## Warm subprocess pool

Cold spawning a `claude` CLI is slow — it has to load Node, run its own auth handshake, resolve the model, and negotiate with Anthropic's backend. The warm pool keeps a small number of pre-spawned `claude` processes ready to serve the next request.

- Pool size defaults to **5** processes.
- Warming happens at startup, and re-warms after each request is served.
- The `/health` endpoint exposes `pool.isWarm`, `pool.poolSize`, `pool.warming`, and `pool.warmedAt`.

## Startup sequence

`server/standalone.ts` runs these steps **synchronously** before binding the HTTP server:

1. `verifyClaude()` — `claude --version`
2. `verifyAuth()` — `claude auth status`
3. `probeModelAvailability()` — spawns `claude --print --model <id>` once per candidate model with a 15 s timeout
4. Initialize session store + conversation store
5. Warm the subprocess pool
6. Bind HTTP server to `:3456`

Total cold start is typically **15–25 seconds**. That's deliberate — we want the `/health` endpoint to give clients accurate information from the first request, not lie and then start failing.

> [!NOTE]
> On a truly cold CLI (no warm auth cache at all), the startup model probes can all time out at 15 s because the first `claude` invocation also has to warm the auth handshake. If this leaves `/health.models.available` empty even though the subprocess pool warmed successfully, one `launchctl kickstart` (or service restart) resolves it — the second pass lands on a warm CLI. See [TROUBLESHOOTING](./TROUBLESHOOTING.md).

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
