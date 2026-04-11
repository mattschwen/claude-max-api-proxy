# Troubleshooting

Every failure mode we've actually seen, with the fix.

## Startup failures

### `claude: command not found`

The Claude Code CLI isn't installed or isn't on `PATH`.

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

If it's installed but the proxy can't see it — most commonly when running under a LaunchAgent — make sure the plist's `EnvironmentVariables.PATH` includes the directory where `claude` lives (`which claude` on a normal shell will tell you).

### `claude auth status` says not logged in

```bash
claude auth login
claude auth status
```

The proxy runs `claude auth status` at startup and refuses to report a healthy `/health.auth.loggedIn: true` until this passes.

### Startup hangs for 20+ seconds

That's normal. The proxy runs synchronous `verifyClaude`, `verifyAuth`, and per-model probes before binding `:3456`. Total cold-start is typically **15–25 seconds**. If you need to test the server is starting, tail the stdout log — you'll see the sequence.

If it's much longer than 25 seconds, check whether `claude auth status` hangs on its own from a normal shell. The proxy can't be faster than the CLI it wraps.

---

## `/v1/models` is empty

This is the single most common failure mode and it looks like a lot of different symptoms (clients report "no models", chat requests return `no_models_available`, `/health` shows an empty `models.available` array).

It means **one** of these things:

1. Claude CLI is not authenticated.
2. The authenticated CLI account can't access any of the model IDs the proxy knows about.
3. The startup model probes all timed out at 15 s.

### Check auth

```bash
claude auth status
```

If `loggedIn: false`, fix with `claude auth login`.

### Check per-model probe results

```bash
curl -s http://127.0.0.1:3456/health | python3 -m json.tool | less
```

Look at `models.unavailable`. Each entry has an `id`, a `code`, and a `message`. Common codes:

| Code | Meaning |
| --- | --- |
| `model_unavailable` | The CLI explicitly said the account has no access. Expected for model IDs you don't have entitlement to. |
| `auth_required` | The probe hit an auth error. Re-run `claude auth login`. |
| `claude_cli_error` with `code: 143` | The probe was killed by SIGTERM — it timed out at 15 s. See below. |

### Cold-CLI probe timeout (the 143 case)

If the proxy starts on a completely cold CLI, the first `claude --print` invocations can take longer than the 15 s probe timeout because they have to warm up an auth handshake. When that happens, the probes get SIGTERM'd and every model shows up as unavailable even though the underlying CLI actually works.

**Fix:** restart the proxy once more. The second startup runs against a warm CLI and the probes succeed.

```bash
# macOS LaunchAgent
launchctl kickstart -k gui/$(id -u)/com.claude-code-provider

# Foreground
# Just Ctrl-C and re-run `npm start`
```

If this happens every time you start the proxy, your `claude` CLI installation is genuinely slow to warm. Run `claude --print --model claude-sonnet-4-6 "hi"` once manually from a normal shell to measure.

---

## Chat request failures

### `400 model_unavailable`

The client asked for a model ID that the proxy didn't list in `/v1/models`. Two things to check:

1. `curl http://127.0.0.1:3456/v1/models` — what IDs are actually available?
2. Does your client's configured model ID exactly match one of them? The proxy does accept a few aliases (`opus`, `sonnet`, `haiku`, `maxproxy/...`, `claude-code-cli/...`) but exact IDs are safest.

### `400 "Third-party apps now draw from your extra usage, not your plan limits."`

Anthropic's server-side classifier decided the request is coming from a third-party app and is refusing to bill it against your Claude Max plan. This usually happens when a client sends a large agent-framework system prompt.

The proxy has a workaround: it embeds the client's system prompt in the user message wrapped in `<instructions>...</instructions>` tags rather than passing it via `--system-prompt`. This preserves Claude CLI's default first-party system prompt, which is the sentinel Anthropic's classifier keys on.

If you're seeing this error anyway, make sure you're running a build that includes the fix (the workaround lives in `src/subprocess/manager.ts` under the `Workaround for Anthropic's third-party-apps classifier` comment).

### `429 rate_limited`

Claude returned a rate-limit or budget error. Back off and retry. If it persists, check your Claude Max plan usage.

### `502 claude_cli_error`

Catch-all for subprocess failures. Check `/health.recentErrors` and the stdout log for the full `subprocess.close` event — the `code` field will show why the process died (non-zero exit, SIGTERM, SIGKILL).

---

## Streaming looks idle or cut off

### Silent mid-stream (stall)

The proxy has an activity-based stall timer. If the `claude` subprocess stops producing output for longer than the family's stall timeout, it's killed.

| Family | Stall timeout |
| --- | --- |
| Opus | 120 s |
| Sonnet | 90 s |
| Haiku | 45 s |

Watch for `subprocess.stall` and `subprocess.kill` events in the log. If you're hitting stalls consistently on Sonnet, either the upstream response is genuinely slow or Anthropic is having a bad day.

### Stream cuts off immediately when client disconnects

Intentional. When the HTTP client closes the SSE connection, the proxy immediately kills the underlying subprocess so the conversation queue can unblock. If you want the request to finish even after disconnect, don't close the stream.

---

## Same-conversation weirdness

### "Sending a second message stops the first"

Expected under the default `latest-wins` policy. The proxy treats the OpenAI `user` field as a conversation key. A new request for the same `user` cancels the in-flight one.

Switch to strict FIFO if that's what you want:

```bash
export CLAUDE_PROXY_SAME_CONVERSATION_POLICY=queue
npm start
```

### "Two unrelated threads are stomping each other"

Check whether your client is accidentally reusing the same `user` value across threads. The proxy has no way to know they're unrelated. Either:

- Make the client send unique `user` values per thread, or
- Omit `user` entirely, and the proxy will assign an internal request ID per request (no continuity, no cross-thread stomping).

### "Resume is failing repeatedly for one conversation"

After two consecutive resume failures for a conversation, the proxy invalidates the session and creates a fresh one on the next request. You'll see `session.resume_fail` events followed by a `session.invalidate` event in the log. If a specific conversation is broken, just send another message — the next one will start fresh.

---

## Port in use

```bash
# Start on another port
node dist/server/standalone.js 8080
```

Then point your clients at `http://127.0.0.1:8080/v1`. Or find what's holding `:3456`:

```bash
lsof -iTCP:3456 -sTCP:LISTEN
```

---

## Log diving

The proxy emits one JSON object per line to stdout. To filter for a specific event:

```bash
# Every request completion
tail -f /tmp/claude-provider.log | grep '"event":"request.complete"'

# Every stall
tail -f /tmp/claude-provider.log | grep '"event":"subprocess.stall"'

# Everything for one conversation
tail -f /tmp/claude-provider.log | grep '"conversationId":"chat-abc-123"'
```

If you're running under `launchd` on macOS, logs go to `/tmp/claude-provider.log` and `/tmp/claude-provider.err.log` per the LaunchAgent config in [macos-setup.md](./macos-setup.md).
