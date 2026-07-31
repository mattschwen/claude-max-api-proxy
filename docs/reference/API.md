# API Reference

`claude-max-api-proxy` exposes several HTTP endpoints on `http://127.0.0.1:3456` (by default). The OpenAI-compatible endpoints live under `/v1`. The `/health` endpoint is a non-OpenAI operational endpoint.

- [`GET /health`](#get-health)
- [`GET /metrics`](#get-metrics)
- [`GET /v1/models`](#get-v1models)
- [`GET /v1/capabilities`](#get-v1capabilities)
- [`GET /v1/agents`](#get-v1agents)
- [`POST /v1/chat/completions`](#post-v1chatcompletions)
- [`POST /v1/responses`](#post-v1responses)
- [`DELETE /v1/requests/:requestId`](#delete-v1requestsrequestid)
- [Optional admin API](#optional-admin-api)

OpenAI-compatible inference endpoints do not require proxy authentication.
Optional `/admin/*` routes are loopback/token protected. Keep the operational
surfaces on a trusted network because they expose local runtime state.

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
    "advertised": [
      "claude-sonnet-<resolved-by-cli>",
      "local/qwen3"
    ],
    "available": [
      "claude-sonnet-<resolved-by-cli>",
      "local/qwen3"
    ],
    "configured": ["openrouter/google/gemini-3-pro"],
    "unavailable": [
      {
        "id": "opus",
        "provider": "claude-cli",
        "code": "model_unavailable",
        "message": "..."
      }
    ]
  },

  "externalProviderAvailability": [
    {
      "provider": "local",
      "availability": {
        "state": "available",
        "availableModels": ["local/qwen3"],
        "unavailableModels": []
      }
    }
  ],

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
| `status` | `"ok"` means the server bound and is accepting traffic. It does **not** imply every model is usable. |
| `auth.loggedIn` | `false` means Claude routes are unavailable. Explicit external-provider routes can still work when Claude is optional. |
| `models.advertised` | Model IDs currently returned by `/v1/models`. |
| `models.available` | Models confirmed by the latest Claude or external-provider probe. |
| `models.configured` | External models that are advertised but have not yet received a conclusive probe result. |
| `models.unavailable` | Models with a conclusive failed probe, including provider and error details. |
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
Claude availability is computed by probing the account-tier `default` plus the
Claude family selectors (`sonnet`, `opus`, `fable`, `haiku`) and publishing the
exact versioned IDs that the installed CLI resolves at runtime. The request API also accepts `best`
(Opus) and account-gated `sonnet[1m]` / `opus[1m]` selectors; extended-context
selectors are passed through to Claude Code for the entitlement check.

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
> An empty `data` array is a **real** signal, not a bug. It means the current
> Claude session exposes no probed model and no external model is configured.
> Re-run `claude auth status` and check `/health.models.unavailable` for Claude
> failures, or configure an explicit external provider.

> [!NOTE]
> If `GEMINI_CLI_ENABLED`, `GEMINI_CLI_MODEL`, `GEMINI_CLI_EXTRA_MODELS`,
> `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `ZAI_API_KEY`, `BIGMODEL_API_KEY`, or the
> explicit `OPENAI_COMPAT_FALLBACK_*` / `OPENAI_COMPAT_PROVIDERS_JSON`
> variables are configured, `/v1/models` also advertises those external
> provider models. They are explicit opt-in routes, not the implicit default.

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
    "vision": false,
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
  "models": {
    "acceptedSelectors": [
      "default",
      "sonnet",
      "opus",
      "best",
      "fable",
      "haiku",
      "sonnet[1m]",
      "opus[1m]"
    ],
    "available": [
      "claude-sonnet-4-7",
      "openrouter/google/gemini-3-pro"
    ],
    "catalog": [
      {
        "id": "openrouter/google/gemini-3-pro",
        "provider": "openrouter",
        "transport": "openai-compatible",
        "availability": "configured",
        "timeoutMs": 180000,
        "capabilities": {
          "chatCompletions": true,
          "streaming": true,
          "reasoning": false,
          "tools": false,
          "vision": false,
          "structuredOutputs": false
        }
      }
    ]
  },
  "externalProviderAvailability": [
    {
      "provider": "openrouter",
      "availability": {
        "state": "unknown",
        "availableModels": [],
        "unavailableModels": []
      }
    }
  ],
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

When an external provider is configured, the payload also includes its
credential-free configuration under `externalProviders`, live probe state
under `externalProviderAvailability`, and one entry per model under
`models.catalog`. The catalog's `availability` field is authoritative:
`configured` means advertised but not conclusively probed, while `available`
and `unavailable` are per-model probe results. `models.available` is the
backward-compatible merged advertised list. `models.acceptedSelectors`
describes the Claude request aliases the proxy understands; account-gated
selectors can still be rejected by Claude Code. `lastFeatureScan` reports the
most recent background scan when one has completed.

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

- Claude selectors: `sonnet`, `opus`, `best`, `fable`, `haiku`
- account-supported extended-context selectors: `sonnet[1m]`, `opus[1m]`,
  and supported full Claude IDs ending in `[1m]`
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
- stateless provider calls rebuild context from the committed transcript, while
  overlap detection prevents duplication when a client resends prior messages
- a successful external-provider turn clears the incompatible Claude session
  checkpoint as part of the commit; failed or cancelled turns leave the last
  committed checkpoint untouched

The local Gemini CLI provider can advertise multiple model IDs via
`GEMINI_CLI_EXTRA_MODELS`. Legacy API-key fallback variables advertise one
model; `OPENAI_COMPAT_PROVIDERS_JSON` can advertise any number of providers and
models.

### Reasoning controls

The proxy accepts reasoning controls through any of these inputs:

- request body `thinking.budget_tokens`
- request body `thinking.effort`
- request body `reasoning.mode` / `reasoning.effort` / `reasoning.budget_tokens`
- request body `reasoning_effort` (`off`, `low`, `medium`, `high`, `xhigh`, `max`, or a supported alias)
- request body `output_config.effort`
- request header `X-Thinking-Budget` (integer tokens or the same effort labels)
- server default `DEFAULT_THINKING_BUDGET`

`xhigh` maps to an intermediate 48000-token tier when the installed Claude CLI
supports it. On older Claude CLI builds, the proxy falls back to `max`.
Client aliases are normalized as follows: `none` → `off`, `minimal` → `low`,
`auto` → `xhigh`, and `ultracode` → `max`.

For newer Sonnet, Opus, and Fable model lines that use adaptive reasoning, the proxy
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

### Conversation identity, continuity, and idempotency

Set `conversation_id` to give a thread a stable identity. Reusing it resumes
the last successfully committed provider session:

```json
{
  "model": "sonnet",
  "conversation_id": "chat-abc-123",
  "messages": [
    { "role": "user", "content": "Remember the number 17." }
  ]
}
```

```json
{
  "model": "sonnet",
  "conversation_id": "chat-abc-123",
  "messages": [
    { "role": "user", "content": "What number did I ask you to remember?" }
  ]
}
```

The identity precedence is body `conversation_id`,
`metadata.conversation_id`, `X-Conversation-Id`, legacy `user`, an opaque
endpoint-scoped hash of `Idempotency-Key`, then a fresh request ID. Every
accepted request returns `X-Request-Id` and `X-Conversation-Id` response
headers.

For safely retryable non-streaming calls, send `Idempotency-Key`. A completed
retry returns the stored result; a duplicate that is queued or running returns
`409 idempotency_key_in_use`. Reusing a key with different input or a different
`previous_response_id` returns `409 idempotency_key_mismatch`.

### Same-conversation policy

The default policy is `latest-wins`. If a second request arrives for the same
conversation while the first is still in flight, the older request is canceled
and any stale queued work for that conversation is dropped. Set
`CLAUDE_PROXY_SAME_CONVERSATION_POLICY=queue` for FIFO after validation and
scheduler admission, or override a single call with
`"conversation_policy": "interrupt" | "queue"` or `X-Conversation-Policy`.
Independent conversation IDs can run concurrently.
See [CONFIGURATION](./CONFIGURATION.md#same-conversation-policy).

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
| `queue_full` | This conversation already has the maximum number of queued turns. |
| `queue_wait_timeout` | The request expired while waiting to start. |
| `request_superseded` | A newer same-conversation request interrupted this one. |
| `request_cancelled` | The caller canceled the request or disconnected. |
| `idempotency_key_in_use` | That idempotency key already identifies non-terminal work. |
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

The proxy persists each returned response ID as a durable, branchable
checkpoint. Reuse `previous_response_id` to continue it after a restart. By
default, each child gets a new conversation/session head, so two children of
the same response can run concurrently without canceling or contaminating each
other. Supply an explicit `conversation_id` when you intentionally want a
single shared thread instead.

### Notes

- `stream: true` is not supported yet on `/v1/responses`; use `/v1/chat/completions` for streaming.
- `input` accepts plain strings, text items, or message-shaped items with `role` and `content`.
- `agent` accepts a built-in agent id such as `expert-coder`, or you can use the scoped `/v1/agents/:agentId/responses` route.
- Reasoning controls (`thinking`, `reasoning`, `reasoning_effort`, `output_config.effort`) are passed through the same normalization logic used by `/v1/chat/completions`.

---

## `DELETE /v1/requests/:requestId`

Cancel an active or queued request using the `X-Request-Id` returned when it was
accepted:

```bash
curl -X DELETE http://127.0.0.1:3456/v1/requests/REQUEST_ID
```

A found request returns `202` with `status: "cancelling"`. Unknown or already
terminal IDs return `404 request_not_found`. Cancellation never commits partial
assistant output or advances the resumable provider session.

Request IDs are unguessable cancellation capabilities. `/health` deliberately
redacts queued request IDs; the richer Ops snapshot is intended for trusted
local operators.

## Optional Admin API

Admin routes are mounted only when
`CLAUDE_PROXY_ENABLE_ADMIN_API=true`. Without
`CLAUDE_PROXY_ADMIN_TOKEN`, they accept loopback requests only. With a token
configured, every request—including localhost—must send either
`Authorization: Bearer <token>` or `X-Admin-Token: <token>`.

### `GET /admin/thinking-budget`

Returns the active server-wide reasoning default and accepted effort labels:

```json
{
  "budget": "high",
  "allowedLabels": ["off", "low", "medium", "high", "xhigh", "max"]
}
```

`budget` is `null` when no runtime default is active.

### `POST|PUT /admin/thinking-budget`

Set the default with an effort label or positive integer token count:

```bash
curl -X PUT http://127.0.0.1:3456/admin/thinking-budget \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLAUDE_PROXY_ADMIN_TOKEN" \
  -d '{"budget":"high"}'
```

Send `{"budget":null}` to clear the override. Changes are written to
`RUNTIME_STATE_FILE` and survive restarts.

### `POST /admin/features/refresh`

Immediately re-probes Claude and configured external providers, then returns
the completed feature-scan snapshot. Probe failure returns
`503 feature_scan_failed`.

### `POST /admin/conversations/:conversationId/reset`

Discards the resumable provider session for one conversation. Stored transcript
history remains available, and the next turn starts from a fresh provider
session.
