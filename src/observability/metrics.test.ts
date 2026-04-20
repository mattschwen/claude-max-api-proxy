import { strict as assert } from "node:assert";
import test from "node:test";
import { ProxyMetricsCollector } from "./metrics.js";

function runtimeSnapshot(): Parameters<ProxyMetricsCollector["renderPrometheus"]>[0] {
  return {
    activeRequests: 1,
    queuedRequests: 2,
    queuedConversations: 1,
    oldestQueueWaitMs: 250,
    responseConversationEntries: 3,
    activeSubprocesses: 1,
    activeSessions: 4,
    sessionFailureStats: {
      totalFailures: 2,
      sessionsWithFailures: 1,
    },
    store: {
      conversations: 5,
      messages: 12,
      metrics: 8,
    },
    pool: {
      warmedAt: "2026-04-20T00:00:00.000Z",
      isWarm: true,
      poolSize: 5,
      warming: false,
    },
    modelAvailability: {
      available: 3,
      unavailable: 0,
      consecutiveAuthFailures: 0,
      lastCheckedAt: "2026-04-20T00:00:00.000Z",
    },
  };
}

test("ProxyMetricsCollector records proxy lifecycle and renders Prometheus output", () => {
  const collector = new ProxyMetricsCollector();

  collector.recordLog({
    ts: new Date().toISOString(),
    event: "request.start",
    requestId: "req_1",
    model: "claude-sonnet-4-7",
    stream: true,
    agent: "expert-coder",
    reasoningMode: "adaptive",
    queueDepth: 2,
  });
  collector.recordLog({
    ts: new Date().toISOString(),
    event: "request.start",
    requestId: "req_1",
    ttfbMs: 420,
    firstTokenMs: 180,
  });
  collector.recordLog({
    ts: new Date().toISOString(),
    event: "request.retry",
    requestId: "req_1",
    reason: "auth_retry",
  });
  collector.recordLog({
    ts: new Date().toISOString(),
    event: "queue.enqueue",
    depth: 3,
  });
  collector.recordLog({
    ts: new Date().toISOString(),
    event: "subprocess.spawn",
    model: "claude-sonnet-4-7",
    reasoningMode: "adaptive",
    thinking: "high",
  });
  collector.recordLog({
    ts: new Date().toISOString(),
    event: "session.created",
  });
  collector.recordLog({
    ts: new Date().toISOString(),
    event: "auth.failure",
    phase: "initial",
  });
  collector.recordLog({
    ts: new Date().toISOString(),
    event: "request.complete",
    requestId: "req_1",
    durationMs: 1250,
    responseLength: 640,
  });

  const text = collector.renderPrometheus(runtimeSnapshot());

  assert.match(
    text,
    /claude_proxy_requests_started_total\{stream="true",agent="expert-coder",model_family="sonnet",reasoning_mode="adaptive"\} 1/,
  );
  assert.match(
    text,
    /claude_proxy_request_outcomes_total\{outcome="success",stream="true",agent="expert-coder",model_family="sonnet",reasoning_mode="adaptive"\} 1/,
  );
  assert.match(
    text,
    /claude_proxy_request_ttfb_ms_bucket\{stream="true",model_family="sonnet",le="500"\} 1/,
  );
  assert.match(
    text,
    /claude_proxy_queue_events_total\{event="enqueue"\} 1/,
  );
  assert.match(
    text,
    /claude_proxy_subprocess_spawns_total\{model_family="sonnet",reasoning_mode="adaptive",thinking="high"\} 1/,
  );
  assert.match(
    text,
    /claude_proxy_runtime_queued_requests 2/,
  );
  assert.match(
    text,
    /claude_proxy_models_available 3/,
  );
});

test("ProxyMetricsCollector records HTTP observations and exposes JSON snapshots", () => {
  const collector = new ProxyMetricsCollector();

  collector.recordHttpRequest({
    method: "GET",
    route: "/metrics",
    status: 200,
    durationMs: 12,
    responseBytes: 1024,
    ended: "finish",
  });

  const snapshot = collector.getJsonSnapshot(runtimeSnapshot());
  assert.equal(snapshot.runtime.activeRequests, 1);

  const metrics = snapshot.metrics as Array<{
    name: string;
    samples: Array<{ labels: Record<string, string>; value?: number }>;
  }>;
  const httpMetric = metrics.find(
    (metric) => metric.name === "claude_proxy_http_requests_total",
  );

  assert(httpMetric);
  assert.equal(httpMetric.samples.length, 1);
  assert.deepEqual(httpMetric.samples[0].labels, {
    method: "GET",
    route: "/metrics",
    status: "200",
    status_class: "2xx",
    ended: "finish",
  });
  assert.equal(httpMetric.samples[0].value, 1);
});
