<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/banner-dark.svg">
  <img alt="Claw Proxy — OpenAI-compatible, Claude-first, multi-provider gateway." src="./assets/banner-light.svg" width="100%">
</picture>

**One local endpoint for the OpenAI-compatible tools you already use.**

Claude CLI is the default route. Gemini CLI, GLM, and other configured
OpenAI-compatible providers stay explicit and opt-in.

<p>
  <a href="https://github.com/mattschwen/claude-max-api-proxy/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/mattschwen/claude-max-api-proxy?style=flat-square&logo=github&color=ff4fa8&labelColor=08101d"></a>
  <a href="https://github.com/mattschwen/claude-max-api-proxy/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/mattschwen/claude-max-api-proxy/ci.yml?branch=main&style=flat-square&label=CI&labelColor=08101d&color=74ffb0"></a>
  <a href="./LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2fe6ff?style=flat-square&labelColor=08101d"></a>
  <img alt="Node.js 22 or newer" src="https://img.shields.io/badge/node-22+-74ffb0?style=flat-square&logo=nodedotjs&labelColor=08101d">
  <img alt="OpenAI compatible" src="https://img.shields.io/badge/OpenAI-compatible-2fe6ff?style=flat-square&labelColor=08101d">
</p>

<p>
  <a href="#quick-start"><b>Quick start</b></a>
  ·
  <a href="#client-setup"><b>Client setup</b></a>
  ·
  <a href="./docs/reference/API.md"><b>Explore the API</b></a>
</p>

<sub>Continue · Aider · OpenAI SDKs · Open WebUI · curl · custom agents</sub>

</div>

---

## Why Claw Proxy

You already have an authenticated Claude CLI session on your machine. But the
rest of the modern tooling ecosystem keeps asking for an OpenAI-compatible
`baseURL`.

**Claw Proxy closes that gap.**

```text
your editor / SDK / agent
          │
          │  OpenAI request
          ▼
  http://127.0.0.1:3456/v1
          │
          ▼
     Claw Proxy router
       ├─ Claude Code CLI (default)
       └─ configured provider (explicit)
```

Your client keeps speaking OpenAI. Claude keeps running through the CLI session
you already trust, while configured external models remain available by
explicit model ID. The bridge stays on your machine.

## Quick Start

You need **Node.js 22+**, **npm**, and the
[Claude Code CLI](https://github.com/anthropics/claude-code) authenticated on
this machine.

```bash
# Authenticate once
npm install -g @anthropic-ai/claude-code
claude auth login

# Clone and launch
git clone https://github.com/mattschwen/claude-max-api-proxy.git
cd claude-max-api-proxy
npm install
npm run build
npm start
```

When the model scan finishes, the bridge is live at
`http://127.0.0.1:3456`.

```bash
curl http://127.0.0.1:3456/health
curl http://127.0.0.1:3456/v1/models
```

## Client Setup

Most clients only need these three values:

| Client setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:3456/v1` |
| API key | Any non-empty string if the client requires one |
| Model | `sonnet`, `opus`, `best`, `fable`, `haiku`, or `default` |

Then send a normal OpenAI request:

```bash
curl -N http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Reply with: bridge online" }
    ]
  }'
```

<details>
<summary><b>OpenAI Python SDK</b></summary>

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3456/v1",
    api_key="local",
)

response = client.chat.completions.create(
    model="sonnet",
    messages=[{"role": "user", "content": "Reply with: bridge online"}],
)

print(response.choices[0].message.content)
```

</details>

<details>
<summary><b>OpenAI TypeScript SDK</b></summary>

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:3456/v1",
  apiKey: "local",
});

const response = await client.chat.completions.create({
  model: "sonnet",
  messages: [{ role: "user", content: "Reply with: bridge online" }],
});

