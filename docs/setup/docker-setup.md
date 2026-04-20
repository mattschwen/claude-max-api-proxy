# Optional Docker Setup

Docker is optional. The built-in dashboard already ships inside the proxy at
`/`, with `/ops` and `/dashboard` as aliases, so there is no separate
Grafana/Prometheus stack to install.

## Recommended: Host Proxy + Open WebUI

This is the best local flow when your Claude CLI auth already works on the
host.

```bash
# terminal 1
export HOST=0.0.0.0
export CLAUDE_PROXY_LOG_FILE=logs/proxy.jsonl
npm start

# terminal 2
docker compose up -d open-webui
```

Verify it:

```bash
curl http://127.0.0.1:3456/health
open http://127.0.0.1:3456/
open http://127.0.0.1:8080/
```

## Fully Containerized Proxy

Use this only if your Claude CLI credentials are readable inside Docker and you
explicitly want the proxy itself containerized.

```bash
cp .env.example .env
# edit .env for your host paths and UID/GID if needed
docker compose --profile container-proxy up -d claude-max-proxy
```

Verify it:

```bash
curl http://127.0.0.1:3456/health
curl http://127.0.0.1:3456/v1/models
docker compose --profile container-proxy ps
```

The shipped image and Compose service both include a `/health`-based
container healthcheck, so `docker compose ps` should converge to `healthy`
once the proxy has finished its Claude startup probes.

If you also want Open WebUI to talk to the containerized proxy instead of the
host-run proxy, set this in `.env` first:

```bash
OPEN_WEBUI_OPENAI_API_BASE_URL=http://claude-max-proxy:3456/v1
```

Then start both services together:

```bash
docker compose --profile container-proxy up -d claude-max-proxy open-webui
```

## Configuration

All settings go in `.env`. See `.env.example` for defaults.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3456` | Host port published by the proxy container |
| `REPOS_DIR` | `/opt/repos` | Host directory with repos mounted into the proxy container |
| `OPEN_WEBUI_PORT` | `8080` | Host port for Open WebUI |
| `OPEN_WEBUI_OPENAI_API_BASE_URL` | `http://host.docker.internal:3456/v1` | OpenAI-compatible backend Open WebUI should call |
| `OPEN_WEBUI_OPENAI_API_KEY` | `local` | Placeholder key Open WebUI sends to the backend |
| `OPEN_WEBUI_TASK_MODEL_EXTERNAL` | `sonnet` | Default model Open WebUI requests |
| `GEMINI_CLI_ENABLED` | _(unset)_ | Enable the local Gemini CLI provider when the proxy is running on the host, or inside the container if you have installed/authenticated Gemini there |
| `GEMINI_CLI_COMMAND` | `gemini` | Gemini CLI executable path |
| `GEMINI_CLI_MODEL` | `gemini-2.5-pro` when Gemini CLI is enabled | Default local Gemini CLI model advertised for explicit Gemini requests |
| `GEMINI_CLI_EXTRA_MODELS` | _(unset)_ | Additional local Gemini CLI models to advertise, such as `gemini-2.5-flash` |
| `GEMINI_CLI_WORKDIR` | host/container temp dir | Isolated workdir used for Gemini CLI requests |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | _(unset)_ | Advertises the Gemini OpenAI-compatible provider inside the proxy |
| `ZAI_API_KEY` / `BIGMODEL_API_KEY` | _(unset)_ | Advertises the Z.AI / GLM provider inside the proxy |
| `ZAI_MODEL` | `glm-4.7-flash` when Z.AI is inferred | Which GLM model the proxy advertises |
| `ZAI_BASE_URL` | `https://api.z.ai/api/paas/v4` when Z.AI is inferred | Override the Z.AI OpenAI-compatible base URL |
| `ZAI_CODING_PLAN` | `false` | Use Z.AI's coding endpoint defaults so larger models like `glm-5` or `glm-4.7` can be selected |
| `OPENAI_COMPAT_FALLBACK_PROVIDER` | provider-specific inference | Provider label advertised by the proxy |
| `OPENAI_COMPAT_FALLBACK_BASE_URL` | provider-specific inference | OpenAI-compatible external provider base URL |
| `OPENAI_COMPAT_FALLBACK_API_KEY` | _(unset)_ | API key for the external provider |
| `OPENAI_COMPAT_FALLBACK_MODEL` | provider-specific inference | Model the proxy advertises for explicit external routing |
| `OPENAI_COMPAT_FALLBACK_STREAM_MODE` | `synthetic` | Whether the proxy synthesizes OpenAI SSE for external models or passes upstream streaming through directly |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Path to your Claude CLI config directory |
| `CLAUDE_CONFIG_FILE` | `~/.claude.json` | Path to your Claude CLI config file |
| `PUID` | `1000` | UID used by the proxy container |
| `PGID` | `1000` | GID used by the proxy container |
| `CLAUDE_PROXY_ENABLE_ADMIN_API` | `false` | Enable the mutable `/admin/thinking-budget` endpoint |
| `DEFAULT_THINKING_BUDGET` | _(unset)_ | Default extended-thinking budget when the client does not send one |

