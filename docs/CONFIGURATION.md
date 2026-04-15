# Configuration

All runtime configuration is driven by environment variables. Set them **before** starting the server. There is no config file.

## Environment variables

| Variable | Default | Values | What it does |
| --- | --- | --- | --- |
| `CLAUDE_PROXY_SAME_CONVERSATION_POLICY` | `latest-wins` | `latest-wins`, `queue` | How concurrent requests for the same conversation are handled. |
| `CLAUDE_PROXY_DEBUG_QUEUES` | `false` | `true`, `false` | Emit extra structured log events for queue enqueue/drop/block/cancel. |
| `CLAUDE_PROXY_ENABLE_ADMIN_API` | `false` | `true`, `false` | Mount `GET/POST/PUT /admin/thinking-budget` for live default-thinking changes. |
| `DEFAULT_THINKING_BUDGET` | _(unset)_ | integer, `off`, `low`, `medium`, `high`, `max` | Server-wide fallback thinking budget when the client does not send one. |
| `HOST` | `127.0.0.1` | bind address | Network interface used by the standalone server. |
| `PORT` (positional arg) | `3456` | any free port | Pass as `node dist/server/standalone.js <port>`. |

## Same-conversation policy

The proxy uses the OpenAI-standard `user` field as a conversation key. When two requests share the same `user`, the policy decides what happens.

### `latest-wins` (default)

- New request for the same conversation → **cancels the active request** and drops older queued work for that conversation.
- Good for interactive chat UIs where the user interrupts the model mid-response.
- Side effect: if a client accidentally reuses a `user` across unrelated threads, requests will stomp each other.

### `queue`

- New request for the same conversation → **waits** behind the active request.
- Requests for a single conversation run strictly FIFO.
- Good for batch workflows, agent frameworks with strict turn ordering, or when you genuinely want no in-flight cancellation.

Switch policy:

```bash
export CLAUDE_PROXY_SAME_CONVERSATION_POLICY=queue
npm start
```

## Queue debug logging

When `CLAUDE_PROXY_DEBUG_QUEUES=true`, the proxy emits these additional structured log events:

- `queue.enqueue` — a request was accepted and queued
- `queue.drop` — a queued request was dropped (typically because `latest-wins` superseded it)
- `queue.blocked` — a request is waiting because another request for the same conversation is active
- `request.cancel` — an in-flight request was canceled

Normal request/subprocess/session events are always emitted — this flag only gates the queue-internals noise.

```bash
export CLAUDE_PROXY_DEBUG_QUEUES=true
npm start
```

## Admin API

The mutable thinking-budget admin API is disabled by default:

```bash
export CLAUDE_PROXY_ENABLE_ADMIN_API=true
npm start
```

When enabled, these endpoints are mounted:

- `GET /admin/thinking-budget`
- `POST /admin/thinking-budget`
- `PUT /admin/thinking-budget`

This endpoint changes server behavior at runtime, persists its override across restarts, and the proxy does not authenticate clients, so only enable it on trusted networks.

## Network binding

The standalone server binds to `127.0.0.1:3456` by default. Pass a port as the first positional argument to change the port, or set `HOST` to change the bind address:

```bash
HOST=0.0.0.0 node dist/server/standalone.js 8080
```

Then point clients at `http://127.0.0.1:8080/v1` for localhost use, or your chosen host/IP when deliberately exposing it.

> [!NOTE]
> The safest default is to keep the server on `127.0.0.1`. If you set `HOST=0.0.0.0`, treat the proxy like an internal service and put network controls in front of it.

## Timeouts

Timeouts are hard-coded per model family in `src/models.ts`. They're deliberately not environment-configurable today.

### Stall timeouts

The proxy resets a per-request stall timer every time the subprocess produces output. If the subprocess goes silent for longer than the stall timeout, it is killed and the queue is unblocked.

| Family | Stall timeout |
| --- | --- |
| Opus | 120 s |
| Sonnet | 90 s |
| Haiku | 45 s |

### Hard timeouts

Absolute wall-clock ceiling per request, regardless of activity.

| Family | Hard timeout |
| --- | --- |
| Opus | 30 min |
| Sonnet | 10 min |
| Haiku | 2 min |

If any thinking budget source is active on the request (`thinking.budget_tokens`, `reasoning_effort`, `X-Thinking-Budget`, or `DEFAULT_THINKING_BUDGET`), the hard timeout is multiplied by **3×** to allow for longer reasoning windows.

### Kill escalation

When a subprocess needs to die (stall, client disconnect, shutdown, timeout), the proxy sends `SIGTERM` first and then escalates to `SIGKILL` after a 5 second grace period if the process hasn't exited. Watch for `subprocess.kill` events with `signal: "SIGKILL"` — those mean the process ignored the polite request.

## Persistent state

The proxy writes these machine-local state files:

| Path | Purpose |
| --- | --- |
| `~/.claude-code-cli-sessions.json` | Maps conversation IDs → Claude CLI session IDs, tracks resume failure counts. |
| `~/.claude-proxy-conversations.db` | SQLite conversation metadata, message history, request metrics. |
| `dirname(DB_PATH)/runtime-state.json` | Persists the admin-set default thinking budget when `CLAUDE_PROXY_ENABLE_ADMIN_API=true`. |

These files are **machine-local** and not portable. Moving the repo to another machine does not carry conversation continuity.

## macOS auto-start

See [docs/macos-setup.md](./macos-setup.md) for the LaunchAgent setup that runs the proxy at login with KeepAlive.
