<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/banner-dark.svg">
  <img alt="Claw Proxy - OpenAI-compatible gateway powered by Claude Code CLI." src="./assets/banner-light.svg" width="100%">
</picture>

<p>
  <b>Claw Proxy</b> is the user-facing name for
  <code>claude-max-api-proxy</code>.
</p>

<p>
  <a href="#jack-in"><img alt="jack in" src="https://img.shields.io/badge/jack--in-60s-ff3fd1?style=flat-square&labelColor=08101d"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-3df7ff?style=flat-square&labelColor=08101d"></a>
  <img alt="node" src="https://img.shields.io/badge/node-22+-7dfb86?style=flat-square&labelColor=08101d">
  <img alt="openai" src="https://img.shields.io/badge/openai-compatible-3df7ff?style=flat-square&labelColor=08101d">
  <img alt="models" src="https://img.shields.io/badge/models-dynamic-a87cff?style=flat-square&labelColor=08101d">
  <img alt="resume" src="https://img.shields.io/badge/sessions-resume-ff9df3?style=flat-square&labelColor=08101d">
  <img alt="docker" src="https://img.shields.io/badge/docker-optional-4ac1ff?style=flat-square&labelColor=08101d">
  <img alt="typescript" src="https://img.shields.io/badge/typescript-strict-6d8cff?style=flat-square&labelColor=08101d">
</p>

<p>
  <b>Route any OpenAI-compatible client into your live Claude Max session.</b><br/>
  OpenAI on the edge. Claude Code CLI in the core. Localhost in between.
</p>

<p>
  <code>Continue.dev</code> / <code>Aider</code> / <code>OpenAI SDKs</code> / <code>curl</code>
  &rarr; <code>127.0.0.1:3456</code>
  &rarr; <code>Claw Proxy</code>
  &rarr; <code>authenticated claude CLI</code>
  &rarr; <code>Claude Max</code>
</p>

<p>
  <a href="#why-claw-proxy-exists">Why</a> ·
  <a href="#request-path">Request Path</a> ·
  <a href="#default-routing">Default Routing</a> ·
  <a href="#systems-online">Systems</a> ·
  <a href="#jack-in">Jack In</a> ·
  <a href="#production-deployments">Deploy</a> ·
  <a href="#plug-in-any-openai-client">Clients</a> ·
  <a href="./docs/reference/API.md">API</a> ·
  <a href="./docs/reference/CONFIGURATION.md">Config</a> ·
  <a href="./docs/reference/CODEBASE_INDEX.md">Code Index</a> ·
  <a href="./docs/reference/ARCHITECTURE.md">Architecture</a> ·
  <a href="./docs/reference/TROUBLESHOOTING.md">Troubleshooting</a>
</p>

</div>

---

## Why Claw Proxy Exists

You already have a working Claude Max session on your machine. Your local
`claude` CLI is authenticated. But the rest of the modern tooling ecosystem
keeps asking for an OpenAI-compatible `baseURL`.

That mismatch is the whole reason this project exists.

**Claw Proxy** is the product identity for this repo. The repository and
package stay named `claude-max-api-proxy`, but the thing you actually run is a
local bridge that speaks OpenAI on the outside and Claude Code CLI on the
inside.

Claw Proxy runs a local HTTP server on `127.0.0.1:3456`, accepts OpenAI-shaped
requests, invokes the authenticated Claude Code CLI underneath, and streams the
result back in the format your client already expects.

On the default Claude path: no separate Anthropic API key, no extra Anthropic
API bill, and no Docker requirement. External OpenAI-compatible providers are
optional. Just your existing Claude Max session exposed behind a sharp, local,
OpenAI-shaped surface, with extra routes available when you choose to wire them
in.

<table>
  <tr>
    <td width="33%" valign="top">
      <b>OUTER SHELL</b><br/>
      Keep your existing SDKs, editors, and agents. Change the base URL, not
      your workflow.
    </td>
    <td width="33%" valign="top">
      <b>INNER LINK</b><br/>
      Requests flow through the authenticated <code>claude</code> CLI, so the
      proxy rides the real local session you already use.
    </td>
    <td width="33%" valign="top">
      <b>MODEL SCAN</b><br/>
      Stable aliases stay simple while <code>/v1/models</code> publishes the
      exact model IDs your installed CLI resolves today.
    </td>
  </tr>