## File Permissions

The proxy container runs as a non-root user. Set `PUID` and `PGID` to match
your host user so Docker can read Claude credentials and write project data:

```bash
id -u
id -g
```

Add the values to `.env`:

```bash
PUID=1000
PGID=1000
```

## Persistent Data

The compose file creates named volumes for:

- `claude-max-proxy-data` when you run the proxy container
- `open-webui-data` when you run Open WebUI

To reset them:

```bash
docker compose down -v
```

## Use With Other Containers

When you run the `container-proxy` profile, the proxy binds to `0.0.0.0`
inside Docker. Other containers on the same network can reach it by container
name:

```text
http://claude-max-proxy:3456/v1
```

To join another project's network:

```yaml
services:
  your-service:
    networks:
      - default
      - claude-proxy

networks:
  claude-proxy:
    name: claude-max-api-proxy_default
    external: true
```

## External Providers In Docker

Claude remains the default provider. These are optional.

If you run the proxy on the host and want Open WebUI to use Gemini
intentionally, the CLI-first path is:

```bash
GEMINI_CLI_ENABLED=true
GEMINI_CLI_COMMAND=/opt/homebrew/bin/gemini
GEMINI_CLI_MODEL=gemini-2.5-pro
GEMINI_CLI_EXTRA_MODELS=gemini-2.5-flash
OPEN_WEBUI_TASK_MODEL_EXTERNAL=gemini-2.5-flash
```

If you specifically want the containerized proxy to advertise a hosted GLM
route, add this to `.env`:

```bash
ZAI_API_KEY=your-z-ai-key
ZAI_MODEL=glm-4.7-flash
```

For Gemini's hosted API instead:

```bash
GEMINI_API_KEY=your-google-ai-studio-key
```

Then start the proxy normally. `GET /v1/models` will include the configured
external model. Requests only route there when the client explicitly asks for
that model ID; omitted `model`, `default`, and Claude-family requests stay on
the Claude path.

## Optional GitHub / git Access Inside the Container

The proxy does not require GitHub credentials in Docker. If you want Claude
Code tasks inside the container to interact with GitHub repos on your behalf,
mount your existing config:

```yaml
services:
  claude-max-proxy:
    volumes:
      - ${HOME}/.gitconfig:/home/node/.gitconfig:ro
      - ${HOME}/.config/gh:/home/node/.config/gh:ro
```

Leave those mounts out unless you explicitly need them.

## Extended Thinking

The proxy enables Claude's extended thinking when any of these sources provide
a budget, checked in this order:

1. Request body `thinking.budget_tokens`
2. Request body `reasoning_effort`
3. Request header `X-Thinking-Budget`
4. Environment variable `DEFAULT_THINKING_BUDGET`

Effort labels map to token budgets: `off` disables thinking, `low` = 5000,
`medium` = 10000, `high` = 32000, `xhigh` = 48000, `max` = 64000. On older
Claude CLI builds, `xhigh` falls back to `max`.

### When to Use `DEFAULT_THINKING_BUDGET`

Use this when your client cannot pass thinking settings through the
OpenAI-compatible API.

```bash
DEFAULT_THINKING_BUDGET=high
```

Per-request overrides still take priority.

### Optional Admin Endpoint

If your client cannot send `reasoning_effort` or `X-Thinking-Budget`, you can
opt into a mutable runtime default:

```bash
CLAUDE_PROXY_ENABLE_ADMIN_API=true docker compose --profile container-proxy up -d claude-max-proxy
```

That exposes `GET/POST/PUT /admin/thinking-budget`. Leave it disabled unless
you trust every client that can reach the proxy.

### Per-Request Examples

```bash
# OpenAI reasoning_effort
curl http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opus",
    "reasoning_effort": "high",
    "messages": [{"role": "user", "content": "Plan a migration strategy."}]
  }'

# Anthropic thinking
curl http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opus",
    "thinking": {"type": "enabled", "budget_tokens": 16000},
    "messages": [{"role": "user", "content": "Plan a migration strategy."}]
  }'

# Header override
curl http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Thinking-Budget: high" \
  -d '{"model": "opus", "messages": [...]}'
```

## Rebuilding

```bash
docker compose --profile container-proxy up -d --build claude-max-proxy
```

## Logs

```bash
docker compose logs -f open-webui
docker compose --profile container-proxy logs -f claude-max-proxy
```

## Security

The proxy does not authenticate clients. Any process that can reach port 3456
can use your Claude Max plan. Only expose it on trusted networks, and leave
`CLAUDE_PROXY_ENABLE_ADMIN_API` off unless you explicitly need it.