console.log(response.choices[0].message.content);
```

</details>

## What You Get

- **Keep your toolchain.** Change the base URL instead of rewriting your editor,
  agent, SDK integration, or scripts.
- **Reuse the session you already have.** The default Claude route runs through
  the authenticated local CLI—no second Anthropic credential to distribute.
- **Stream like an OpenAI endpoint.** Chat Completions emits OpenAI-shaped SSE;
  newer agent stacks can also use the Responses compatibility surface.
- **Keep conversations alive.** Stable conversation keys isolate queues,
  persist checkpoints, and resume committed CLI sessions.
- **See what the bridge is doing.** Health, capabilities, Prometheus metrics,
  structured logs, cancellation, and a built-in operator dashboard ship with
  the proxy.
- **Scale only when you need to.** Run plain Node on localhost first; add
  LaunchAgent, systemd, Docker, Open WebUI, or explicit external providers
  later.

## Routing stays explicit

| Requested model | Effective route |
| --- | --- |
| Omitted or `default` | Claude account-tier default |
| `sonnet`, `opus`, `best`, `fable`, `haiku` | Claude family selector (`best` follows Opus) |
| `sonnet[1m]`, `opus[1m]`, or a supported full ID with `[1m]` | Account-gated extended-context selector passed through to Claude Code |
| Exact Claude ID from `/v1/models` | Exact runtime Claude model |
| Configured `gemini-*`, `glm-*`, or other external ID | That explicit external provider |

External models never silently replace Claude. If the default Claude path is
unavailable, the proxy returns a Claude error unless you explicitly request a
configured external model.

## API and Operations

| Surface | What it gives you |
| --- | --- |
| `POST /v1/chat/completions` | Streaming and non-streaming OpenAI-compatible chat |
| `POST /v1/responses` | Responses-style input, instructions, and continuation |
| `GET /v1/models` | Runtime-resolved Claude IDs plus explicit external models |
| `GET /v1/capabilities` | Model, reasoning, provider, and CLI feature discovery |
| `GET /health` · `GET /metrics` | Readiness, runtime state, and Prometheus telemetry |
| `GET /` · `GET /ops` | Built-in queue, session, latency, subprocess, and log views |
| `DELETE /v1/requests/:id` | Cancellation for queued or active work |

> [!IMPORTANT]
> If `/v1/models` returns `{"object":"list","data":[]}`, the proxy started but
> your Claude CLI account cannot access any models right now. Fix auth first.
> See [docs/reference/TROUBLESHOOTING.md](./docs/reference/TROUBLESHOOTING.md).

> [!NOTE]
> The default server trusts local clients and binds to `127.0.0.1`. Do not
> expose it beyond a trusted machine without real authentication and network
> controls. Your Claude plan limits and provider terms still apply.

## Optional Local Stack

For the best local setup, run the Claude-backed proxy on the host so it can
reuse your authenticated CLI session directly, then optionally bring up
Open WebUI in Docker:

```bash
export HOST=0.0.0.0
export CLAUDE_PROXY_LOG_FILE=logs/proxy.jsonl
npm start

# in another shell
docker compose up -d open-webui
```

That stack gives you:

| Surface | URL |
| --- | --- |
| Native command deck | `http://127.0.0.1:3456/` |
| Dashboard alias | `http://127.0.0.1:3456/ops` |
| Launch deck | `http://127.0.0.1:3456/launch` |
| Open WebUI | `http://127.0.0.1:8080/` |

The dashboard is built into the proxy itself. It renders the queue, live
throughput, latency traces, session state, subprocesses, recent conversations,
and structured logs directly from the proxy runtime and `/metrics?format=json`.
The launch deck’s Chat Lab keeps multiple independent thread tabs alive at
once, can branch a transcript, and lets each thread choose interrupt or FIFO
behavior without restarting the server.
Open WebUI comes up pointed at the local proxy by default and can also be
redirected toward other OpenAI-compatible backends from env or provider
settings.

> [!TIP]
> The compose file still includes an optional `container-proxy` profile for
> advanced setups, but the default flow is host-run proxy plus optional Open
> WebUI.

> [!TIP]
> Want the proxy to step down automatically when a requested Claude model is
> unavailable? Set `CLAUDE_PROXY_MODEL_FALLBACKS=default,haiku`. The proxy will
> keep the original request if it can, then try the listed selectors in order.

> [!TIP]
> Claude remains the default provider. External model support is opt-in and
> only activates when you explicitly request the configured external model.
> Open WebUI can be pointed at one of those external model IDs explicitly if
> that is what you want.

### Setting The Model

There are four separate knobs:

