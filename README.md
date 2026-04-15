<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/banner-dark.svg">
  <img alt="claude-max-api-proxy — An OpenAI-compatible API server powered by Claude Code CLI." src="./assets/banner-light.svg" width="100%">
</picture>

<br/>

<p>
  <a href="#quickstart"><img alt="quickstart" src="https://img.shields.io/badge/quickstart-60s-ff7a3c?style=flat-square&labelColor=1a0f1e"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-f5efe7?style=flat-square&labelColor=1a0f1e"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522-4ade80?style=flat-square&labelColor=1a0f1e">
  <img alt="typescript" src="https://img.shields.io/badge/typescript-strict-3178c6?style=flat-square&labelColor=1a0f1e">
  <img alt="status" src="https://img.shields.io/badge/status-production-16a34a?style=flat-square&labelColor=1a0f1e">
</p>

<p>
  <b>Point any OpenAI-compatible client at your Claude Max plan.</b><br/>
  Wraps the authenticated <code>claude</code> CLI in an OpenAI-shaped HTTP API.
</p>

<p>
  <a href="#quickstart">Quickstart</a> ·
  <a href="#why">Why</a> ·
  <a href="#features">Features</a> ·
  <a href="./docs/API.md">API</a> ·
  <a href="./docs/CONFIGURATION.md">Config</a> ·
  <a href="./docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="./docs/TROUBLESHOOTING.md">Troubleshooting</a>
</p>

</div>

---

## Why

You already pay for Claude Max. Your local `claude` CLI is already authenticated. But every OpenAI-compatible tool on your machine — Continue.dev, OpenClaw, Aider, your own scripts — wants to talk to a `baseURL` and get back an OpenAI-shaped response.

**`claude-max-api-proxy` is that `baseURL`.**

It runs a tiny local HTTP server on `127.0.0.1:3456`, translates OpenAI `/v1/chat/completions` calls into Claude Code CLI subprocess invocations, and hands the streaming output back in the exact shape your OpenAI client expects. No separate API keys. No extra billing. Just your existing Max subscription, reused.

## Features

|                                          |                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| 🔌 **Drop-in OpenAI API**                | `/v1/chat/completions`, `/v1/models`, and `/health` — streaming and non-streaming.      |
| 🔑 **Zero API keys**                     | Uses your machine's existing `claude auth login` session.                               |
| 🧠 **Multi-model**                       | Auto-detects which Claude models your account actually has access to.                   |
| ♻️ **Session continuity**                | Reuses the same `user` field as a conversation key; transparently resumes CLI sessions. |
| ⚡ **Warm subprocess pool**              | Keeps `claude` processes pre-spawned so first-token latency stays low.                  |
| 🛡️ **Stall detection + kill escalation** | Per-family stall timeouts, SIGTERM → SIGKILL grace, graceful shutdown.                  |
| 📊 **Rich `/health`**                    | Live auth, model probes, pool, queues, subprocesses, recent errors — one endpoint.      |
| 🔄 **Same-conversation policy**          | `latest-wins` or `queue` — you pick. Prevents unbounded backlog.                        |
| 🪵 **Structured JSON logs**              | Every request, queue event, subprocess lifecycle, session event.                        |
| 🧩 **TypeScript, strict mode**           | Clean module layout, no `any` escape hatches.                                           |

## Quickstart

You need **Node.js 22+**, **npm**, and the **Claude Code CLI** already logged in.

```bash
# 1. Install Claude CLI and log in (skip if you already have it)
npm install -g @anthropic-ai/claude-code
claude auth login

# 2. Clone, install, start
git clone https://github.com/mattschwen/claude-max-api-proxy.git
cd claude-max-api-proxy
npm install
npm start
```

The server warms up in ~15–25 s (it probes your authenticated account for available models on startup), then binds to `http://127.0.0.1:3456`.

```bash
# Verify
curl http://127.0.0.1:3456/health
curl http://127.0.0.1:3456/v1/models
```

> [!IMPORTANT]
> If `/v1/models` returns `{"object":"list","data":[]}`, stop here. The proxy is running but your Claude CLI account can't access any models. Fix auth first — see [Troubleshooting](./docs/TROUBLESHOOTING.md).

## Usage

### From any OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3456/v1",
    api_key="ignored",  # proxy doesn't check it, but most SDKs require a value
)

resp = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Say hi in one word."}],
)
print(resp.choices[0].message.content)
```

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:3456/v1",
  apiKey: "ignored",
});

const resp = await client.chat.completions.create({
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "Say hi in one word." }],
});
console.log(resp.choices[0].message.content);
```

### From `curl`

