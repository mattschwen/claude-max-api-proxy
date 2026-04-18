# Contributing to `claude-max-api-proxy`

Thanks for taking the time to contribute. This is a small, focused open source project, and the easiest changes to review are the ones that stay aligned with that scope.

## Before you start

1. **Use the issue templates** for bugs and feature requests so reports include the minimum context needed to reproduce or evaluate the change.
2. **Open an issue first** for anything non-trivial. A 30-second "hey, I'm thinking of doing X, does that sound reasonable?" avoids hours of wasted work if the answer is "that doesn't fit the project's scope".
3. **Read the code of conduct** before participating in issues or PR discussions: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
4. **Typo / doc fixes** — just open the PR.
5. **Bug fixes** — include a minimal reproduction in the PR description.
6. **New features** — open an issue first.

## Development setup

```bash
git clone https://github.com/mattschwen/claude-max-api-proxy.git
cd claude-max-api-proxy
npm install
npm run ci        # build + test
```

You'll also need:

- **Node.js 22+**
- **npm**
- **[Claude Code CLI](https://github.com/anthropics/claude-code)** installed globally and authenticated (`claude auth login`)
- An active Claude account with access to at least one Claude model

## Running locally

```bash
# Build once in a fresh clone
npm run build

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
3. Run the local check suite: `npm run ci`
4. Exercise the change manually with `curl` against a running server when behavior changes (see examples in [`API.md`](./API.md)).
5. If you change setup, configuration, or deployment behavior, update the affected docs in the same PR (`README.md`, `docs/*`, `.env.example`, and any GitHub templates/workflows).
6. Commit with a descriptive message (see [commit messages](#commit-messages)).
7. Push and open a PR. GitHub Actions runs the same build-and-test checks on pushes and pull requests.

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
npm run ci
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
  -d '{"model":"sonnet","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## Reporting bugs

Please include:

- Node.js version (`node --version`)
- Claude CLI version (`claude --version`)
- Operating system and version
- Exact reproduction steps
- Full error messages, including stack traces
- Relevant log excerpts (filter for your `conversationId` — see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#log-diving))
- `/health` payload at time of the bug (redact email / org name if you prefer)

## Security issues

**Do not file public issues for security vulnerabilities.** See [SECURITY.md](./SECURITY.md) for the private reporting process.

## Community standards

Participation in this project is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](../LICENSE).
