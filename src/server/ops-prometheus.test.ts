import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildOperationalJsonSnapshot,
  renderOperationalPrometheus,
} from "./ops-prometheus.js";
import type { OpsDashboardSnapshot } from "./ops-snapshot.js";

function buildSnapshot(): OpsDashboardSnapshot {
  return {
    generatedAt: "2026-04-20T00:00:00.000Z",
    status: "ok",
    config: {
      sameConversationPolicy: "queue",
      maxConcurrentRequests: 4,
      debugQueues: false,
      enableAdminApi: false,
      defaultAgent: null,
      externalProviders: [],
    },
    runtime: {
      activeRequests: 1,
      queuedRequests: 2,
      queuedConversations: 1,
      oldestQueueWaitMs: 640,
      responseConversationEntries: 3,
      activeSubprocesses: 1,
      activeSessions: 1,
      sessionFailureStats: {
        totalFailures: 1,
        sessionsWithFailures: 1,
      },
      store: {
        conversations: 6,
        messages: 18,
        metrics: 12,
      },
      pool: {
        warmedAt: "2026-04-20T00:00:00.000Z",
        isWarm: true,
        poolSize: 2,
        warming: false,
      },
      modelAvailability: {
        available: 1,
        unavailable: 1,
        consecutiveAuthFailures: 0,
        lastCheckedAt: "2026-04-20T00:00:00.000Z",
      },
    },
    queue: {
      queuedRequests: 2,
      queuedConversations: 1,
      oldestQueueWaitMs: 640,
      maxConcurrentRequests: 4,
      utilizationRatio: 0.25,
      activeRequests: [
        {
          conversationId: "conv_active_123456",
          requestId: "req_123",
          startedAt: 1_700_000_000_000,
          durationMs: 4200,
          stream: true,
          hasCancelHandler: true,
          pendingCancel: false,
        },
      ],
      conversations: [
        {
          conversationId: "conv_active_123456",
          queued: 2,
          processing: true,
          waitMs: 640,
          active: true,
          activeRequestId: "req_123",
          activeDurationMs: 4200,
          stream: true,
        },
      ],
    },
    sessions: [
      {
        conversationId: "conv_active_123456",
        sessionId: "session_full_id_12345678",
        sessionIdShort: "session1",
        model: "claude-sonnet-4-7",
        createdAtMs: 1_700_000_000_000,
        lastUsedAtMs: 1_700_000_001_000,
        ageMs: 15000,
        idleMs: 5000,
        taskCount: 3,
        resumeFailures: 1,
        contextTokens: 2048,
      },
    ],
    subprocesses: [
      {
        pid: 4242,
        model: "claude-sonnet-4-7",
        modelFamily: "sonnet",
        startedAt: 1_700_000_000_500,
        uptimeMs: 3800,
        reasoningMode: "adaptive",
        thinking: "high",
        isResume: true,
        sessionId: "session_full_id_12345678",
        sessionIdShort: "session1",
      },
    ],
    recentConversations: [
      {
        conversationId: "conv_active_123456",
        createdAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_005_000,
        ageMs: 20000,
        idleMs: 3000,
        model: "claude-sonnet-4-7",
        sessionId: "session_full_id_12345678",
        messageCount: 8,
        lastRole: "assistant",
        lastMessageAtMs: 1_700_000_005_000,
        lastMessagePreview: "Latest assistant response",
        status: "active",
        activeDurationMs: 4200,
        queueWaitMs: 640,
      },
    ],
    recentLogs: [],
    availability: {
      checkedAtMs: 1_700_000_010_000,
      auth: null,
      cli: null,
      available: [
        { id: "claude-sonnet-4-7", family: "sonnet" },
      ],
      unavailable: [
        {
          id: "claude-opus-4-1",
          family: "opus",
          code: "model_unavailable",
          message: "not available",
        },
      ],
      capabilities: {
        responses: true,
        adaptiveReasoningModels: ["claude-sonnet-4-7"],
        cli: null,
      },
    },
    pool: {
      warmedAt: "2026-04-20T00:00:00.000Z",
      isWarm: true,
      poolSize: 2,
      warming: false,
    },
    store: {
      conversations: 6,
      messages: 18,
      metrics: 12,
    },
    recentErrors: [],
    healthMetrics: [],
    failureStats: {
      totalFailures: 1,
      sessionsWithFailures: 1,
    },
    consecutiveAuthFailures: 0,
    stallDetections: 2,
    responseConversationEntries: 3,
    metricSnapshot: {
      generatedAt: "2026-04-20T00:00:00.000Z",
      process: {
        startedAt: "2026-04-20T00:00:00.000Z",
        uptimeSeconds: 60,
        memoryBytes: {
          rss: 1,
          heapUsed: 1,
          heapTotal: 1,
          external: 1,
        },
        cpuSeconds: {
          user: 1,
          system: 1,
        },
      },
      runtime: {
        activeRequests: 1,
        queuedRequests: 2,
        queuedConversations: 1,
        oldestQueueWaitMs: 640,
        responseConversationEntries: 3,
        activeSubprocesses: 1,
        activeSessions: 1,
        sessionFailureStats: {
          totalFailures: 1,
          sessionsWithFailures: 1,
        },
        store: {
          conversations: 6,
          messages: 18,
          metrics: 12,
        },
        pool: {
          warmedAt: "2026-04-20T00:00:00.000Z",
          isWarm: true,
          poolSize: 2,
          warming: false,
        },
        modelAvailability: {
          available: 1,
          unavailable: 1,
          consecutiveAuthFailures: 0,
          lastCheckedAt: "2026-04-20T00:00:00.000Z",
        },
      },
      metrics: [],
    },
  };
}

test("renderOperationalPrometheus emits detailed queue and session gauges", () => {
  const text = renderOperationalPrometheus(buildSnapshot());

  assert.match(
    text,
    /claude_proxy_active_request_duration_ms\{conversation_id="conv_active_123456".*request_id="req_123".*\} 4200/,
  );
  assert.match(
    text,
    /claude_proxy_queue_conversation_wait_ms\{conversation_id="conv_active_123456".*\} 640/,
  );
  assert.match(
    text,
    /claude_proxy_session_context_tokens\{conversation_id="conv_active_123456".*session_id_short="session1".*\} 2048/,
  );
  assert.match(
    text,
    /claude_proxy_provider_model_up\{model_id="claude-sonnet-4-7",family="sonnet",status="available"\} 1/,
  );
});

test("buildOperationalJsonSnapshot returns a Grafana-friendly ops payload", () => {
  const snapshot = buildOperationalJsonSnapshot(buildSnapshot());

  assert.equal(snapshot.status, "ok");
  assert.equal(
    (snapshot.queue as { activeRequests: unknown[] }).activeRequests.length,
    1,
  );
  assert.equal(
    (snapshot.sessions as unknown[]).length,
    1,
  );
});