```bash
curl -N http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "stream": true,
    "messages": [{ "role": "user", "content": "Write a haiku about local proxies." }]
  }'
```

### Connect common clients

<details>
<summary><b>Continue.dev</b></summary>

```json
{
  "models": [
    {
      "title": "Claude via Max Proxy",
      "provider": "openai",
      "model": "claude-sonnet-4-6",
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
    "claude-max-proxy": {
      "baseUrl": "http://127.0.0.1:3456/v1",
      "api": "openai-completions",
      "auth": "api-key",
      "apiKey": "ignored",
      "models": [{ "id": "claude-sonnet-4-6" }, { "id": "claude-opus-4-6" }]
    }
  }
}
```

</details>

<details>
<summary><b>Aider, LiteLLM, LangChain, anything OpenAI-compatible</b></summary>

Use these defaults:

| Setting  | Value                         |
| -------- | ----------------------------- |
| Base URL | `http://127.0.0.1:3456/v1`    |
| API key  | any non-empty string          |
| Model    | whatever `/v1/models` returns |

</details>

## Configuration

Everything is environment-variable driven. See [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) for the full reference.

```bash
# Cancel in-flight request when a new one lands for the same conversation (default)
export CLAUDE_PROXY_SAME_CONVERSATION_POLICY=latest-wins

# Or: strict FIFO per conversation
export CLAUDE_PROXY_SAME_CONVERSATION_POLICY=queue

# Extra visibility into queue internals
export CLAUDE_PROXY_DEBUG_QUEUES=true

# Optional: enable the runtime thinking-budget admin endpoint
# export CLAUDE_PROXY_ENABLE_ADMIN_API=true

npm start
```

## Running as a service

- **macOS** → [docs/macos-setup.md](./docs/macos-setup.md) (LaunchAgent, auto-start, KeepAlive)
- **Linux** → use systemd with a unit file that runs `node dist/server/standalone.js`
- **Docker** → [docs/docker-setup.md](./docs/docker-setup.md)

## Documentation

| Doc                                                  | What's in it                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| [docs/API.md](./docs/API.md)                         | Full API reference — endpoints, request / response shapes, examples |
| [docs/CONFIGURATION.md](./docs/CONFIGURATION.md)     | Environment variables, timeouts, policies                           |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)       | How the proxy works internally — pool, queues, sessions, logging    |
| [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) | Every failure mode and how to fix it                                |
| [docs/macos-setup.md](./docs/macos-setup.md)         | LaunchAgent setup for auto-start on macOS                           |
| [docs/docker-setup.md](./docs/docker-setup.md)       | Docker and Docker Compose setup                                     |
| [CONTRIBUTING.md](./CONTRIBUTING.md)                 | Dev setup, style, PR flow                                           |
| [SECURITY.md](./SECURITY.md)                         | How to report security issues                                       |

## How it compares

|                                | `claude-max-api-proxy` |  Direct Anthropic API  | Claude Code CLI only |
| ------------------------------ | :--------------------: | :--------------------: | :------------------: |
| Uses your Max plan             |           ✅           | ❌ (separate billing)  |          ✅          |
| OpenAI-compatible endpoints    |           ✅           |           ❌           |          ❌          |
| Streaming                      |           ✅           |           ✅           |          ✅          |
| Session continuity             |           ✅           |      ⚠️ (manual)       |          ✅          |
| Works with Continue/Aider/etc. |           ✅           | ⚠️ (with LiteLLM etc.) |          ❌          |
| Requires API key               |           ❌           |           ✅           |          ❌          |

## Requirements

- **Node.js 22+**
- **npm**
- **[Claude Code CLI](https://github.com/anthropics/claude-code)** installed globally and authenticated
- An active **Claude Max** (or equivalent) subscription with access to at least one Claude model

## Development

```bash
git clone https://github.com/mattschwen/claude-max-api-proxy.git
cd claude-max-api-proxy
npm install
npm run build    # tsc → dist/
npm test         # runs compiled tests under dist/
npm start        # dist/server/standalone.js
```

Source lives in `src/`, compiled output in `dist/` (gitignored). Tests live next to the code they test (`*.test.ts` → `dist/**/*.test.js`). See [CONTRIBUTING.md](./CONTRIBUTING.md) for more.

## Security

The proxy binds to `127.0.0.1` by default and trusts the local Claude CLI session. It does **not** authenticate clients — anything that can reach `:3456` can use your Claude Max plan. Don't expose it beyond localhost without putting proper network controls in front of it, and keep the optional admin API disabled unless you intentionally need it. See [SECURITY.md](./SECURITY.md) to report vulnerabilities.

## License

[MIT](./LICENSE) © Matt Schwen
