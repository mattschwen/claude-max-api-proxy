import { strict as assert } from "node:assert";
import test from "node:test";
import { buildQueueSnapshot } from "./queue-snapshot.js";

test("buildQueueSnapshot summarizes queue pressure and wait times", () => {
  const snapshot = buildQueueSnapshot(
    [
      [
        "conv_a",
        {
          queue: [{ enqueuedAt: 800 }, { enqueuedAt: 900 }],
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
          queue: [{ enqueuedAt: 950 }],
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
    },
    conv_c: {
      queued: 1,
      processing: false,
      waitMs: 50,
    },
  });
});
