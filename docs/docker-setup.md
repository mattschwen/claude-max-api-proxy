# Optional Docker Setup

Run the proxy in a container if you want a containerized deployment. Docker is fully optional; the standard source install lives in [README.md](../README.md).

The image builds from source, installs the Claude CLI, and runs as a non-root user.

## Prerequisites

- Docker and Docker Compose
- Claude Code CLI installed and authenticated on the host (`claude auth login`)

## Quick Start

```bash
cp .env.example .env
# Edit .env — set REPOS_DIR to your repos directory
docker compose up -d
```

The proxy starts on port 3456. Verify it works:

```bash
curl http://127.0.0.1:3456/health
curl http://127.0.0.1:3456/v1/models
```

## Configuration

All settings go in `.env`. See `.env.example` for defaults.

| Variable                  | Default          | Description                                                                                                            |
| ------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `PORT`                    | `3456`           | Host port published by Docker Compose. The Node process still listens on `3456` inside the container.                 |
| `REPOS_DIR`               | `/opt/repos`     | Host directory with your repos, mounted into the container                                                             |
| `CLAUDE_CONFIG_DIR`       | `~/.claude`      | Path to your Claude CLI config directory                                                                               |
| `CLAUDE_CONFIG_FILE`      | `~/.claude.json` | Path to your Claude CLI config file                                                                                    |
| `PUID`                    | `1000`           | User ID the container process runs as                                                                                  |
| `PGID`                    | `1000`           | Group ID the container process runs as                                                                                 |
| `CLAUDE_PROXY_ENABLE_ADMIN_API` | `false`    | Enable the mutable `/admin/thinking-budget` endpoint                                                                   |
| `DEFAULT_THINKING_BUDGET` | _(unset)_        | Default extended-thinking budget when the client does not send one. See [Extended Thinking](#extended-thinking) below. |

### File permissions

The container runs as a non-root user (Claude CLI requires this). Set `PUID` and `PGID` to match your host user so the container can read your Claude credentials and write to your repos:

```bash
# Find your UID/GID
id -u  # e.g. 1000
id -g  # e.g. 1000
```

Add to `.env`:

```
PUID=1000
PGID=1000
```

### Persistent data

The `docker-compose.yml` creates a named volume (`claude-max-proxy-data`) for the SQLite database and session state. This data persists across container restarts.

To reset it:

```bash
docker compose down -v
```

## Use with other containers

The proxy binds to `0.0.0.0` inside the container. Other containers on the same Docker network can reach it by container name:

```
http://claude-max-proxy:3456/v1
```

To add the proxy to another project's Docker network, create a compose override or add the proxy's network as external:

```yaml
# In your other project's docker-compose.yml
services:
  your-service:
    networks:
      - default
      - claude-proxy

networks:
  claude-proxy:
    name: claude-max-proxy_default
    external: true
```

Then use `http://claude-max-proxy:3456/v1` as the base URL from your service.

## Optional GitHub / git access inside the container

The proxy itself does **not** require GitHub credentials inside the container. If you want Claude Code tasks running in the container to interact with GitHub repositories on your behalf, mount your existing git and GitHub CLI configuration:

```yaml
services:
  claude-max-proxy:
    volumes:
      - ${HOME}/.gitconfig:/home/node/.gitconfig:ro
      - ${HOME}/.config/gh:/home/node/.config/gh:ro
```

Leave those mounts out unless you explicitly need them.

## Extended Thinking

The proxy enables Claude's extended thinking when any of these sources provide a budget, checked in this order:

1. Request body `thinking.budget_tokens` — Anthropic style.
2. Request body `reasoning_effort` — OpenAI style. Values: `off`, `low`, `medium`, `high`, `xhigh`, `max`.
3. Request header `X-Thinking-Budget` — accepts an integer (tokens) or one of the effort labels.
4. Environment variable `DEFAULT_THINKING_BUDGET` — server-wide default.

Effort labels map to token budgets: `off` = disabled, `low` = 5000, `medium` = 10000, `high` = 32000, `xhigh` = 48000, `max` = 64000.
On older Claude CLI builds, `xhigh` falls back to `max`.

### When to use `DEFAULT_THINKING_BUDGET`

Use this when your client cannot pass thinking settings through the OpenAI-compatible API. OpenClaw, for example, sets `thinkingDefault` on its agents and does not forward that value to OpenAI-style providers. Set `DEFAULT_THINKING_BUDGET=high` in `.env` and every request gets extended thinking without any client changes.

```
DEFAULT_THINKING_BUDGET=high
```

Per-request overrides from any of the sources above take priority.

### Optional admin endpoint

If your client cannot send `reasoning_effort` or `X-Thinking-Budget`, you can opt into a mutable runtime default:

```bash
CLAUDE_PROXY_ENABLE_ADMIN_API=true docker compose up -d
```

That mounts `GET/POST/PUT /admin/thinking-budget`. Leave it disabled unless you trust every client that can reach the proxy.

### Per-request examples

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

After pulling updates:

```bash
docker compose up -d --build
```

## Logs

```bash
docker compose logs -f
```

## Security

The proxy does not authenticate clients. Any container or process that can reach port 3456 can use your Claude Max plan. Only expose it on trusted networks, and leave `CLAUDE_PROXY_ENABLE_ADMIN_API` off unless you explicitly need it.