- Request body `model`: chooses the actual model to run. Omit it, use `default`,
  or use Claude selectors like `sonnet`, `opus`, `best`, `fable`, and `haiku`
  to stay on the Claude path.
- `CLAUDE_PROXY_MODEL_FALLBACKS`: chooses the Claude-only step-down order when the requested Claude family is unavailable.
- `GEMINI_CLI_MODEL` and `GEMINI_CLI_EXTRA_MODELS`: choose the local Gemini CLI models that `/v1/models` advertises through this proxy.
- `OPENAI_COMPAT_FALLBACK_MODEL` or `ZAI_MODEL`: chooses the external OpenAI-compatible API model that `/v1/models` advertises.

If the request names a Claude alias, the proxy stays on Claude whenever Claude
is available. If the request names one of the configured external models, the
proxy routes there directly. External models never become the implicit default
just because they are configured.

The local Gemini CLI path defaults to **passthrough streaming** because the
proxy converts Gemini's native `stream-json` output into OpenAI SSE directly.
OpenAI-compatible HTTP fallbacks still default to **synthetic streaming** for
maximum client compatibility. If you specifically want raw upstream SSE for
those HTTP fallbacks, set `OPENAI_COMPAT_FALLBACK_STREAM_MODE=passthrough`.

### External Provider Examples

#### Free GLM Provider

If you want a no-cost external route through Z.AI, set a Z.AI key and let
the proxy advertise `glm-4.7-flash`:

```bash
export ZAI_API_KEY=your-z-ai-key
export HOST=0.0.0.0
export CLAUDE_PROXY_LOG_FILE=logs/proxy.jsonl
# Optional: OPENAI_COMPAT_FALLBACK_STREAM_MODE=passthrough for raw upstream SSE
npm start
```

To change the advertised GLM model explicitly:

```bash
export ZAI_API_KEY=your-z-ai-key
export ZAI_MODEL=glm-4.7-flash
npm start
```

If you have Z.AI's coding endpoint and want one of the larger coding models:

```bash
export ZAI_API_KEY=your-z-ai-key
export ZAI_CODING_PLAN=true
export ZAI_MODEL=glm-5
# or: export ZAI_MODEL=glm-4.7
npm start
```

#### Local Gemini CLI Provider

```bash
export GEMINI_CLI_ENABLED=true
export GEMINI_CLI_COMMAND=/opt/homebrew/bin/gemini
export GEMINI_CLI_MODEL=gemini-2.5-pro
export GEMINI_CLI_EXTRA_MODELS=gemini-2.5-flash
export OPEN_WEBUI_TASK_MODEL_EXTERNAL=gemini-2.5-flash
export HOST=0.0.0.0
export CLAUDE_PROXY_LOG_FILE=logs/proxy.jsonl
npm start
```

This keeps the project CLI-first: the proxy uses your already-authenticated
local `gemini` CLI session in read-only plan mode from an isolated workdir, so
the service on top still sees a normal OpenAI-compatible API.

If you leave `OPEN_WEBUI_TASK_MODEL_EXTERNAL` unset, Open WebUI keeps asking
for `sonnet` and therefore stays on the default Claude route.

#### Generic OpenAI-Compatible Provider

```bash
export OPENAI_COMPAT_FALLBACK_PROVIDER=google
export OPENAI_COMPAT_FALLBACK_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
export OPENAI_COMPAT_FALLBACK_API_KEY=your-google-ai-studio-key
export OPENAI_COMPAT_FALLBACK_MODEL=gemini-2.5-flash
npm start
```

When an external provider is configured:

- `GET /v1/models` advertises the configured external models alongside any Claude models the CLI can access.
- `POST /v1/chat/completions` routes directly to the matching external provider when the caller explicitly asks for one of those models.
- Requests that omit `model`, use `default`, or ask for Claude families remain Claude-first and return Claude errors if Claude is unavailable.
- If you want Open WebUI to use one of those external models, set `OPEN_WEBUI_TASK_MODEL_EXTERNAL` to that exact external model ID.

## Client Integrations

