import assert from "node:assert/strict";
import test from "node:test";
import type { LogEntry, LogEvent } from "../logger.js";
import {
  ConversationRequestQueue,
  QueueFullError,
  RequestCancelledError,
} from "./request-queue.js";
import { buildQueueSnapshot } from "./queue-snapshot.js";

const noopLog = (
  _event: LogEvent,
  _fields: Omit<LogEntry, "ts" | "event"> = {},
): void => {};

function createQueue(maxConcurrent = 4): ConversationRequestQueue {
  return new ConversationRequestQueue({
    debugQueues: () => false,
    sameConversationPolicy: () => "latest-wins",
    maxConcurrent,
    log: noopLog,
  });
}

test(
  "ConversationRequestQueue serializes requests per conversation and cleans up",
  async () => {
    const queue = createQueue();
    const order: string[] = [];

    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStartedResolve!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve;
    });

    const first = queue.enqueue(
      "conv-1",
      "req-1",
      async () => {
        order.push("first:start");
        firstStartedResolve();
        await firstBlocked;
        order.push("first:end");
      },
      1000,
    );

    await firstStarted;

    const second = queue.enqueue(
      "conv-1",
      "req-2",
      async () => {
        order.push("second:start");
      },
      1000,
    );

    assert.equal(queue.getQueueDepth("conv-1"), 1);
    releaseFirst();

    await Promise.all([first, second]);

    assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
    assert.equal(queue.getQueueDepth("conv-1"), 0);
    assert.equal(Array.from(queue.getQueueEntries()).length, 0);
    assert.equal(queue.getActiveRequestCount(), 0);
  },
);

test(
  "ConversationRequestQueue latest-wins rejects queued work and cancels active requests",
  async () => {
    const queue = createQueue();

    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStartedResolve!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve;
    });

    let cancelledCode: string | null | undefined;
    const first = queue.enqueue(
      "conv-2",
      "req-active",
      async () => {
        const active = queue.registerActiveRequest("conv-2", "req-active", true);
        active.setCancel((error) => {
          cancelledCode = error.code;
        });
        firstStartedResolve();
        await firstBlocked;
        active.clear();
      },
      1000,
    );

    await firstStarted;

    const queued = queue.enqueue(
      "conv-2",
      "req-queued",
      async () => {},
      1000,
    );
    const queuedError = queued.catch((error) => error);

    assert.equal(queue.getQueueDepth("conv-2"), 1);

    queue.applyLatestWins("conv-2", "req-new");

    assert.equal(cancelledCode, "request_superseded");
    const error = await queuedError;
    assert.ok(error instanceof RequestCancelledError);
    assert.equal(error.proxyError.code, "request_superseded");

    releaseFirst();
    await first;
  },
);

test(
  "ConversationRequestQueue delivers pending cancellation when cancel handler is registered later",
  () => {
    const queue = createQueue();
    const active = queue.registerActiveRequest("conv-3", "req-old", false);

    queue.applyLatestWins("conv-3", "req-new");

    let deliveredCode: string | null | undefined;
    active.setCancel((error) => {
      deliveredCode = error.code;
    });
    active.clear();

    assert.equal(deliveredCode, "request_superseded");
  },
);

test(
  "ConversationRequestQueue enforces a global concurrency cap across conversations",
  async () => {
    const queue = createQueue(1);
    const order: string[] = [];

    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStartedResolve!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve;
    });

    const first = queue.enqueue(
      "conv-a",
      "req-a",
      async () => {
        order.push("a:start");
        firstStartedResolve();
        await firstBlocked;
        order.push("a:end");
      },
      1000,
    );

    await firstStarted;

    let secondStarted = false;
    const second = queue.enqueue(
      "conv-b",
      "req-b",
      async () => {
        secondStarted = true;
        order.push("b:start");
      },
      1000,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(secondStarted, false);

    releaseFirst();
    await Promise.all([first, second]);

    assert.deepEqual(order, ["a:start", "a:end", "b:start"]);
    assert.equal(queue.getMaxConcurrent(), 1);
  },
);

