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
  <a href="#signal-grid">Signal Grid</a> ·
  <a href="#systems-online">Systems</a> ·
  <a href="#jack-in">Jack In</a> ·
  <a href="#plug-in-any-openai-client">Clients</a> ·
  <a href="./docs/API.md">API</a> ·
  <a href="./docs/CONFIGURATION.md">Config</a> ·
  <a href="./docs/CODEBASE_INDEX.md">Code Index</a> ·
  <a href="./docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="./docs/TROUBLESHOOTING.md">Troubleshooting</a>
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

No separate Anthropic API key. No extra API bill. No Docker requirement. Just
your existing Claude Max session exposed behind a sharp, local, OpenAI-shaped
surface.

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

## Signal Grid

```text
[ OPENAI CLIENT ] ---> [ CLAW PROXY @ 127.0.0.1:3456 ] ---> [ CLAUDE CODE CLI ] ---> [ CLAUDE MAX ]
     SDKs / editors             chat + models + health            authenticated locally      your paid plan
     curl / agents              queue + session spine             dynamic model probes        no extra API key
```

## Systems Online

| Surface | Why it matters |
| --- | --- |
| OpenAI-compatible edge | `POST /v1/chat/completions`, `POST /v1/responses`, `GET /v1/models`, `GET /v1/capabilities`, `GET /v1/agents`, `GET /health`, and `GET /metrics`. |
| Zero extra credentials | Reuses the machine's existing `claude auth login` session instead of asking clients for a second API key. |
| Dynamic model routing | Probes stable families like `sonnet`, `opus`, and `haiku`, then surfaces the exact model IDs your local Claude CLI currently resolves. |
| Agent discovery | `GET /v1/capabilities` advertises the current runtime surface, CLI feature flags, and which resolved models use adaptive reasoning. |
| Canonical coding agent | Ship one repo-native `expert-coder` agent so external tools can reuse the same curated coding brain instead of inventing their own prompts. |
| Session continuity | Reuses the OpenAI `user` field as a conversation key and resumes the underlying CLI session automatically. |
| Operational discipline | CLI warm-up loop, per-family stall timeouts, kill escalation, structured logs, and a detailed `/health` snapshot. |
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
curl http://127.0.0.1:3456/v1/models
curl http://127.0.0.1:3456/v1/capabilities
curl http://127.0.0.1:3456/v1/agents
```

> [!IMPORTANT]
> If `/v1/models` returns `{"object":"list","data":[]}`, the proxy started but
> your Claude CLI account cannot access any models right now. Fix auth first.
> See [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md).

> [!NOTE]
> Prefer containers? See [docs/docker-setup.md](./docs/docker-setup.md). Docker
> is supported, but not required.

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
| Model | `sonnet`, `opus`, `haiku`, or an exact ID from `/v1/models` |

The proxy accepts stable family aliases and resolves them to whatever exact
version the installed Claude CLI currently exposes. `GET /v1/models` returns
those runtime-resolved IDs.

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
[docs/CONFIGURATION.md](./docs/CONFIGURATION.md).

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

## Run It Like Infrastructure

- **macOS**: [docs/macos-setup.md](./docs/macos-setup.md)
- **Linux**: [docs/linux-systemd.md](./docs/linux-systemd.md)
- **Docker**: [docs/docker-setup.md](./docs/docker-setup.md)

## Documentation

| Document | What's inside |
| --- | --- |
| [docs/API.md](./docs/API.md) | Full endpoint reference, request and response shapes, and examples |
| [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) | Environment variables, defaults, and runtime policies |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Process model, queues, sessions, probes, and logging |
| [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) | Failure modes, diagnosis, and repair steps |
| [docs/macos-setup.md](./docs/macos-setup.md) | LaunchAgent setup for automatic startup on macOS |
| [docs/linux-systemd.md](./docs/linux-systemd.md) | systemd user-service setup on Linux |
| [docs/docker-setup.md](./docs/docker-setup.md) | Optional container deployment and Compose setup |
| [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) | Dev setup, style, tests, and PR flow |
| [docs/CODE_OF_CONDUCT.md](./docs/CODE_OF_CONDUCT.md) | Community expectations |
| [docs/SECURITY.md](./docs/SECURITY.md) | Private vulnerability reporting |

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
[docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) before opening a PR, use the
issue templates when they apply, and follow the expectations in
[docs/CODE_OF_CONDUCT.md](./docs/CODE_OF_CONDUCT.md).

## Security

The proxy binds to `127.0.0.1` by default and trusts the local Claude CLI
session. It does **not** authenticate clients. Anything that can reach `:3456`
can spend your Claude Max quota.

Keep it on localhost unless you deliberately place it behind real network
controls, and leave the optional admin API disabled unless you explicitly need
it. See [docs/SECURITY.md](./docs/SECURITY.md) for responsible disclosure.

## License

[MIT](./LICENSE)
