import { strict as assert } from "node:assert";
import test from "node:test";
import { buildQueueSnapshot } from "./queue-snapshot.js";
import { isRequiredClaudeAuthUnhealthy } from "./runtime-snapshot.js";

test("Claude auth only fails health when Claude is required", () => {
  assert.equal(isRequiredClaudeAuthUnhealthy(3, true), true);
  assert.equal(isRequiredClaudeAuthUnhealthy(3, false), false);
  assert.equal(isRequiredClaudeAuthUnhealthy(2, true), false);
});

test("buildQueueSnapshot summarizes queue pressure and wait times", () => {
  const snapshot = buildQueueSnapshot(
    [
      [
        "conv_a",
        {
          queue: [
            { requestId: "req-a-1", enqueuedAt: 800 },
            { requestId: "req-a-2", enqueuedAt: 900 },
          ],
          processing: true,
        },
      ],
      [
        "conv_b",
        {
          queue: [],
          processing: false,
        },
      ],
      [
        "conv_c",
        {
          queue: [{ requestId: "req-c-1", enqueuedAt: 950 }],
          processing: false,
        },
      ],
    ],
    1000,
  );

  assert.equal(snapshot.queuedRequests, 3);
  assert.equal(snapshot.queuedConversations, 2);
  assert.equal(snapshot.oldestQueueWaitMs, 200);
  assert.deepEqual(snapshot.queueStatus, {
    conv_a: {
      queued: 2,
      processing: true,
      waitMs: 200,
      queuedRequestIds: ["req-a-1", "req-a-2"],
    },
    conv_c: {
      queued: 1,
      processing: false,
      waitMs: 50,
      queuedRequestIds: ["req-c-1"],
    },
  });
});

test("buildQueueSnapshot exposes only bounded safe opaque request ids", () => {
  const snapshot = buildQueueSnapshot(
    [
      [
        "conv_bounded",
        {
          queue: Array.from({ length: 20 }, (_, index) => ({
            requestId: `req-${index + 1}`,
            enqueuedAt: index,
          })),
          processing: false,
        },
      ],
      [
        "conv_unsafe",
        {
          queue: [
            { requestId: "req-ok", enqueuedAt: 1 },
            { requestId: "req-bad\nheader", enqueuedAt: 2 },
            { enqueuedAt: 3 },
          ],
          processing: false,
        },
      ],
    ],
    100,
  );

  assert.deepEqual(
    snapshot.queueStatus.conv_bounded.queuedRequestIds,
    Array.from({ length: 16 }, (_, index) => `req-${index + 1}`),
  );
  assert.deepEqual(
    snapshot.queueStatus.conv_unsafe.queuedRequestIds,
    ["req-ok"],
  );
});