test("submit rejects an older arrival when async validation completes out of order", async () => {
  const queue = createQueue(1);
  const ran: string[] = [];

  let releaseBlocker!: () => void;
  let blockerStartedResolve!: () => void;
  const blockerStarted = new Promise<void>((resolve) => {
    blockerStartedResolve = resolve;
  });
  const blocker = queue.enqueue(
    "blocker",
    "req-blocker",
    async () => {
      blockerStartedResolve();
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
    },
    1000,
  );
  await blockerStarted;

  const olderSequence = queue.reserveSequence("conv-order");
  const newerSequence = queue.reserveSequence("conv-order");
  const newer = queue.submit(
    "conv-order",
    "req-newer",
    async () => {
      ran.push("newer");
    },
    {
      hardTimeoutMs: 1000,
      sequence: newerSequence,
      policy: "latest-wins",
    },
  );
  const olderError = await queue.submit(
    "conv-order",
    "req-older",
    async () => {
      ran.push("older");
    },
    {
      hardTimeoutMs: 1000,
      sequence: olderSequence,
      policy: "latest-wins",
    },
  ).catch((error) => error);

  assert.ok(olderError instanceof RequestCancelledError);
  assert.equal(olderError.proxyError.code, "request_superseded");

  releaseBlocker();
  await Promise.all([blocker, newer]);
  assert.deepEqual(ran, ["newer"]);
});

test("an older latest-wins submission cannot supersede newer admitted queue work", async () => {
  const queue = createQueue(1);
  let releaseBlocker!: () => void;
  let blockerStartedResolve!: () => void;
  const blockerStarted = new Promise<void>((resolve) => {
    blockerStartedResolve = resolve;
  });
  const blocker = queue.enqueue(
    "mixed-policy-blocker",
    "req-mixed-blocker",
    async () => {
      blockerStartedResolve();
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
    },
    1000,
  );
  await blockerStarted;

  const olderSequence = queue.reserveSequence("conv-mixed-policy");
  const newerSequence = queue.reserveSequence("conv-mixed-policy");
  let newerRan = false;
  const newer = queue.submit(
    "conv-mixed-policy",
    "req-newer-queued",
    async () => {
      newerRan = true;
    },
    {
      hardTimeoutMs: 1000,
      sequence: newerSequence,
      policy: "queue",
    },
  );
  const olderError = await queue.submit(
    "conv-mixed-policy",
    "req-older-interrupt",
    async () => {
      assert.fail("older latest-wins work must not run");
    },
    {
      hardTimeoutMs: 1000,
      sequence: olderSequence,
      policy: "latest-wins",
    },
  ).catch((error) => error);

  assert.ok(olderError instanceof RequestCancelledError);
  assert.equal(olderError.proxyError.code, "request_superseded");

  releaseBlocker();
  await Promise.all([blocker, newer]);
  assert.equal(newerRan, true);
});

test("an older queued submission cannot outlive a newer latest-wins arrival", async () => {
  const queue = createQueue(1);
  let releaseBlocker!: () => void;
  let blockerStartedResolve!: () => void;
  const blockerStarted = new Promise<void>((resolve) => {
    blockerStartedResolve = resolve;
  });
  const blocker = queue.enqueue(
    "interrupt-policy-blocker",
    "req-interrupt-blocker",
    async () => {
      blockerStartedResolve();
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
    },
    1000,
  );
  await blockerStarted;

  const olderSequence = queue.reserveSequence("conv-interrupt-policy");
  const newerSequence = queue.reserveSequence("conv-interrupt-policy");
  let newerRan = false;
  const newer = queue.submit(
    "conv-interrupt-policy",
    "req-newer-interrupt",
    async () => {
      newerRan = true;
    },
    {
      hardTimeoutMs: 1000,
      sequence: newerSequence,
      policy: "latest-wins",
    },
  );
  const olderError = await queue.submit(
    "conv-interrupt-policy",
    "req-older-queued",
    async () => {
      assert.fail("work older than an admitted interrupt must not run");
    },
    {
      hardTimeoutMs: 1000,
      sequence: olderSequence,
      policy: "queue",
    },
  ).catch((error) => error);

  assert.ok(olderError instanceof RequestCancelledError);
  assert.equal(olderError.proxyError.code, "request_superseded");

  releaseBlocker();
  await Promise.all([blocker, newer]);
  assert.equal(newerRan, true);
});

