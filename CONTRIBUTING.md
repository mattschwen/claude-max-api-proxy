# Contributing to `claude-max-api-proxy`

Thanks for taking the time to contribute. This project is small, focused, and intentionally conservative — contributions that fit that posture are the easiest to review and merge.

## Before you start

1. **Open an issue first** for anything non-trivial. A 30-second "hey, I'm thinking of doing X, does that sound reasonable?" avoids hours of wasted work if the answer is "that doesn't fit the project's scope".
2. **Typo / doc fixes** — just open the PR.
3. **Bug fixes** — include a minimal reproduction in the PR description.
4. **New features** — open an issue first.

## Development setup

```bash
git clone https://github.com/mattschwen/claude-max-api-proxy.git
cd claude-max-api-proxy
npm install
npm run build     # tsc → dist/
npm test          # runs compiled tests under dist/
```

You'll also need:

- **Node.js 22+**
- **npm**
- **[Claude Code CLI](https://github.com/anthropics/claude-code)** installed globally and authenticated (`claude auth login`)
- An active Claude account with access to at least one Claude model

## Running locally

```bash
# Foreground
npm start

# Or with debug queue logging
CLAUDE_PROXY_DEBUG_QUEUES=true npm start

# Hot-rebuild during development
npm run dev       # tsc --watch
```

The server binds to `http://127.0.0.1:3456`.

## Making changes

1. Create a feature branch off `main`:
   ```bash
   git checkout -b fix/descriptive-name
   ```
2. Make your changes in `src/`. `dist/` is a build artifact — don't hand-edit it.
3. Build: `npm run build`
4. Run tests: `npm test`
5. Exercise the change manually with `curl` against a running server (see examples in [`docs/API.md`](./docs/API.md)).
6. Commit with a descriptive message (see [commit messages](#commit-messages)).
7. Push and open a PR.

## Code style

- **TypeScript, strict mode.** No `any` escape hatches.
- **`spawn()`, never `exec()`.** Shell execution is a security boundary we don't cross.
- **Timeouts live in routes**, not in the subprocess manager. The route handler is the single owner of all timeout behavior — see `src/subprocess/manager.ts` comment about `Phase 1c`.
- **Every subprocess must register with the global `SubprocessRegistry`** so graceful shutdown can kill them all.
- **Structured logs via `log()`** from `src/logger.ts` — one JSON object per event. No `console.log` sprinkles.
- **Small, focused functions.** Add a JSDoc comment on anything exported.
- **Preserve existing tests.** If you change behavior, update the relevant test.

## Commit messages

Prefer the conventional-commits style:

```
fix(subprocess): bypass third-party classifier by embedding system prompt
feat(health): expose pool.warmedAt in /health payload
docs(readme): split API reference into docs/API.md
chore(gitignore): add common OSS ignores
```

Type prefixes we use: `fix`, `feat`, `docs`, `chore`, `refactor`, `test`, `perf`.

Body should explain **why** the change is needed (root cause, symptoms, what the fix does) — not just *what* the diff shows. The diff already shows the *what*.

## Testing

Tests run from the compiled `dist/` output:

```bash
npm test
```

If you're adding a new feature, add a test alongside it (`foo.test.ts` next to `foo.ts`). The test runner picks up `dist/**/*.test.js` automatically after `npm run build`.

For integration-style testing, run the full server and exercise it with `curl`:

```bash
npm start   # in one terminal

# in another
curl http://127.0.0.1:3456/health
curl http://127.0.0.1:3456/v1/models

curl -N http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## Reporting bugs

Please include:

- Node.js version (`node --version`)
- Claude CLI version (`claude --version`)
- Operating system and version
- Exact reproduction steps
- Full error messages, including stack traces
- Relevant log excerpts (filter for your `conversationId` — see [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md#log-diving))
- `/health` payload at time of the bug (redact email / org name if you prefer)

## Security issues

**Do not file public issues for security vulnerabilities.** See [SECURITY.md](./SECURITY.md) for the private reporting process.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
