<div align="center">

<pre>
 CCC   L      AAA   W   W      PPPP   RRRR    OOO   X   X  Y   Y
C   C  L     A   A  W   W      P   P  R   R  O   O   X X    Y Y
C      L     AAAAA  W W W      PPPP   RRRR   O   O    X      Y
C   C  L     A   A  WW WW      P      R R    O   O   X X     Y
 CCC   LLLLL A   A  W   W      P      R  RR   OOO   X   X    Y
</pre>

<p>
  <b>Claw Proxy</b> is the README identity for
  <code>claude-max-api-proxy</code>.
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/banner-dark.svg">
  <img alt="claude-max-api-proxy - An OpenAI-compatible API server powered by Claude Code CLI." src="./assets/banner-light.svg" width="100%">
</picture>

<br/>

<p>
  <a href="#60-second-launch"><img alt="launch" src="https://img.shields.io/badge/launch-60s-ff7a3c?style=flat-square&labelColor=1a0f1e"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-f5efe7?style=flat-square&labelColor=1a0f1e"></a>
  <img alt="ci" src="https://img.shields.io/github/actions/workflow/status/mattschwen/claude-max-api-proxy/ci.yml?branch=main&style=flat-square&label=ci&labelColor=1a0f1e">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522-4ade80?style=flat-square&labelColor=1a0f1e">
  <img alt="typescript" src="https://img.shields.io/badge/typescript-strict-3178c6?style=flat-square&labelColor=1a0f1e">
  <img alt="openai" src="https://img.shields.io/badge/openai-compatible-06b6d4?style=flat-square&labelColor=1a0f1e">
  <img alt="models" src="https://img.shields.io/badge/models-dynamic-f59e0b?style=flat-square&labelColor=1a0f1e">
  <img alt="docker" src="https://img.shields.io/badge/docker-optional-38bdf8?style=flat-square&labelColor=1a0f1e">
</p>

<p>
  <b>Point any OpenAI-compatible client at your Claude Max plan.</b><br/>
  OpenAI in. Claude Code CLI out. Localhost in the middle.
</p>

<p>
  <code>Continue.dev</code> / <code>Aider</code> / <code>OpenAI SDKs</code> / <code>curl</code>
  &rarr;
  <code>127.0.0.1:3456</code>
  &rarr;
  <code>claude-max-api-proxy</code>
  &rarr;
  <code>authenticated claude CLI</code>
  &rarr;
  <code>Claude Max</code>
</p>

<p>
  <a href="#why-it-exists">Why</a> ·
  <a href="#signal-path">Signal Path</a> ·
  <a href="#what-you-get">What You Get</a> ·
  <a href="#60-second-launch">Launch</a> ·
  <a href="#plug-in-any-openai-client">Usage</a> ·
  <a href="./docs/API.md">API</a> ·
  <a href="./docs/CONFIGURATION.md">Config</a> ·
  <a href="./docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="./docs/TROUBLESHOOTING.md">Troubleshooting</a>
</p>

</div>

---

## Why It Exists

You already have a working Claude Max session on your machine. Your local
`claude` CLI is authenticated. But the rest of the modern tooling ecosystem
keeps asking for an OpenAI-compatible `baseURL`.

That mismatch is the whole reason this project exists.

`claude-max-api-proxy` runs a local HTTP server on `127.0.0.1:3456`, accepts
OpenAI-shaped requests, invokes the authenticated Claude Code CLI underneath,
and streams the result back in the format your client already expects.

No separate Anthropic API key. No extra API bill. No Docker requirement. Just
your existing Claude Max session exposed behind a clean, local, OpenAI-shaped
surface.

<table>
  <tr>
    <td width="33%" valign="top">
      <b>OpenAI Shape</b><br/>
      Keep your existing SDKs, editors, and agents. Change the base URL, not
      your workflow.
    </td>
    <td width="33%" valign="top">
      <b>Claude Underneath</b><br/>
      Requests flow through the authenticated <code>claude</code> CLI, so the
      proxy rides the real local session you already use.
    </td>
    <td width="33%" valign="top">
      <b>Dynamic Models</b><br/>
      Stable aliases stay simple while <code>/v1/models</code> publishes the
      exact model IDs your installed CLI resolves today.
    </td>
  </tr>
</table>

## Signal Path

```text
+---------------------------+      +-----------------------------+      +---------------------------+
| OpenAI-compatible client  | ---> | claude-max-api-proxy       | ---> | Claude Code CLI           |
|                           |      |                             |      |                           |
| OpenAI SDK                |      | /v1/chat/completions       |      | authenticated locally     |
| Continue.dev              |      | /v1/models                 |      | probes real model access  |
| Aider                     |      | /health                    |      | streams Claude responses  |
| curl                      |      | local queue + session mgmt |      | uses your Max account     |
+---------------------------+      +-----------------------------+      +---------------------------+
```

## What You Get

| Surface | Why it matters |
| --- | --- |
| OpenAI-compatible API | `POST /v1/chat/completions`, `GET /v1/models`, and `GET /health`, with streaming and non-streaming support. |
| Zero extra credentials | Reuses the machine's existing `claude auth login` session instead of asking clients for a second API key. |
| Dynamic model routing | Probes stable families like `sonnet`, `opus`, and `haiku`, then surfaces the exact model IDs your local Claude CLI currently resolves. |
| Session continuity | Reuses the OpenAI `user` field as a conversation key and resumes the underlying CLI session automatically. |
| Operational discipline | Warm subprocess pool, per-family stall timeouts, kill escalation, structured logs, and a detailed `/health` snapshot. |
| Sensible deployment | Plain Node.js checkout first. Docker supported, but optional. macOS and Linux service docs included. |

## 60-Second Launch

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
curl http://127.0.0.1:3456/v1/models
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
| API key | any non-empty string |
| Model | `sonnet`, `opus`, `haiku`, or an exact ID from `/v1/models` |

The proxy accepts stable family aliases and resolves them to whatever exact
version the installed Claude CLI currently exposes. `GET /v1/models` returns
those runtime-resolved IDs.

### Example client snippets

<details>
<summary><b>Continue.dev</b></summary>

```json
{
  "models": [
    {
      "title": "Claude via Max Proxy",
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
    "claude-max-proxy": {
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
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Dev setup, style, tests, and PR flow |
| [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) | Community expectations |
| [SECURITY.md](./SECURITY.md) | Private vulnerability reporting |

## Compare the Options

| Capability | `claude-max-api-proxy` | Direct Anthropic API | Claude Code CLI only |
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
[CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR, use the issue
templates when they apply, and follow the expectations in
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Security

The proxy binds to `127.0.0.1` by default and trusts the local Claude CLI
session. It does **not** authenticate clients. Anything that can reach `:3456`
can spend your Claude Max quota.

Keep it on localhost unless you deliberately place it behind real network
controls, and leave the optional admin API disabled unless you explicitly need
it. See [SECURITY.md](./SECURITY.md) for responsible disclosure.

## License

[MIT](./LICENSE)