test("queue policy preserves reserved arrival order for waiting submissions", async () => {
  const queue = createQueue();
  const ran: string[] = [];
  let releaseActive!: () => void;
  let activeStartedResolve!: () => void;
  const activeStarted = new Promise<void>((resolve) => {
    activeStartedResolve = resolve;
  });
  const active = queue.enqueue(
    "conv-fifo",
    "req-active",
    async () => {
      activeStartedResolve();
      await new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
    },
    1000,
  );
  await activeStarted;

  const olderSequence = queue.reserveSequence("conv-fifo");
  const newerSequence = queue.reserveSequence("conv-fifo");
  const newer = queue.submit(
    "conv-fifo",
    "req-newer",
    async () => {
      ran.push("newer");
    },
    {
      hardTimeoutMs: 1000,
      sequence: newerSequence,
      policy: "queue",
    },
  );
  const older = queue.submit(
    "conv-fifo",
    "req-older",
    async () => {
      ran.push("older");
    },
    {
      hardTimeoutMs: 1000,
      sequence: olderSequence,
      policy: "queue",
    },
  );

  releaseActive();
  await Promise.all([active, older, newer]);
  assert.deepEqual(ran, ["older", "newer"]);
});

test("queue wait timeout starts at enqueue and removes work before execution", async () => {
  const queue = createQueue(1);

  let releaseBlocker!: () => void;
  let blockerStartedResolve!: () => void;
  const blockerStarted = new Promise<void>((resolve) => {
    blockerStartedResolve = resolve;
  });
  const blocker = queue.enqueue(
    "conv-running",
    "req-running",
    async () => {
      blockerStartedResolve();
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
    },
    1000,
  );
  await blockerStarted;

  let ran = false;
  const timedOut = queue.submit(
    "conv-waiting",
    "req-waiting",
    async () => {
      ran = true;
    },
    {
      hardTimeoutMs: 1000,
      policy: "queue",
      queueWaitTimeoutMs: 15,
    },
  ).catch((error) => error);

  const error = await timedOut;
  assert.match(String(error?.message), /Queue timeout/);
  assert.equal(ran, false);
  assert.equal(queue.getQueueDepth("conv-waiting"), 0);

  releaseBlocker();
  await blocker;
});

test("aborting a queued submission removes it without running the handler", async () => {
  const queue = createQueue(1);

  let releaseBlocker!: () => void;
  let blockerStartedResolve!: () => void;
  const blockerStarted = new Promise<void>((resolve) => {
    blockerStartedResolve = resolve;
  });
  const blocker = queue.enqueue(
    "conv-active",
    "req-active",
    async () => {
      blockerStartedResolve();
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
    },
    1000,
  );
  await blockerStarted;

  const controller = new AbortController();
  let ran = false;
  const queued = queue.submit(
    "conv-abort",
    "req-abort",
    async () => {
      ran = true;
    },
    {
      hardTimeoutMs: 1000,
      policy: "queue",
      signal: controller.signal,
    },
  ).catch((error) => error);

  controller.abort();
  const error = await queued;
  assert.ok(error instanceof RequestCancelledError);
  assert.equal(error.proxyError.code, "request_cancelled");
  assert.equal(ran, false);
  assert.equal(queue.getQueueDepth("conv-abort"), 0);

  releaseBlocker();
  await blocker;
});

