import assert from "node:assert/strict";
import test from "node:test";
import type { LogEntry, LogEvent } from "../logger.js";
import {
  ConversationRequestQueue,
  RequestCancelledError,
} from "./request-queue.js";

const noopLog = (
  _event: LogEvent,
  _fields: Omit<LogEntry, "ts" | "event"> = {},
): void => {};

function createQueue(): ConversationRequestQueue {
  return new ConversationRequestQueue({
    debugQueues: () => false,
    sameConversationPolicy: () => "latest-wins",
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
