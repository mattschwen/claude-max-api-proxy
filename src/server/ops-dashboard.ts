import type { Request, Response } from "express";
import { opsLogBuffer } from "./ops-log-buffer.js";
import {
  collectOpsConversationSnapshot,
  collectOpsDashboardSnapshot,
} from "./ops-snapshot.js";

const STREAM_SNAPSHOT_INTERVAL_MS = 1000;
const STREAM_KEEPALIVE_MS = 15000;

function renderOpsDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover"
    />
    <title>Claw Proxy | Command Spine</title>
    <link rel="stylesheet" href="/assets/design-tokens.css" />
    <link rel="stylesheet" href="/assets/ops-dashboard.css?v=20260420f" />
  </head>
  <body class="ops-body" data-connected="false">
    <main class="ops-shell">
      <header class="panel topbar" data-tone="pink">
        <div class="topbar-brand">
          <img class="brand-mark" src="/assets/logo.svg" alt="" />
          <div class="brand-copy">
            <span class="kicker">Claw Proxy</span>
            <h1>Command Spine</h1>
          </div>
        </div>

        <div class="topbar-strip">
          <div class="status-chip" id="connectionChip">
            <span class="status-dot"></span>
            <strong id="connectionLabel">Link down</strong>
          </div>
          <div class="mini-stat">
            <span>Route</span>
            <strong id="routeSummary">Booting</strong>
          </div>
          <div class="mini-stat">
            <span>Active</span>
            <strong id="activeSummary">0</strong>
          </div>
          <div class="mini-stat">
            <span>Queued</span>
            <strong id="queueSummary">0</strong>
          </div>
          <div class="mini-stat">
            <span>Errors</span>
            <strong id="errorSummary">0</strong>
          </div>
          <div class="mini-stat">
            <span>RSS</span>
            <strong id="memorySummary">0 MB</strong>
          </div>
          <div class="mini-stat">
            <span>Snapshot</span>
            <strong id="snapshotAge">—</strong>
          </div>
          <div class="mini-stat">
            <span>Local</span>
            <strong id="clockValue">--:--:--</strong>
          </div>
        </div>

        <div class="topbar-actions">
          <a class="shell-link shell-link--primary" href="/launch#chatLab">
            <span>Test Lab</span>
            <strong>API to Proxy to CLI</strong>
          </a>
          <a
            class="shell-link"
            href="/ops/snapshot?conversationLimit=12&logLimit=24"
          >
            <span>Snapshot</span>
            <strong>JSON Probe</strong>
          </a>
        </div>
      </header>

      <section class="panel topology-panel" data-tone="cyan">
        <div class="section-head">
          <div>
            <span class="kicker">Flow Map</span>
            <h2>Live route</h2>
          </div>
          <div class="section-head-meta">
            <span class="head-chip" id="systemMode">Booting</span>
            <span class="head-chip" id="providerMode">Providers</span>
          </div>
        </div>

        <div class="topology-layout">
          <div class="flow-map">
            <article class="flow-node" id="nodeClients">
              <span class="node-label">Clients</span>
              <strong class="node-value" id="nodeClientsValue">0 req/s</strong>
              <small class="node-meta" id="nodeClientsMeta">No ingress</small>
            </article>
            <div class="flow-pipe" id="pipeClients">
              <span class="pipe-label" id="pipeClientsLabel">0 req/s</span>
            </div>

            <article class="flow-node" id="nodeIngress">
              <span class="node-label">Proxy</span>
              <strong class="node-value" id="nodeIngressValue">0 live</strong>
              <small class="node-meta" id="nodeIngressMeta">HTTP quiet</small>
            </article>
            <div class="flow-pipe" id="pipeIngress">
              <span class="pipe-label" id="pipeIngressLabel">0 queued</span>
            </div>

            <article class="flow-node" id="nodeQueue">
              <span class="node-label">Queue</span>
              <strong class="node-value" id="nodeQueueValue">0 waiting</strong>
              <small class="node-meta" id="nodeQueueMeta">Clear</small>
            </article>
            <div class="flow-pipe" id="pipeQueue">
              <span class="pipe-label" id="pipeQueueLabel">0 running</span>
            </div>

            <article class="flow-node" id="nodeRuntime">
              <span class="node-label">Runtime</span>
              <strong class="node-value" id="nodeRuntimeValue">0 workers</strong>
              <small class="node-meta" id="nodeRuntimeMeta">Idle</small>
            </article>
            <div class="flow-pipe" id="pipeRuntime">
              <span class="pipe-label" id="pipeRuntimeLabel">No route</span>
            </div>

            <article class="flow-node flow-node--providers" id="nodeProviders">
              <span class="node-label">Providers</span>
              <strong class="node-value" id="nodeProvidersValue">0 ready</strong>
              <small class="node-meta" id="nodeProvidersMeta">No route</small>
              <div class="provider-stack" id="providerStack">
                <div class="provider-row provider-row--empty">No providers</div>
              </div>
            </article>
          </div>

          <aside class="state-rail">
            <div class="state-block">
              <div class="rail-head">
                <strong>Signals</strong>
                <span id="signalSummary">0 alarms</span>
              </div>
              <div class="state-stack" id="stateStack">
                <div class="empty-inline">No snapshot</div>
              </div>
            </div>

            <div class="state-block">
              <div class="rail-head">
                <strong>Alerts</strong>
                <span id="alertSummary">Quiet</span>
              </div>
              <div class="alert-stack" id="alertStack">
                <div class="empty-inline">No active alerts</div>
              </div>
            </div>
          </aside>
        </div>

        <div class="lane-section">
          <div class="rail-head">
            <strong>Live lanes</strong>
            <span id="laneSummary">0 active</span>
          </div>
          <div class="lane-list" id="laneList">
            <div class="empty-inline">No active or queued chats</div>
          </div>
        </div>
      </section>

      <section class="chart-grid">
        <article class="panel chart-panel" data-tone="cyan">
          <div class="chart-head">
            <div>
              <span class="kicker">Flow</span>
              <h3>Requests</h3>
            </div>
            <strong class="chart-current" id="flowCurrent">0.00 req/s</strong>
          </div>
          <div class="chart-legend" id="flowLegend"></div>
          <svg class="chart-svg" id="flowChart" viewBox="0 0 640 180" aria-label="Flow chart"></svg>
        </article>

        <article class="panel chart-panel" data-tone="pink">
          <div class="chart-head">
            <div>
              <span class="kicker">Latency</span>
              <h3>Response time</h3>
            </div>
            <strong class="chart-current" id="latencyCurrent">—</strong>
          </div>
          <div class="chart-legend" id="latencyLegend"></div>
          <svg class="chart-svg" id="latencyChart" viewBox="0 0 640 180" aria-label="Latency chart"></svg>
        </article>

        <article class="panel chart-panel" data-tone="amber">
          <div class="chart-head">
            <div>
              <span class="kicker">Pressure</span>
              <h3>Queue + workers</h3>
            </div>
            <strong class="chart-current" id="pressureCurrent">0 / 0</strong>
          </div>
          <div class="chart-legend" id="pressureLegend"></div>
          <svg class="chart-svg" id="pressureChart" viewBox="0 0 640 180" aria-label="Pressure chart"></svg>
        </article>

        <article class="panel chart-panel" data-tone="violet">
          <div class="chart-head">
            <div>
              <span class="kicker">Load</span>
              <h3>Process</h3>
            </div>
            <strong class="chart-current" id="loadCurrent">0% / 0 MB</strong>
          </div>
          <div class="chart-legend" id="loadLegend"></div>
          <svg class="chart-svg" id="loadChart" viewBox="0 0 640 180" aria-label="Process chart"></svg>
        </article>
      </section>

      <section class="lower-grid">
        <section class="panel conversations-panel" data-tone="lime">
          <div class="section-head">
            <div>
              <span class="kicker">Chats</span>
              <h2>Recent traffic</h2>
            </div>
            <div class="section-head-meta">
              <span class="head-chip" id="conversationCounts">0 tracked</span>
            </div>
          </div>

          <div class="conversations-shell">
            <div class="conversation-list" id="conversationList">
              <div class="empty-inline">No chats</div>
            </div>

            <div class="conversation-detail">
              <div class="detail-head">
                <div>
                  <span class="kicker">Inspect</span>
                  <h3 id="detailTitle">Select a chat</h3>
                </div>
                <div class="detail-chip-row">
                  <span class="detail-chip" id="detailRoute">—</span>
                  <span class="detail-chip" id="detailTimer">—</span>
                </div>
              </div>

              <div class="detail-meta" id="detailMeta">
                <div class="empty-inline">No chat selected</div>
              </div>

              <div class="transcript" id="conversationDetail">
                <div class="empty-inline">Select a row to inspect transcript and runtime context</div>
              </div>
            </div>
          </div>
        </section>

        <section class="panel logs-panel" data-tone="violet">
          <div class="section-head">
            <div>
              <span class="kicker">Tail</span>
              <h2>Event stream</h2>
            </div>
            <div class="section-head-meta">
              <button class="toolbar-button is-active" id="followLogsButton" type="button">Follow</button>
              <button class="toolbar-button" id="pauseLogsButton" type="button">Pause</button>
            </div>
          </div>

          <div class="log-controls">
            <select id="logEventFilter" aria-label="Filter event class">
              <option value="all">All</option>
              <option value="request.">Request</option>
              <option value="queue.">Queue</option>
              <option value="subprocess.">Subprocess</option>
              <option value="session.">Session</option>
              <option value="auth.">Auth</option>
              <option value="pool.">Pool</option>
              <option value="cli.">CLI</option>
            </select>
            <input
              type="search"
              id="logSearch"
              placeholder="Search event, reason, model"
              autocomplete="off"
            />
          </div>

          <div class="log-stream" id="logStream">
            <div class="empty-inline">No logs</div>
          </div>
        </section>
      </section>
    </main>

    <script type="module" src="/assets/ops-dashboard.js?v=20260420f"></script>
  </body>