### Common client defaults

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:3456/v1` |
| API key | any non-empty string if your client requires one |
| Model | `sonnet`, `opus`, `best`, `fable`, `haiku`, `default`, an account-supported `sonnet[1m]` / `opus[1m]` selector, an exact Claude ID from `/v1/models`, or one explicitly requested external model such as `glm-4.7-flash` or `gemini-2.5-flash` |

The proxy accepts stable family aliases and resolves them to whatever exact
version the installed Claude CLI currently exposes. `GET /v1/models` returns
those runtime-resolved IDs plus the configured external model, if any.

### Modern agent surfaces

- `POST /v1/chat/completions` remains the best choice for existing OpenAI-compatible SDKs and streaming clients.
- `POST /v1/responses` provides a minimal Responses API surface for newer agent stacks that want `input`, `instructions`, and `previous_response_id`.
- `DELETE /v1/requests/:requestId` cancels queued or active work using the response's `X-Request-Id`.
- `GET /v1/capabilities` lets adapters inspect current model IDs, reasoning support, and local Claude CLI feature flags before they connect.
- `GET /v1/agents` and `GET /v1/agents/expert-coder` expose the built-in expert coding agent profile.
- `POST /v1/agents/expert-coder/chat/completions` and `POST /v1/agents/expert-coder/responses` force requests through the canonical coding agent.
- `GET /metrics` exposes Prometheus-style metrics for HTTP traffic, queue pressure, subprocesses, sessions, auth failures, and model availability. Add `?format=json` for a structured snapshot.

### Canonical coding agent

This repo now ships one built-in agent: `expert-coder`.

- It injects a repo-native developer prompt tuned for Claw Proxy architecture, open-source portability, integration work, debugging, and end-to-end implementation.
- It defaults to a stronger reasoning tier when the caller did not already set one.
- It gives every external tool a single coding brain to target instead of relying on user-contributed prompt packs.

If you want every request to use it automatically, set:

```bash
export CLAUDE_PROXY_DEFAULT_AGENT=expert-coder
```

### Example client snippets

<details>
<summary><b>Continue.dev</b></summary>

```json
{
  "models": [
    {
      "title": "Claw Proxy",
      "provider": "openai",
      "model": "sonnet",
      "apiBase": "http://127.0.0.1:3456/v1",
      "apiKey": "local"
    }
  ]
}
```

</details>

<details>
<summary><b>OpenClaw</b></summary>

```json
{
  "providers": {
    "claw-proxy": {
      "baseUrl": "http://127.0.0.1:3456/v1",
      "api": "openai-completions",
      "auth": "api-key",
      "apiKey": "ignored",
      "models": [{ "id": "sonnet" }, { "id": "opus" }]
    }
  }
}
```

</details>

## Configuration

Everything is environment-variable driven. The full reference lives in
[docs/reference/CONFIGURATION.md](./docs/reference/CONFIGURATION.md).

```bash
# Cancel the in-flight request when a newer one lands for the same conversation
export CLAUDE_PROXY_SAME_CONVERSATION_POLICY=latest-wins

# Or: FIFO for each conversation key after request validation
export CLAUDE_PROXY_SAME_CONVERSATION_POLICY=queue

# Run several independent conversation threads at once
export CLAUDE_PROXY_MAX_CONCURRENT_REQUESTS=4

# Extra visibility into queue internals
export CLAUDE_PROXY_DEBUG_QUEUES=true

# Optional: enable protected runtime controls
# export CLAUDE_PROXY_ENABLE_ADMIN_API=true
# export CLAUDE_PROXY_ADMIN_TOKEN=replace-with-a-long-random-token