test("queue deadlines never release a slot while an active handler is still running", async () => {
  const queue = createQueue(1);
  let releaseFirst!: () => void;
  let firstStartedResolve!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstStartedResolve = resolve;
  });

  const first = queue.submit(
    "conv-first",
    "req-first",
    async () => {
      firstStartedResolve();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    },
    {
      hardTimeoutMs: 1000,
      policy: "queue",
      queueWaitTimeoutMs: 10,
    },
  );
  await firstStarted;

  let secondStarted = false;
  const second = queue.submit(
    "conv-second",
    "req-second",
    async () => {
      secondStarted = true;
    },
    {
      hardTimeoutMs: 1000,
      policy: "queue",
      queueWaitTimeoutMs: 1000,
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(secondStarted, false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(secondStarted, true);
});

test("submit enforces queue depth atomically", async () => {
  const queue = createQueue(1);
  let releaseBlocker!: () => void;
  let blockerStartedResolve!: () => void;
  const blockerStarted = new Promise<void>((resolve) => {
    blockerStartedResolve = resolve;
  });
  const blocker = queue.enqueue(
    "conv-blocker",
    "req-blocker",
    async () => {
      blockerStartedResolve();
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
    },
    1000,
  );
  await blockerStarted;

  const accepted = queue.submit("conv-depth", "req-one", async () => {}, {
    hardTimeoutMs: 1000,
    policy: "queue",
    maxQueueDepth: 1,
  });
  const rejected = await queue.submit(
    "conv-depth",
    "req-two",
    async () => {},
    {
      hardTimeoutMs: 1000,
      policy: "queue",
      maxQueueDepth: 1,
    },
  ).catch((error) => error);

  assert.ok(rejected instanceof QueueFullError);
  releaseBlocker();
  await Promise.all([blocker, accepted]);
});

test("cancelRequest cancels queued and active work by request id", async () => {
  const queue = createQueue();
  let releaseActive!: () => void;
  let activeStartedResolve!: () => void;
  const activeStarted = new Promise<void>((resolve) => {
    activeStartedResolve = resolve;
  });
  let activeCancellation: string | null = null;

  const active = queue.enqueue(
    "conv-cancel",
    "req-active-cancel",
    async () => {
      const registration = queue.registerActiveRequest(
        "conv-cancel",
        "req-active-cancel",
        false,
      );
      registration.setCancel((error) => {
        activeCancellation = error.code;
      });
      activeStartedResolve();
      await new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
      registration.clear();
    },
    1000,
  );
  await activeStarted;

  const queued = queue.enqueue(
    "conv-cancel",
    "req-queued-cancel",
    async () => {
      assert.fail("cancelled queued work must not run");
    },
    1000,
  ).catch((error) => error);

  assert.deepEqual(
    buildQueueSnapshot(queue.getQueueEntries()).queueStatus["conv-cancel"]
      .queuedRequestIds,
    ["req-queued-cancel"],
  );
  assert.equal(
    queue.cancelRequest("req-queued-cancel", "api_request"),
    true,
  );
  const queuedError = await queued;
  assert.ok(queuedError instanceof RequestCancelledError);
  assert.equal(queuedError.proxyError.code, "request_cancelled");

  assert.equal(
    queue.cancelRequest("req-active-cancel", "api_request"),
    true,
  );
  assert.equal(activeCancellation, "request_cancelled");
  assert.equal(queue.cancelRequest("req-missing"), false);

  releaseActive();
  await active;
});

test("latest-submission ordering history is bounded for idle conversations", async () => {
  let now = 1;
  const queue = new ConversationRequestQueue({
    maxConcurrent: 1,
    now: () => now++,
    latestHistoryLimit: 2,
    latestHistoryTtlMs: 10_000,
  });

  for (const conversationId of ["one", "two", "three"]) {
    await queue.submit(
      conversationId,
      `request-${conversationId}`,
      async () => {},
      {
        hardTimeoutMs: 1_000,
        policy: "latest-wins",
      },
    );
  }

  assert.equal(queue.getLatestSubmissionHistorySize(), 2);
});
