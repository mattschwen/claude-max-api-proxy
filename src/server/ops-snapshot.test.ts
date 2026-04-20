import assert from "node:assert/strict";
import test from "node:test";
import { buildQueueSnapshot } from "./queue-snapshot.js";
import {
  type ActiveRequestSnapshot,
} from "./request-queue.js";
import { buildRuntimeMetricsSnapshot } from "./ops-snapshot.js";

test("buildRuntimeMetricsSnapshot merges live queue and operational state", () => {
  const activeRequests: ActiveRequestSnapshot[] = [
    {
      conversationId: "conv-active",
      requestId: "req-active",
      startedAt: 1_000,
      durationMs: 4_500,
      stream: true,
      hasCancelHandler: true,
      pendingCancel: false,
    },
  ];
  const queue = buildQueueSnapshot(
    [
      [
        "conv-active",
        {
          processing: true,
          queue: [{ enqueuedAt: 1_000 }],
        },
      ],
      [
        "conv-queued",
        {
          processing: false,
          queue: [{ enqueuedAt: 2_000 }, { enqueuedAt: 2_500 }],
        },
      ],
    ],
    5_000,
  );

  const runtime = buildRuntimeMetricsSnapshot({
    activeRequests,
    queue,
    operational: {
      healthMetrics: null,
      storeStats: { conversations: 7, messages: 19, metrics: 31 },
      recentErrors: [],
      poolStatus: {
        warmedAt: "2026-04-20T00:00:00.000Z",
        isWarm: true,
        poolSize: 5,
        warming: false,
      },
      availability: {
        checkedAt: Date.parse("2026-04-20T00:01:00.000Z"),
        available: [{ id: "sonnet", family: "sonnet" }],
        unavailable: [
          {
            definition: { id: "haiku", family: "haiku" },
            error: { code: "auth_required", message: "auth failed" },
          },
        ],
        auth: { ok: true },
        cli: { version: "2.1.111" },
      } as never,
      activePids: [1234, 5678],
      failureStats: { totalFailures: 2, sessionsWithFailures: 1 },
      consecutiveAuthFailures: 3,
      authUnhealthy: true,
    },
  });

  assert.equal(runtime.activeRequests, 1);
  assert.equal(runtime.queuedRequests, 3);
  assert.equal(runtime.queuedConversations, 2);
  assert.equal(runtime.oldestQueueWaitMs, 4_000);
  assert.equal(runtime.activeSubprocesses, 2);
  assert.deepEqual(runtime.store, {
    conversations: 7,
    messages: 19,
    metrics: 31,
  });
  assert.deepEqual(runtime.sessionFailureStats, {
    totalFailures: 2,
    sessionsWithFailures: 1,
  });
  assert.deepEqual(runtime.modelAvailability, {
    available: 1,
    unavailable: 1,
    consecutiveAuthFailures: 3,
    lastCheckedAt: "2026-04-20T00:01:00.000Z",
  });
});