npm start
```

## Production Deployments

Use this checklist when you want to run the proxy like infrastructure instead
of a dev process:

1. Keep Claude as the default route by using `default`, `sonnet`, `opus`,
   `best`, `fable`, `haiku`, or a resolved Claude model ID from `/v1/models`.
2. Persist `DB_PATH`, `SESSION_FILE`, and `RUNTIME_STATE_FILE` so sessions,
   metrics, and runtime overrides survive restarts.
3. Set `CLAUDE_PROXY_LOG_FILE` so structured logs are written somewhere
   durable and easy to tail.
4. Probe `GET /health`, scrape `GET /metrics`, and use `GET /ops` or
   `GET /launch` as the human operator surfaces.
5. Keep the service on localhost unless you place real network controls in
   front of it. Inference and cancellation routes do not authenticate clients,
   and the Ops surfaces include local conversation diagnostics.
6. Use a service manager instead of a bare shell:
   - macOS LaunchAgent
   - Linux systemd user service
   - Docker / Compose with the built-in `/health` container healthcheck

If you want external models in production, publish them through `/v1/models`
and request them explicitly by model ID. They are available, but not the
default.

## Run It Like Infrastructure

- **macOS**: [docs/setup/macos-setup.md](./docs/setup/macos-setup.md)
- **Linux**: [docs/setup/linux-systemd.md](./docs/setup/linux-systemd.md)
- **Docker**: [docs/setup/docker-setup.md](./docs/setup/docker-setup.md)

## Documentation

| Document | What's inside |
| --- | --- |
| [docs/reference/API.md](./docs/reference/API.md) | Full endpoint reference, request and response shapes, and examples |
| [docs/reference/CONFIGURATION.md](./docs/reference/CONFIGURATION.md) | Environment variables, defaults, and runtime policies |
| [docs/reference/ARCHITECTURE.md](./docs/reference/ARCHITECTURE.md) | Process model, queues, sessions, probes, and logging |
| [docs/reference/TROUBLESHOOTING.md](./docs/reference/TROUBLESHOOTING.md) | Failure modes, diagnosis, and repair steps |
| [docs/setup/macos-setup.md](./docs/setup/macos-setup.md) | LaunchAgent setup for automatic startup on macOS |
| [docs/setup/linux-systemd.md](./docs/setup/linux-systemd.md) | systemd user-service setup on Linux |
| [docs/setup/docker-setup.md](./docs/setup/docker-setup.md) | Optional container deployment and Compose setup |
| [docs/community/CONTRIBUTING.md](./docs/community/CONTRIBUTING.md) | Dev setup, style, tests, and PR flow |
| [docs/community/CODE_OF_CONDUCT.md](./docs/community/CODE_OF_CONDUCT.md) | Community expectations |
| [docs/community/SECURITY.md](./docs/community/SECURITY.md) | Private vulnerability reporting |

## Compare the Options

| Capability | `Claw Proxy` | Direct Anthropic API | Claude Code CLI only |
| --- | :---: | :---: | :---: |
| Uses your Max plan | ✅ | ❌ | ✅ |
| OpenAI-compatible endpoints | ✅ | ❌ | ❌ |
| Streaming | ✅ | ✅ | ✅ |
| Session continuity | ✅ | Partial | ✅ |
| Works with Continue, Aider, SDKs | ✅ | Partial | ❌ |
| Requires separate API key | ❌ | ✅ | ❌ |
| Docker required | ❌ | ❌ | ❌ |

## Requirements

- **Node.js 22+**
- **npm**
- **[Claude Code CLI](https://github.com/anthropics/claude-code)** installed and authenticated
- A **Claude Max** or equivalent subscription with access to at least one Claude model

## Development

```bash
git clone https://github.com/mattschwen/claude-max-api-proxy.git
cd claude-max-api-proxy
npm install
npm run ci
npm start
```

Source lives in `src/`. Compiled output lives in `dist/` and is generated by
the TypeScript build. Tests live next to the source as `*.test.ts` and run from
their compiled `dist/**/*.test.js` output.

## Community

Issues and pull requests are welcome. Read
[docs/community/CONTRIBUTING.md](./docs/community/CONTRIBUTING.md) before opening a PR, use the
issue templates when they apply, and follow the expectations in
[docs/community/CODE_OF_CONDUCT.md](./docs/community/CODE_OF_CONDUCT.md).

## Security

The proxy binds to `127.0.0.1` by default and trusts the local Claude CLI
session. It does **not** authenticate clients. Anything that can reach `:3456`
can spend your Claude Max quota, inspect operational diagnostics, or cancel a
request if it obtains that request's opaque ID.

Keep it on localhost unless you deliberately place it behind real network
controls, and leave the optional admin API disabled unless you explicitly need
it. See [docs/community/SECURITY.md](./docs/community/SECURITY.md) for responsible disclosure.

## License

[MIT](./LICENSE)
