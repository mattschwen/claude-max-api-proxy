# Configuration

All runtime configuration is driven by environment variables. Set them **before** starting the server. There is no config file.

## Environment variables

| Variable | Default | Values | What it does |
| --- | --- | --- | --- |
| `CLAUDE_PROXY_SAME_CONVERSATION_POLICY` | `latest-wins` | `latest-wins`, `queue` | How concurrent requests for the same conversation are handled. |
| `CLAUDE_PROXY_DEBUG_QUEUES` | `false` | `true`, `false` | Emit extra structured log events for queue enqueue/drop/block/cancel. |
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

## Custom port

The server binds to `127.0.0.1:3456` by default. Pass a port as the first positional argument to the standalone server to change it:

```bash
node dist/server/standalone.js 8080
```

Then point clients at `http://127.0.0.1:8080/v1`.

> [!NOTE]
> The server binds to `127.0.0.1` explicitly. To expose it beyond localhost, put your own reverse proxy (nginx, Caddy, Tailscale serve) in front of it rather than modifying the bind.

## Timeouts

Timeouts are hard-coded per model family in `src/config.ts`. They're deliberately not environment-configurable today.

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

If `thinking.type === "enabled"` on the request, the hard timeout is multiplied by **3×** to allow for longer reasoning windows.

### Kill escalation

When a subprocess needs to die (stall, client disconnect, shutdown, timeout), the proxy sends `SIGTERM` first and then escalates to `SIGKILL` after a 5 second grace period if the process hasn't exited. Watch for `subprocess.kill` events with `signal: "SIGKILL"` — those mean the process ignored the polite request.

## Persistent state

The proxy writes two files under the user's home directory:

| Path | Purpose |
| --- | --- |
| `~/.claude-code-cli-sessions.json` | Maps conversation IDs → Claude CLI session IDs, tracks resume failure counts. |
| `~/.claude-proxy-conversations.db` | SQLite conversation metadata, message history, request metrics. |

These files are **machine-local** and not portable. Moving the repo to another machine does not carry conversation continuity.

## macOS auto-start

See [docs/macos-setup.md](./macos-setup.md) for the LaunchAgent setup that runs the proxy at login with KeepAlive.
