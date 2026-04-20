# Configuration

All runtime configuration is driven by environment variables. Set them **before** starting the server. There is no config file.

## Environment variables

| Variable | Default | Values | What it does |
| --- | --- | --- | --- |
| `CLAUDE_PROXY_SAME_CONVERSATION_POLICY` | `latest-wins` | `latest-wins`, `queue` | How concurrent requests for the same conversation are handled. |
| `CLAUDE_PROXY_DEBUG_QUEUES` | `false` | `true`, `false` | Emit extra structured log events for queue enqueue/drop/block/cancel. |
| `CLAUDE_PROXY_ENABLE_ADMIN_API` | `false` | `true`, `false` | Mount `GET/POST/PUT /admin/thinking-budget` for live default-thinking changes. |
| `CLAUDE_PROXY_DEFAULT_AGENT` | _(unset)_ | builtin agent id, currently `expert-coder` | Automatically prepends the built-in expert agent profile to every request unless the caller explicitly chooses another built-in agent route/body value. |
| `CLAUDE_PROXY_MODEL_FALLBACKS` | _(unset)_ | comma-separated Claude selectors, e.g. `default,haiku` | When the requested model is unavailable, try these selectors in order before returning `model_unavailable`. |
| `GEMINI_CLI_ENABLED` | `false` unless `GEMINI_CLI_MODEL` / `GEMINI_CLI_EXTRA_MODELS` is set | `true`, `false` | Enable the local Gemini CLI provider. This is the CLI-first proxy path and does not need an API key. |
| `GEMINI_CLI_COMMAND` | `gemini` | executable path | Which local Gemini CLI binary the proxy should launch. |
| `GEMINI_CLI_MODEL` | `gemini-2.5-pro` when Gemini CLI is enabled | model id | Default Gemini CLI model advertised for explicit Gemini routing. |
| `GEMINI_CLI_EXTRA_MODELS` | _(unset)_ | comma-separated model ids | Additional Gemini CLI models to advertise on `/v1/models`, for example `gemini-2.5-flash`. |
| `GEMINI_CLI_WORKDIR` | `os.tmpdir()/claude-max-api-proxy-gemini-cli` | filesystem path | Isolated working directory used when launching the Gemini CLI in read-only plan mode. |
| `GEMINI_CLI_STREAM_MODE` | `passthrough` | `passthrough`, `synthetic` | How streamed Gemini CLI requests are handled. `passthrough` converts Gemini `stream-json` into OpenAI SSE live. |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | _(unset)_ | Google AI Studio API key | Advertises a Gemini OpenAI-compatible provider using `https://generativelanguage.googleapis.com/v1beta/openai` and default model `gemini-2.5-flash`. |
| `ZAI_API_KEY` / `BIGMODEL_API_KEY` | _(unset)_ | Z.AI API key | Advertises a Z.AI OpenAI-compatible provider using `https://api.z.ai/api/paas/v4` and default model `glm-4.7-flash`. |
| `ZAI_MODEL` | `glm-4.7-flash` when Z.AI is inferred | model id | Which Z.AI / GLM model the proxy should advertise as its external model. |
| `ZAI_BASE_URL` | `https://api.z.ai/api/paas/v4` when Z.AI is inferred | OpenAI-compatible base URL | Override the Z.AI endpoint directly. |
| `ZAI_CODING_PLAN` | `false` | `true`, `false` | When `true`, default Z.AI base URL switches to `https://api.z.ai/api/coding/paas/v4` so you can target coding-plan models like `glm-5` or `glm-4.7`. |
| `OPENAI_COMPAT_FALLBACK_PROVIDER` | provider-specific inference (`google`, `zai`, or explicit) | provider label | Label advertised on `/v1/models` and `/v1/capabilities` for the external provider. |
| `OPENAI_COMPAT_FALLBACK_BASE_URL` | provider-specific inference | OpenAI-compatible base URL | Base URL for the external provider. |
| `OPENAI_COMPAT_FALLBACK_API_KEY` | _(unset)_ | API key | API key sent as `Authorization: Bearer ...` to the external provider. |
| `OPENAI_COMPAT_FALLBACK_MODEL` | provider-specific inference | model id | Model ID advertised for explicit routing to the external OpenAI-compatible backend. |
| `OPENAI_COMPAT_FALLBACK_STREAM_MODE` | `synthetic` | `synthetic`, `passthrough` | How streamed external requests are handled. `synthetic` buffers upstream output and emits proxy-generated OpenAI SSE for maximum client compatibility. |
| `DEFAULT_THINKING_BUDGET` | _(unset)_ | integer, `off`, `low`, `medium`, `high`, `xhigh`, `max` | Server-wide fallback thinking budget when the client does not send one. |
| `DB_PATH` | `~/.claude-proxy-conversations.db` | filesystem path | Location of the SQLite conversation database. |
| `SESSION_FILE` | `~/.claude-code-cli-sessions.json` | filesystem path | Location of the conversation-to-session mapping file. |
| `RUNTIME_STATE_FILE` | `dirname(DB_PATH)/runtime-state.json` | filesystem path | Location of persisted admin-endpoint runtime state. |
| `HOST` | `127.0.0.1` | bind address | Network interface used by the standalone server. |
| `PORT` (positional arg) | `3456` | any free port | Pass as `node dist/server/standalone.js <port>`. |

## Same-conversation policy

> [!NOTE]
> `xhigh` maps to an intermediate 48000-token tier. If the installed Claude
> CLI does not support `--effort xhigh`, the proxy falls back to `max`.

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

## Default expert agent

Set `CLAUDE_PROXY_DEFAULT_AGENT=expert-coder` to make every request flow
through the repo's built-in expert coding agent profile.