</html>`;
}

function sendSseEvent(
  res: Response,
  event: string,
  payload: unknown,
): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function handleOpsDashboard(_req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderOpsDashboardPage());
}

export async function handleOpsSnapshot(
  req: Request,
  res: Response,
): Promise<void> {
  const logLimitRaw = Number.parseInt(String(req.query.logLimit ?? "180"), 10);
  const conversationLimitRaw = Number.parseInt(
    String(req.query.conversationLimit ?? "24"),
    10,
  );
  const logLimit = Number.isFinite(logLimitRaw)
    ? Math.max(0, Math.min(500, logLimitRaw))
    : 180;
  const conversationLimit = Number.isFinite(conversationLimitRaw)
    ? Math.max(1, Math.min(64, conversationLimitRaw))
    : 24;

  res.json(
    await collectOpsDashboardSnapshot({
      logLimit,
      conversationLimit,
    }),
  );
}

export function handleOpsConversation(
  req: Request,
  res: Response,
): void {
  const limitRaw = Number.parseInt(String(req.query.limit ?? "24"), 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(64, limitRaw))
    : 24;
  const conversationId =
    typeof req.params.conversationId === "string"
      ? req.params.conversationId
      : Array.isArray(req.params.conversationId)
        ? req.params.conversationId[0]
        : "";
  res.json(
    collectOpsConversationSnapshot(conversationId, limit),
  );
}

export async function handleOpsStream(
  _req: Request,
  res: Response,
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 2000\n\n");

  let snapshotBusy = false;

  const pushSnapshot = async (): Promise<void> => {
    if (snapshotBusy || res.writableEnded) return;
    snapshotBusy = true;
    try {
      sendSseEvent(
        res,
        "snapshot",
        await collectOpsDashboardSnapshot({ logLimit: 0 }),
      );
    } catch (error) {
      sendSseEvent(res, "error", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      snapshotBusy = false;
    }
  };

  sendSseEvent(res, "hello", { connectedAt: new Date().toISOString() });
  await pushSnapshot();

  const unsubscribe = opsLogBuffer.subscribe((entry) => {
    sendSseEvent(res, "log", entry);
  });
  const snapshotTimer = setInterval(() => {
    void pushSnapshot();
  }, STREAM_SNAPSHOT_INTERVAL_MS);
  const keepaliveTimer = setInterval(() => {
    if (!res.writableEnded) {
      res.write(":keepalive\n\n");
    }
  }, STREAM_KEEPALIVE_MS);

  res.on("close", () => {
    unsubscribe();
    clearInterval(snapshotTimer);
    clearInterval(keepaliveTimer);
  });
}
