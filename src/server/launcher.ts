import type { Request, Response } from "express";
import { collectOpsDashboardSnapshot } from "./ops-snapshot.js";

const OPEN_WEBUI_PORT = Number.parseInt(
  process.env.OPEN_WEBUI_PORT || "8080",
  10,
);

interface ProjectLinks {
  commandDeck: string;
  launchDeck: string;
  dashboardAlias: string;
  snapshot: string;
  metricsText: string;
  metricsJson: string;
  health: string;
  models: string;
  capabilities: string;
  chatCompletions: string;
  openWebUi: string;
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function getRequestOrigin(req: Request): URL {
  const forwardedProto =
    req.header("x-forwarded-proto")?.split(",")[0].trim() || req.protocol;
  const forwardedHost =
    req.header("x-forwarded-host")?.split(",")[0].trim() ||
    req.header("host") ||
    "127.0.0.1:3456";
  return new URL(`${forwardedProto}://${forwardedHost}`);
}

function buildInternalUrl(req: Request, pathname: string, search = ""): string {
  const url = getRequestOrigin(req);
  url.pathname = pathname;
  url.search = search;
  url.hash = "";
  return url.toString();
}

function buildExternalUrl(req: Request, port: number, pathname = "/"): string {
  const url = getRequestOrigin(req);
  url.port = String(port);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildProjectLinks(req: Request): ProjectLinks {
  return {
    commandDeck: buildInternalUrl(req, "/ops"),
    launchDeck: buildInternalUrl(req, "/launch"),
    dashboardAlias: buildInternalUrl(req, "/ops"),
    snapshot: buildInternalUrl(req, "/ops/snapshot"),
    metricsText: buildInternalUrl(req, "/metrics"),
    metricsJson: buildInternalUrl(req, "/metrics", "?format=json"),
    health: buildInternalUrl(req, "/health"),
    models: buildInternalUrl(req, "/v1/models"),
    capabilities: buildInternalUrl(req, "/v1/capabilities"),
    chatCompletions: buildInternalUrl(req, "/v1/chat/completions"),
    openWebUi: buildExternalUrl(req, OPEN_WEBUI_PORT, "/"),
  };
}

function renderLauncherPage(snapshotJson: string, linksJson: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover"
    />
    <title>Claw Observatory</title>
    <link rel="stylesheet" href="/assets/design-tokens.css" />
    <link rel="stylesheet" href="/assets/launcher.css?v=20260420b" />
  </head>
  <body class="launch-body">
    <main class="launch-shell">
      <header class="hero panel panel--hero" data-tone="hero">
        <div class="hero-main">
          <span class="eyebrow">Proxy Launch Deck</span>
          <h1>Claw Observatory</h1>
          <p class="hero-copy">
            Test the real proxy path from a browser client into
            <code>/v1/chat/completions</code>, watch the same live telemetry that
            powers the command deck, and jump into the full operator surfaces
            without losing the machine-room context.
          </p>
          <div class="hero-actions">
            <a class="button button--primary" href="#" id="labCta">
              <span>Open Chat Lab</span>
              <span>API</span>
            </a>
            <a class="button" href="#" id="dashboardCta">
              <span>Open Command Deck</span>
              <span>/ops</span>
            </a>
            <a class="button" href="#" id="webUiCta">
              <span>Open WebUI</span>
              <span>8080</span>
            </a>
            <a class="button" href="#" id="snapshotCta">
              <span>Open Snapshot</span>
              <span>JSON</span>
            </a>
          </div>
        </div>

        <div class="hero-side">
          <div class="signal-grid">
            <article class="signal-card" data-tone="cyan">
              <span class="signal-label">Active</span>
              <strong id="metricActiveRequests">0</strong>
              <small id="metricActiveRequestsNote">runtime lanes</small>
            </article>
            <article class="signal-card" data-tone="pink">
              <span class="signal-label">Queued</span>
              <strong id="metricQueuedRequests">0</strong>
              <small id="metricQueuedRequestsNote">back pressure</small>
            </article>
            <article class="signal-card" data-tone="violet">
              <span class="signal-label">Sessions</span>
              <strong id="metricSessions">0</strong>
              <small id="metricSessionsNote">resume spine</small>
            </article>
            <article class="signal-card" data-tone="lime">
              <span class="signal-label">Workers</span>
              <strong id="metricSubprocesses">0</strong>
              <small id="metricSubprocessesNote">Claude subprocesses</small>
            </article>
          </div>

          <article class="panel hero-summary" data-tone="amber">
            <div class="hero-summary-head">
              <span class="signal-label">Runtime</span>
              <span class="status-pill" id="stackMode">Syncing</span>
            </div>
            <strong id="heroSummary">Waiting for snapshot</strong>
            <p id="runtimeStamp">No live probe yet.</p>
            <div class="meta-stack">
              <div class="meta-row">
                <span>Command deck</span>
                <strong id="dashboardUrl"></strong>
              </div>
              <div class="meta-row">
                <span>Chat endpoint</span>
                <strong id="chatCompletionsUrl"></strong>
              </div>
              <div class="meta-row">
                <span>Open WebUI</span>
                <strong id="webUiUrl"></strong>
              </div>
              <div class="meta-row">
                <span>Metrics JSON</span>
                <strong id="metricsJsonUrl"></strong>
              </div>
            </div>
          </article>
        </div>
      </header>

      <section class="station-grid">
        <article class="panel station-card" data-tone="cyan">
          <span class="eyebrow">Ops</span>
          <h2>Command Deck</h2>
          <p>
            Topology, Grafana-style traces, live lanes, drill-down logs, and
            recent conversation forensics.
          </p>
          <div class="card-links">
            <a class="mini-link" href="#" id="dashboardLink">Launch</a>
            <small id="dashboardAliasUrl"></small>
          </div>
        </article>

        <article class="panel station-card" data-tone="violet">
          <span class="eyebrow">Built In</span>
          <h2>Chat Lab</h2>
          <p>
            Browser-side client that hits the same proxy API your tools use.
            Reuse a conversation id, switch models, and inspect raw responses.
          </p>
          <div class="card-links">
            <a class="mini-link" href="#chatLab">Jump In</a>
            <small id="labEndpointSummary"></small>
          </div>
        </article>

        <article class="panel station-card" data-tone="pink">
          <span class="eyebrow">External</span>
          <h2>Open WebUI</h2>
          <p>
            Full chat UI for longer sessions. This launcher stays focused on
            proxy validation and operator control.
          </p>
          <div class="card-links">
            <a class="mini-link" href="#" id="webUiLink">Launch</a>
            <small>Browser chat surface</small>
          </div>
        </article>

        <article class="panel station-card" data-tone="amber">
          <span class="eyebrow">Telemetry</span>
          <h2>Raw Feeds</h2>
          <p>
            Metrics, health, capabilities, and snapshot endpoints for scripts,
            scraping, or direct forensic inspection.
          </p>
          <div class="card-links card-links--grid">
            <a class="mini-link" href="#" id="metricsJsonLink">Metrics JSON</a>
            <a class="mini-link" href="#" id="healthLink">Health</a>
            <a class="mini-link" href="#" id="snapshotLink">Snapshot</a>
            <a class="mini-link" href="#" id="modelsLink">Models</a>
          </div>
        </article>
      </section>

      <section class="lab-grid" id="chatLab">
        <article class="panel lab-panel" data-tone="violet">
          <div class="section-head">
            <div>
              <span class="eyebrow">Chat Lab</span>
              <h2>API to Proxy to CLI</h2>
            </div>
            <span class="status-pill" id="labStatusPill">Ready</span>
          </div>
          <p class="section-copy">
            This sends a real OpenAI-compatible request through the proxy. Reuse
            a conversation id to exercise queueing and session behavior.
          </p>

          <div class="lab-controls">
            <label class="field">
              <span>Model</span>
              <select id="labModelSelect"></select>
            </label>

            <label class="field">
              <span>Custom model</span>
              <input
                id="labModelInput"
                type="text"
                placeholder="Override with exact model id"
                autocomplete="off"
              />
            </label>

            <label class="field">
              <span>Conversation id</span>
              <input
                id="labConversationInput"
                type="text"
                placeholder="lab conversation"
                autocomplete="off"
              />
            </label>
          </div>

          <label class="field field--stacked">
            <span>System prompt</span>
            <textarea
              id="labSystemInput"
              rows="3"
              placeholder="Optional system prompt for test runs"
            ></textarea>
          </label>

          <div class="transcript-panel">
            <div class="transcript-head">
              <strong>Transcript</strong>
              <div class="transcript-meta">
                <span class="meta-badge" id="labConversationBadge">new chat</span>
                <span class="meta-badge" id="labModelBadge">model pending</span>
              </div>
            </div>
            <div class="transcript-list" id="labTranscript">
              <div class="empty-state">No messages yet. Send a prompt to test the proxy.</div>
            </div>
          </div>

          <label class="field field--stacked">
            <span>Prompt</span>
            <textarea
              id="labPromptInput"
              rows="5"
              placeholder="Describe a request to send through the proxy"
            ></textarea>
          </label>

          <div class="composer-row">
            <label class="toggle">
              <input id="labStreamToggle" type="checkbox" checked />
              <span>stream response</span>
            </label>
            <div class="composer-actions">
              <button class="button button--primary" id="labSendButton" type="button">
                <span>Send Through Proxy</span>
                <span>POST</span>
              </button>
              <button class="button" id="labStopButton" type="button">
                <span>Stop</span>
                <span>Abort</span>
              </button>
              <button class="button" id="labResetButton" type="button">
                <span>Reset</span>
                <span>New Chat</span>
              </button>
            </div>
          </div>
        </article>

        <div class="lab-side">
          <article class="panel inspector-panel" data-tone="cyan">
            <div class="section-head">
              <div>
                <span class="eyebrow">Inspector</span>
                <h2>Last Request</h2>
              </div>
              <span class="meta-badge" id="labLatencyBadge">idle</span>
            </div>
            <div class="inspector-grid">
              <div class="inspector-item">
                <span>Endpoint</span>
                <strong id="labEndpointValue">/v1/chat/completions</strong>
              </div>
              <div class="inspector-item">
                <span>Response model</span>
                <strong id="labResponseModel">pending</strong>
              </div>
              <div class="inspector-item">
                <span>Status</span>
                <strong id="labResponseStatus">ready</strong>
              </div>
              <div class="inspector-item">
                <span>Conversation</span>
                <strong id="labResponseConversation">new</strong>
              </div>
            </div>
            <pre class="code-block" id="labRequestPreview">{
  "model": "default",
  "messages": []
}</pre>
          </article>

          <article class="panel inspector-panel" data-tone="pink">
            <div class="section-head">
              <div>
                <span class="eyebrow">Raw Output</span>
                <h2>Response Payload</h2>
              </div>
            </div>
            <pre class="code-block" id="labRawOutput">No response yet.</pre>
          </article>
        </div>
      </section>

      <section class="live-grid">
        <article class="panel live-card" data-tone="cyan">
          <div class="section-head">
            <div>
              <span class="eyebrow">Chats</span>
              <h2>Recent Threads</h2>
            </div>
            <span class="meta-badge" id="runtimeRefreshStamp">syncing</span>
          </div>
          <div class="stack-list" id="conversationList"></div>
        </article>

        <article class="panel live-card" data-tone="lime">
          <div class="section-head">
            <div>
              <span class="eyebrow">Sessions</span>
              <h2>Resume Spine</h2>
            </div>
            <span class="meta-badge" id="sessionCountBadge">0</span>
          </div>
          <div class="stack-list" id="sessionList"></div>
        </article>

        <article class="panel live-card" data-tone="violet">
          <div class="section-head">
            <div>
              <span class="eyebrow">Logs</span>
              <h2>Event Tail</h2>
            </div>
            <span class="meta-badge" id="logCountBadge">0</span>
          </div>
          <div class="log-list" id="logList"></div>
        </article>
      </section>

      <footer class="launch-footer">
        <span>Launcher <code>/launch</code> · Deck <code>/ops</code> · Chat API <code>/v1/chat/completions</code></span>
        <span id="footerSummary">Awaiting runtime state…</span>
      </footer>
    </main>

    <script type="application/json" id="launchLinks">${linksJson}</script>
    <script type="application/json" id="launchSnapshot">${snapshotJson}</script>
    <script type="module" src="/assets/launcher.js?v=20260420b"></script>
  </body>
</html>`;
}

export async function handleLauncher(
  req: Request,
  res: Response,
): Promise<void> {
  const snapshot = await collectOpsDashboardSnapshot({
    logLimit: 16,
    conversationLimit: 10,
  });
  const links = buildProjectLinks(req);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    renderLauncherPage(
      serializeForInlineScript(snapshot),
      serializeForInlineScript(links),
    ),
  );
}