</table>

## At A Glance

| What you need to know | Meaning in practice |
| --- | --- |
| Claude is always the implicit default | Omit `model`, use `default`, or use Claude aliases like `sonnet`, `opus`, and `haiku` to stay on the Claude route. |
| External models are explicit only | Gemini CLI, GLM, and other OpenAI-compatible providers only activate when the request names that exact external model ID. |
| Operators get built-in visibility | `/`, `/ops`, `/launch`, `/health`, and `/metrics` are all served by the proxy itself. |
| Production can stay simple | Host-run Node first. Add LaunchAgent, systemd, or Docker only when you actually need service management. |

## Request Path

### Default Claude Path

```text
┌──────────────────────────────────────┐
│ OpenAI-compatible client             │
│ Continue / Aider / SDK / curl        │
└──────────────────┬───────────────────┘
                   │ POST /v1/chat/completions
                   ▼
┌──────────────────────────────────────┐
│ Claw Proxy                           │
│ 127.0.0.1:3456                       │
│ queue • sessions • metrics • /ops    │
└──────────────────┬───────────────────┘
                   │ local Claude subprocess
                   ▼
┌──────────────────────────────────────┐
│ Claude Code CLI                      │
│ authenticated on this machine        │
└──────────────────┬───────────────────┘
                   │ Max subscription
                   ▼
┌──────────────────────────────────────┐
│ Claude                               │
│ default route                        │
└──────────────────────────────────────┘
```

### Explicit External Path

```text
┌──────────────────────────────────────┐
│ OpenAI-compatible client             │
│ model = gemini-* / glm-* / other     │
└──────────────────┬───────────────────┘
                   │ POST /v1/chat/completions
                   ▼
┌──────────────────────────────────────┐
│ Claw Proxy                           │
│ exact external model match required  │
└──────────────────┬───────────────────┘
                   │ explicit provider route
                   ▼
┌──────────────────────────────────────┐
│ External provider                    │
│ gemini CLI / Z.AI / OpenAI endpoint  │
└──────────────────────────────────────┘
```

Configured external models such as `gemini-2.5-pro`, `gemini-2.5-flash`,
`glm-4.7-flash`, `glm-5`, or `glm-4.7` are advertised through
`GET /v1/models`, but they never become the implicit default.

## Default Routing

| Request `model` | Effective route |
| --- | --- |
| omitted | Claude default path |
| `default` | Claude account-tier default |
| `sonnet`, `opus`, `haiku` | Claude family alias |
| exact Claude ID from `/v1/models` | Claude exact runtime model |
| configured `gemini-*` or `glm-*` model | Explicit external route |

If Claude is unavailable and the request did **not** explicitly ask for an
external model, the proxy returns a Claude error instead of silently switching
providers.

## Systems Online

| Surface | Why it matters |
| --- | --- |
| OpenAI-compatible edge | `POST /v1/chat/completions`, `POST /v1/responses`, `GET /v1/models`, `GET /v1/capabilities`, `GET /v1/agents`, `GET /health`, and `GET /metrics`. |
| Zero extra credentials | Reuses the machine's existing `claude auth login` session instead of asking clients for a second API key. |
| Dynamic model routing | Probes stable families like `sonnet`, `opus`, and `haiku`, then surfaces the exact model IDs your local Claude CLI currently resolves. |
| Agent discovery | `GET /v1/capabilities` advertises the current runtime surface, CLI feature flags, and which resolved models use adaptive reasoning. |
| Canonical coding agent | Ship one repo-native `expert-coder` agent so external tools can reuse the same curated coding brain instead of inventing their own prompts. |
| Session continuity | Reuses the OpenAI `user` field as a conversation key and resumes the underlying CLI session automatically. |
| Optional external providers | Claude stays the default path. External models such as Gemini or Z.AI GLM are available only when you request them explicitly by model ID. |
| Operational discipline | CLI warm-up loop, per-family stall timeouts, kill escalation, structured logs, and a detailed `/health` snapshot. |
| Operator command center | `GET /` serves the native Grafana-style command deck, `GET /ops` and `GET /dashboard` mirror it, and `GET /launch` keeps the cinematic launch deck for quick links and signal summaries. |
| Sensible deployment | Plain Node.js checkout first. Docker supported, but optional. macOS and Linux service docs included. |

## Jack In