```bash
export CLAUDE_PROXY_DEFAULT_AGENT=expert-coder
npm start
```

This injects the canonical developer prompt shipped by the proxy and applies
the agent's default reasoning tier when the caller did not already request one.
For one-off use, you can leave the env var unset and call the dedicated routes
instead:

- `GET /v1/agents`
- `GET /v1/agents/expert-coder`
- `POST /v1/agents/expert-coder/chat/completions`
- `POST /v1/agents/expert-coder/responses`

## Model fallback order

Set `CLAUDE_PROXY_MODEL_FALLBACKS` when you want the proxy to step down to a
different Claude selector instead of failing immediately.

```bash
export CLAUDE_PROXY_MODEL_FALLBACKS=default,haiku
npm start
```

Behavior:

- The originally requested model still wins when it is accessible.
- If it is unavailable, the proxy tries the listed selectors in order.
- `default` follows Claude Code's account-tier recommendation.
- The fallback list is also probed during startup so `/v1/models` can stay
  populated even when only a fallback selector is currently usable.

## Choosing the model

There are four model-related controls, and they do different jobs:

- Request body `model`
  What the caller asks to run. Claude aliases (`sonnet`, `opus`, `haiku`) are
  still the default path.
- `CLAUDE_PROXY_MODEL_FALLBACKS`
  Claude-only step-down order when the requested Claude family is unavailable.
- `GEMINI_CLI_MODEL` / `GEMINI_CLI_EXTRA_MODELS`
  The local Gemini CLI models that the proxy advertises and can route to
  without any hosted API key.
- `OPENAI_COMPAT_FALLBACK_MODEL` or `ZAI_MODEL`
  The external OpenAI-compatible API model that the proxy advertises and can
  route to.

Claude remains the default provider. External models are opt-in.

That rule is strict:

- omitted `model` stays on Claude
- `default` stays on Claude
- `sonnet`, `opus`, `haiku`, and resolved Claude IDs stay on Claude
- external providers are used only when the caller explicitly asks for one of
  their model IDs

## Local Gemini CLI provider

If you want to keep the proxy architecture CLI-first, enable Gemini through
the local authenticated `gemini` CLI instead of a hosted API key:

```bash
export GEMINI_CLI_ENABLED=true
export GEMINI_CLI_COMMAND=/opt/homebrew/bin/gemini
export GEMINI_CLI_MODEL=gemini-2.5-pro
export GEMINI_CLI_EXTRA_MODELS=gemini-2.5-flash
export OPEN_WEBUI_TASK_MODEL_EXTERNAL=gemini-2.5-flash
npm start
```

Behavior:

- `GET /v1/models` includes the configured Gemini CLI models.
- If a client explicitly requests one of those model IDs, the proxy routes
  directly to the local Gemini CLI.
- Requests that omit `model` or ask for Claude aliases still stay on Claude.
- If you want Open WebUI to use Gemini, set `OPEN_WEBUI_TASK_MODEL_EXTERNAL`
  to the exact Gemini model ID you want.
- The proxy launches Gemini in read-only plan mode from an isolated workdir so
  the service above still sees a normal OpenAI-compatible API surface.
- Streamed Gemini requests default to `GEMINI_CLI_STREAM_MODE=passthrough`,
  which converts Gemini `stream-json` into OpenAI SSE live.

## External OpenAI-compatible provider

The hosted OpenAI-compatible path is secondary to the CLI-based proxy flow, but
it remains available if you explicitly want it.

The built-in default path is Gemini:

```bash
export GEMINI_API_KEY=your-google-ai-studio-key
npm start
```

That is equivalent to:

```bash
export OPENAI_COMPAT_FALLBACK_PROVIDER=google
export OPENAI_COMPAT_FALLBACK_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
export OPENAI_COMPAT_FALLBACK_API_KEY=your-google-ai-studio-key
export OPENAI_COMPAT_FALLBACK_MODEL=gemini-2.5-flash
npm start
```

Behavior:

- `GET /v1/models` includes the configured external provider models.
- If a client explicitly requests one of those models, the proxy routes
  directly to the matching external provider.
- Requests that omit `model`, use `default`, or ask for Claude families still
  stay on Claude and return Claude errors if Claude is unavailable.
- If you want Open WebUI or another client to use the external provider by
  default, configure that client to request the external model ID explicitly.
- Claude-specific reasoning knobs are stripped before forwarding so the payload
  stays OpenAI-compatible upstream.
- Streamed external requests default to `OPENAI_COMPAT_FALLBACK_STREAM_MODE=synthetic`,
  which buffers the upstream response and emits stable OpenAI-style SSE from
  the proxy itself. Set `passthrough` only if you explicitly want raw upstream
  streaming behavior.

### Z.AI / GLM

If you want the free GLM path, the simplest setup is:

```bash
export ZAI_API_KEY=your-z-ai-key
npm start
```

That defaults to `glm-4.7-flash`.

To pin a different Z.AI model:

```bash
export ZAI_API_KEY=your-z-ai-key
export ZAI_MODEL=glm-4.7-flash
npm start
```

If you use Z.AI's coding endpoint and want larger coding models:

```bash
export ZAI_API_KEY=your-z-ai-key
export ZAI_CODING_PLAN=true
export ZAI_MODEL=glm-5
# or glm-4.7
npm start
```

The CLI-based Gemini provider can advertise multiple model IDs at once via
`GEMINI_CLI_EXTRA_MODELS`. API-key fallbacks still advertise one configured
model at a time.

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

> [!NOTE]
> When you use `docker-compose.yml`, the `.env` `PORT` value controls the host-side published port only. The Node process still listens on `3456` inside the container.

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

See [macOS setup](../setup/macos-setup.md) for the LaunchAgent setup that runs the proxy at login with KeepAlive.
