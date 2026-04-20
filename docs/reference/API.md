# API Reference

`claude-max-api-proxy` exposes several HTTP endpoints on `http://127.0.0.1:3456` (by default). The OpenAI-compatible endpoints live under `/v1`. The `/health` endpoint is a non-OpenAI operational endpoint.

- [`GET /health`](#get-health)
- [`GET /metrics`](#get-metrics)
- [`GET /v1/models`](#get-v1models)
- [`GET /v1/capabilities`](#get-v1capabilities)
- [`GET /v1/agents`](#get-v1agents)
- [`POST /v1/chat/completions`](#post-v1chatcompletions)
- [`POST /v1/responses`](#post-v1responses)

All endpoints return JSON. The proxy ignores `Authorization` headers — any string (or no header at all) is accepted.

---

## `GET /health`

Operational snapshot. Use this for monitoring, readiness probes, and troubleshooting. It is **not** part of the OpenAI API surface.

### Example

```bash
curl http://127.0.0.1:3456/health
```

### Response shape

```jsonc
{
  "status": "ok",
  "provider": "claude-max-api-proxy",

  "config": {
    "sameConversationPolicy": "latest-wins", // or "queue"
    "debugQueues": false,
    "enableAdminApi": false
  },

  "auth": {
    "loggedIn": true,
    "authMethod": "claude-max",
    "apiProvider": "claude-max",
    "email": "you@example.com",
    "orgId": "org_...",
    "orgName": "Your Org",
    "subscriptionType": "claude-max"
  },

  "models": {
    "checkedAt": "2026-04-11T23:01:16.296Z",
    "available": [
      "claude-opus-<resolved-by-cli>",
      "claude-sonnet-<resolved-by-cli>",
      "claude-haiku-<resolved-by-cli>"
    ],
    "unavailable": [
      { "id": "opus", "code": "model_unavailable", "message": "..." }
    ]
  },

  "pool": {
    "warmedAt": "2026-04-11T23:01:06.359Z",
    "isWarm": true,
    "poolSize": 5,
    "warming": false
  },

  "sessions": {
    "active": 12,
    "failureStats": { "resumeFailures": 0, "invalidated": 1 }
  },

  "subprocesses": {
    "active": 2,
    "pids": [53912, 53914]
  },

  "queues": { /* per-conversation queue state */ },

  "store": {
    "conversations": 48,
    "messages": 412
  },

  "metrics": {
    "requestsTotal": 1287,
    "requestsInFlight": 2,
    "avgTtfbMs": 4821
  },

  "recentErrors": [
    { "ts": "...", "event": "subprocess.stall", "detail": "..." }
  ],

  "stallDetections": 3
}
```

### Fields to watch

| Field | Why it matters |
| --- | --- |
| `status` | `"ok"` means the server bound and is accepting traffic. Does **not** imply models are usable — check `models.available`. |
| `auth.loggedIn` | `false` means the Claude CLI on this machine is not authenticated — chat requests will fail. |
| `models.available` | If this array is empty, every chat request will fail with `no_models_available`. |
| `pool.isWarm` | `false` means the CLI warm-up loop has gone idle; the next request may pay extra CLI/auth startup latency. |
| `queues` | Long per-conversation queues indicate a stuck request or a client spamming the same conversation key. |
| `stallDetections` | If this increments, the subprocess output stream is going idle mid-response. See [TROUBLESHOOTING](./TROUBLESHOOTING.md). |

---

## `GET /metrics`

Operational metrics endpoint for scraping and dashboards.

By default this returns Prometheus exposition format as `text/plain`.
Add `?format=json` to get a structured JSON snapshot of both live gauges and
accumulated counters/histograms.

### Example

```bash
curl http://127.0.0.1:3456/metrics
curl http://127.0.0.1:3456/metrics?format=json
```

### What it includes

- HTTP request counts, durations, response sizes, and in-flight gauge
- Proxy request starts, outcomes, retries, TTFB, response sizes, and queue depth
- Queue event counters
- Claude subprocess spawn / kill / stall / close counters
- Session lifecycle counters
- Auth, pool warm, CLI error, and token-validation counters
- Live gauges for queued requests, active sessions, active subprocesses, pool state, store size, and model availability
- Process uptime, memory, and CPU gauges/counters

### Example metric names

```text
claude_proxy_http_requests_total
claude_proxy_http_request_duration_ms_bucket
claude_proxy_requests_started_total
claude_proxy_request_outcomes_total
claude_proxy_request_ttfb_ms_bucket
claude_proxy_queue_events_total
claude_proxy_subprocess_spawns_total
claude_proxy_runtime_queued_requests
claude_proxy_models_available
claude_proxy_process_resident_memory_bytes
```

> [!NOTE]
> `GET /metrics` is operational, not OpenAI-compatible. Use it for Prometheus,
> dashboards, alerting, and capacity planning.

---

## `GET /v1/models`

OpenAI-compatible. Returns the list of models the current Claude CLI account can
actually use on this machine, plus any configured external provider models.
Claude availability is computed by probing the stable Claude CLI family aliases
(`sonnet`, `opus`, `haiku`) and publishing the exact versioned IDs that the
installed CLI resolves at runtime.

### Example

```bash
curl http://127.0.0.1:3456/v1/models
```

### Response

```json
{
  "object": "list",
  "data": [
    {
      "id": "claude-sonnet-<resolved-by-cli>",
      "object": "model",
      "owned_by": "anthropic",
      "created": 1710000000
    },
    {
      "id": "claude-opus-<resolved-by-cli>",
      "object": "model",
      "owned_by": "anthropic",
      "created": 1710000000
    },
    {
      "id": "glm-4.7-flash",
      "object": "model",
      "owned_by": "zai",
      "created": 1710000000
    },
    {
      "id": "gemini-2.5-flash",
      "object": "model",
      "owned_by": "google",
      "created": 1710000000
    }
  ]
}
```

> [!NOTE]
> An empty `data` array is a **real** signal, not a bug. It means your current `claude auth` session cannot access any of the model families the proxy probes. Re-run `claude auth status` and check `/health.models.unavailable` for the specific reason each family failed.

> [!NOTE]
> If `GEMINI_CLI_ENABLED`, `GEMINI_CLI_MODEL`, `GEMINI_CLI_EXTRA_MODELS`,
> `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `ZAI_API_KEY`, `BIGMODEL_API_KEY`, or the
> explicit `OPENAI_COMPAT_FALLBACK_*` variables are configured, `/v1/models`
> also advertises those external provider models. They are explicit opt-in
> routes, not the implicit default.

---

## `GET /v1/capabilities`

Capability discovery endpoint for agent frameworks and protocol adapters. This endpoint publishes what the running proxy currently supports, what the local Claude CLI can do, and which resolved models use adaptive reasoning.

### Example

```bash
curl http://127.0.0.1:3456/v1/capabilities
```

### Response

```jsonc
{
  "object": "capabilities",
  "provider": "claude-max-api-proxy",
  "endpoints": {
    "health": "/health",
    "models": "/v1/models",
    "chatCompletions": "/v1/chat/completions",
    "responses": "/v1/responses",
    "capabilities": "/v1/capabilities"
  },
  "compatibility": {
    "chatCompletions": true,
    "responses": true,
    "streamingChatCompletions": true,
    "streamingResponses": false,
    "tools": false,
    "structuredOutputs": false,
    "mcpServer": false
  },
  "agents": {
    "default": null,
    "available": [
      {
        "id": "expert-coder",
        "name": "Claw Proxy Expert Coder",
        "description": "Canonical repo-native coding agent tuned for Claw Proxy architecture, integration work, debugging, and implementation.",
        "tags": ["coding", "architecture", "integration", "debugging", "open-source"],
        "defaultReasoningEffort": "high"
      }
    ]
  },
  "reasoning": {
    "allowedLabels": ["off", "low", "medium", "high", "xhigh", "max"],
    "defaultBudget": null,
    "adaptiveModels": ["claude-sonnet-4-7", "claude-opus-4-7"],
    "fixedBudgetModels": ["claude-haiku-4-5"]
  },
  "cli": {
    "version": "claude 2.1.112",
    "supportsXHighEffort": true,
    "supportsAdaptiveReasoning": true,
    "permissionMode": "default",
    "tools": ["Read", "Write"],
    "mcpServers": [],
    "slashCommands": [],
    "skills": [],
    "plugins": []
  }
}
```

Use this endpoint to decide whether to call `/v1/chat/completions` or `/v1/responses`, whether the current runtime can handle adaptive reasoning, and whether a higher-level MCP shim still needs to be added outside the proxy.

When an external provider is configured, the payload also includes
`externalProviders` plus the merged model list under `models.available`.

---

## `GET /v1/agents`

Lists the built-in agent catalog shipped by the proxy.

### Example

```bash
curl http://127.0.0.1:3456/v1/agents
curl http://127.0.0.1:3456/v1/agents/expert-coder
```

### Response

```json
{
  "object": "list",
  "data": [
    {
      "id": "expert-coder",
      "name": "Claw Proxy Expert Coder",
      "description": "Canonical repo-native coding agent tuned for Claw Proxy architecture, integration work, debugging, and implementation.",
      "tags": ["coding", "architecture", "integration", "debugging", "open-source"],
      "defaultReasoningEffort": "high"
    }
  ],
  "default": null
}
```

### Scoped agent routes

Use these routes when you want to force every request through the built-in
agent profile instead of relying on caller-supplied prompts:

- `POST /v1/agents/expert-coder/chat/completions`
- `POST /v1/agents/expert-coder/responses`

You can also send `"agent": "expert-coder"` in the request body, or set
`CLAUDE_PROXY_DEFAULT_AGENT=expert-coder` to make the agent profile apply to
every request automatically.

---

## `POST /v1/chat/completions`

OpenAI-compatible chat completion endpoint. Supports streaming (`stream: true`) and non-streaming.

The proxy accepts:

- stable family aliases: `sonnet`, `opus`, `haiku`
- exact versioned IDs returned by `GET /v1/models`
- older/future versioned IDs for those families, which are mapped to the currently available family model on this machine
- configured external provider models such as `gemini-2.5-pro`, `gemini-2.5-flash`, `glm-4.7-flash`, `glm-5`, or `glm-4.7`
- optional built-in agent selection via request body `"agent": "expert-coder"` or the scoped `/v1/agents/:agentId/chat/completions` route

### Minimal non-streaming request

```bash
curl http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "messages": [
      { "role": "user", "content": "Reply with exactly: OK" }
    ]
  }'
```

### Non-streaming response

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1775948570,
  "model": "claude-sonnet-<resolved-by-cli>",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "OK" },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 3,
    "completion_tokens": 4,
    "total_tokens": 7
  }
}
```

### Streaming request

```bash
curl -N http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Count from 1 to 5." }
    ]
  }'
```

Response is a Server-Sent Events stream of OpenAI-shaped `chat.completion.chunk` objects, terminated by `data: [DONE]`.

### External provider behavior

When an external provider is configured:

- requests for a configured external model ID are sent there directly
- requests that omit `model`, use `default`, or ask for Claude families stay on
  the Claude path
- if Claude has no accessible models, those Claude-default requests return a
  Claude error instead of silently switching providers
- `/v1/responses` inherits the same behavior because it reuses this endpoint

The local Gemini CLI provider can advertise multiple model IDs via
`GEMINI_CLI_EXTRA_MODELS`. API-key fallbacks still advertise one configured
model at a time.

### Reasoning controls

The proxy accepts reasoning controls through any of these inputs:

- request body `thinking.budget_tokens`
- request body `thinking.effort`
- request body `reasoning.mode` / `reasoning.effort` / `reasoning.budget_tokens`
- request body `reasoning_effort` (`off`, `low`, `medium`, `high`, `xhigh`, `max`)
- request body `output_config.effort`
- request header `X-Thinking-Budget` (integer tokens or the same effort labels)
- server default `DEFAULT_THINKING_BUDGET`

`xhigh` maps to an intermediate 48000-token tier when the installed Claude CLI
supports it. On older Claude CLI builds, the proxy falls back to `max`.

For newer Sonnet/Opus model lines that use adaptive reasoning, the proxy
normalizes incoming fixed-budget style requests to Claude CLI effort levels and
publishes those adaptive-capable models in `GET /v1/capabilities`.

Example using the standard `thinking` field:

```json
{
  "model": "opus",
  "stream": true,
  "thinking": { "type": "enabled", "budget_tokens": 10000 },
  "messages": [
    { "role": "user", "content": "Solve this carefully." }
  ]
}
```

When any reasoning source is active, the proxy multiplies the family's hard timeout by 3× to allow for longer reasoning windows.

### Conversation continuity — the `user` field

The OpenAI-standard `user` field is repurposed as a **conversation key**. Reuse the same `user` across multiple requests to have the proxy resume the same underlying Claude CLI session:

```json
{
  "model": "sonnet",
  "user": "chat-abc-123",
  "messages": [
    { "role": "user", "content": "Remember the number 17." }
  ]
}
```

```json
{
  "model": "sonnet",
  "user": "chat-abc-123",
  "messages": [
    { "role": "user", "content": "What number did I ask you to remember?" }
  ]
}
```

The proxy will resume the first call's CLI session so the second request has full context.

If `user` is omitted, the proxy treats each request as a fresh conversation.

### Same-conversation policy

The default policy is `latest-wins`. If a second request arrives for the same `user` while the first is still in flight, the older request is canceled and any stale queued work for that conversation is dropped. Set `CLAUDE_PROXY_SAME_CONVERSATION_POLICY=queue` to get strict FIFO instead. See [CONFIGURATION](./CONFIGURATION.md#same-conversation-policy).

### Error responses

Errors follow OpenAI's error-envelope shape:

```json
{
  "error": {
    "message": "There's an issue with the selected model (claude-opus-<requested>). ...",
    "type": "invalid_request_error",
    "code": "model_unavailable"
  }
}
```

Common `error.code` values:

| Code | Meaning |
| --- | --- |
| `model_unavailable` | Client asked for a model that `/v1/models` doesn't list. Query `/v1/models` and retry. |
| `no_models_available` | Proxy's startup probes all failed. Check `claude auth status`. |
| `auth_required` | Claude CLI is not authenticated. Run `claude auth login`. |
| `rate_limited` | Claude returned a rate-limit / budget error. Back off and retry. |
| `claude_cli_error` | Generic CLI failure — check `/health.recentErrors`. |
| `invalid_request` | Anthropic returned `invalid_request`. See the `message` for the specific reason. |

---

## `POST /v1/responses`

Minimal OpenAI Responses API compatibility layer. This endpoint currently supports **non-streaming** requests and reuses the same underlying Claude CLI session engine as `/v1/chat/completions`.

### Example

```bash
curl http://127.0.0.1:3456/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "instructions": "Answer in one sentence.",
    "input": "What does this proxy do?"
  }'
```

### Response

```json
{
  "id": "resp_...",
  "object": "response",
  "created_at": 1775948570,
  "status": "completed",
  "model": "claude-sonnet-4-7",
  "output": [
    {
      "id": "msg_resp_...",
      "type": "message",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "It exposes your authenticated Claude CLI as a local OpenAI-compatible gateway.",
          "annotations": []
        }
      ]
    }
  ],
  "output_text": "It exposes your authenticated Claude CLI as a local OpenAI-compatible gateway.",
  "usage": {
    "input_tokens": 12,
    "output_tokens": 18,
    "total_tokens": 30
  },
  "previous_response_id": null
}
```

### Conversation continuity

The proxy keeps a short-lived mapping from each returned response ID to the
underlying conversation key. Reuse `previous_response_id` on later calls to
continue the same Claude CLI session without manually supplying `user`.

### Notes

- `stream: true` is not supported yet on `/v1/responses`; use `/v1/chat/completions` for streaming.
- `input` accepts plain strings, text items, or message-shaped items with `role` and `content`.
- `agent` accepts a built-in agent id such as `expert-coder`, or you can use the scoped `/v1/agents/:agentId/responses` route.
- Reasoning controls (`thinking`, `reasoning`, `reasoning_effort`, `output_config.effort`) are passed through the same normalization logic used by `/v1/chat/completions`.