You need **Node.js 22+**, **npm**, and the **Claude Code CLI** already logged
in.

```bash
# 1. Install Claude CLI and authenticate (skip if already installed)
npm install -g @anthropic-ai/claude-code
claude auth login

# 2. Clone, install, build, run
git clone https://github.com/mattschwen/claude-max-api-proxy.git
cd claude-max-api-proxy
npm install
npm run build
npm start
```

The proxy warms up by probing model availability against your authenticated CLI,
then binds to `http://127.0.0.1:3456`.

```bash
curl http://127.0.0.1:3456/health
curl http://127.0.0.1:3456/metrics
open http://127.0.0.1:3456/
open http://127.0.0.1:3456/ops
curl http://127.0.0.1:3456/v1/models
curl http://127.0.0.1:3456/v1/capabilities
curl http://127.0.0.1:3456/v1/agents
```

> [!IMPORTANT]
> If `/v1/models` returns `{"object":"list","data":[]}`, the proxy started but
> your Claude CLI account cannot access any models right now. Fix auth first.
> See [docs/reference/TROUBLESHOOTING.md](./docs/reference/TROUBLESHOOTING.md).

> [!NOTE]
> Prefer containers? See [docs/setup/docker-setup.md](./docs/setup/docker-setup.md). Docker
> is supported, but not required.

## Local Command Stack

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

- Request body `model`: chooses the actual model to run. Omit it, use `default`, or use Claude aliases like `sonnet`, `opus`, and `haiku` to stay on the Claude path.
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

## Plug In Any OpenAI Client

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3456/v1",
    api_key="ignored",
)

resp = client.chat.completions.create(
    model="sonnet",
    messages=[{"role": "user", "content": "Say hi in one word."}],
)

print(resp.choices[0].message.content)
```

### TypeScript

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:3456/v1",
  apiKey: "ignored",
});

const resp = await client.chat.completions.create({
  model: "sonnet",
  messages: [{ role: "user", content: "Say hi in one word." }],
});

console.log(resp.choices[0].message.content);
```

### curl

```bash
curl -N http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Write a haiku about local proxies." }
    ]
  }'
```

### Common client defaults

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:3456/v1` |
| API key | any non-empty string if your client requires one |
| Model | `sonnet`, `opus`, `haiku`, `default`, an exact Claude ID from `/v1/models`, or one explicitly requested external model such as `glm-4.7-flash` or `gemini-2.5-flash` |

The proxy accepts stable family aliases and resolves them to whatever exact
version the installed Claude CLI currently exposes. `GET /v1/models` returns
those runtime-resolved IDs plus the configured external model, if any.

### Modern agent surfaces

- `POST /v1/chat/completions` remains the best choice for existing OpenAI-compatible SDKs and streaming clients.
- `POST /v1/responses` provides a minimal Responses API surface for newer agent stacks that want `input`, `instructions`, and `previous_response_id`.
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

# Or: strict FIFO for each conversation key
export CLAUDE_PROXY_SAME_CONVERSATION_POLICY=queue

# Extra visibility into queue internals
export CLAUDE_PROXY_DEBUG_QUEUES=true

# Optional: enable the runtime thinking-budget admin endpoint
# export CLAUDE_PROXY_ENABLE_ADMIN_API=true

npm start
```

## Production Deployments

Use this checklist when you want to run the proxy like infrastructure instead
of a dev process:

1. Keep Claude as the default route by using `default`, `sonnet`, `opus`,
   `haiku`, or a resolved Claude model ID from `/v1/models`.
2. Persist `DB_PATH`, `SESSION_FILE`, and `RUNTIME_STATE_FILE` so sessions,
   metrics, and runtime overrides survive restarts.
3. Set `CLAUDE_PROXY_LOG_FILE` so structured logs are written somewhere
   durable and easy to tail.
4. Probe `GET /health`, scrape `GET /metrics`, and use `GET /ops` or
   `GET /launch` as the human operator surfaces.
5. Keep the service on localhost unless you place real network controls in
   front of it. The proxy does not authenticate clients.
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
can spend your Claude Max quota.

Keep it on localhost unless you deliberately place it behind real network
controls, and leave the optional admin API disabled unless you explicitly need
it. See [docs/community/SECURITY.md](./docs/community/SECURITY.md) for responsible disclosure.

## License

[MIT](./LICENSE)
