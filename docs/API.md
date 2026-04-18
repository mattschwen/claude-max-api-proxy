# API Reference

`claude-max-api-proxy` exposes three HTTP endpoints on `http://127.0.0.1:3456` (by default). The two OpenAI-compatible endpoints live under `/v1`. The `/health` endpoint is a non-OpenAI operational endpoint.

- [`GET /health`](#get-health)
- [`GET /v1/models`](#get-v1models)
- [`POST /v1/chat/completions`](#post-v1chatcompletions)

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
| `pool.isWarm` | Cold pool means the first few requests will spawn fresh `claude` processes and be slower. |
| `queues` | Long per-conversation queues indicate a stuck request or a client spamming the same conversation key. |
| `stallDetections` | If this increments, the subprocess output stream is going idle mid-response. See [TROUBLESHOOTING](./TROUBLESHOOTING.md). |

---

## `GET /v1/models`

OpenAI-compatible. Returns the list of models the current Claude CLI account can actually use on this machine. The list is computed by probing the stable Claude CLI family aliases (`sonnet`, `opus`, `haiku`) and publishing the exact versioned IDs that the installed CLI resolves at runtime.

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
    }
  ]
}
```

> [!NOTE]
> An empty `data` array is a **real** signal, not a bug. It means your current `claude auth` session cannot access any of the model families the proxy probes. Re-run `claude auth status` and check `/health.models.unavailable` for the specific reason each family failed.

---

## `POST /v1/chat/completions`

OpenAI-compatible chat completion endpoint. Supports streaming (`stream: true`) and non-streaming.

The proxy accepts:

- stable family aliases: `sonnet`, `opus`, `haiku`
- exact versioned IDs returned by `GET /v1/models`
- older/future versioned IDs for those families, which are mapped to the currently available family model on this machine

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

### Extended thinking

Opus models support extended thinking through any of these inputs:

- request body `thinking.budget_tokens`
- request body `reasoning_effort`
- request header `X-Thinking-Budget`
- server default `DEFAULT_THINKING_BUDGET`

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

When any thinking budget source is active, the proxy multiplies the family's hard timeout by 3× to allow for longer reasoning windows.

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
