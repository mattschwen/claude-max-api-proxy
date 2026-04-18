# Security Policy

## Scope

`claude-max-api-proxy` is a **local** HTTP server. By default it binds only to `127.0.0.1:3456` and explicitly does not authenticate clients. Anything that can reach the port can use the local Claude CLI session.

This project's threat model assumes:

- The machine running the proxy is trusted.
- Only trusted processes on that machine can reach `127.0.0.1:3456`.
- If you expose the proxy beyond localhost, **you** are responsible for putting authentication, authorization, and network controls in front of it.

## What counts as a vulnerability

We consider the following in-scope:

- Ways to make the proxy execute arbitrary commands or spawn unintended processes.
- Shell / argument / path injection through any request field or environment variable.
- Ways to exfiltrate local files or env vars through a request.
- Ways to cause the proxy to hand out one user's Claude CLI session to another caller on the same machine.
- Denial-of-service issues that aren't fixable by "stop sending so many requests" (e.g. a single tiny request that ties the server up permanently).
- Crashes, hangs, or state corruption in the subprocess manager that leave orphaned `claude` processes running indefinitely.

We consider the following **out of scope**:

- Anyone on the local machine can talk to `127.0.0.1:3456`. That is the documented design.
- Exposing the proxy to the internet without a reverse proxy in front of it and complaining that it has no auth.
- Vulnerabilities in the underlying `claude` CLI — report those to Anthropic directly.
- Vulnerabilities in Node.js, Express, or other dependencies — report those upstream.

## Reporting

**Please do not file public GitHub issues for security vulnerabilities.**

Preferred reporting path:

- Use GitHub's private vulnerability reporting or the repository Security tab if private reporting is enabled.
- If private reporting is not enabled, contact the repository owner privately through GitHub instead of opening a public issue.

Include:

- A clear description of the vulnerability.
- Steps to reproduce, ideally including a minimal proof-of-concept.
- Your assessment of impact and which threat-model assumptions it breaks.
- Any suggested mitigation.

We aim to acknowledge reports within a few days and will coordinate a fix + disclosure timeline with you.

## Supported versions

This project is under active development. Security fixes will be applied to the latest `main` only. There are no backported patch branches.
