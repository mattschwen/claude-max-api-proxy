export interface QueueItemLike {
  enqueuedAt: number;
}

export interface QueueEntryLike {
  queue: QueueItemLike[];
  processing: boolean;
}

export interface QueueStatusEntry {
  queued: number;
  processing: boolean;
  waitMs?: number;
}

export interface QueueSnapshot {
  queueStatus: Record<string, QueueStatusEntry>;
  queuedRequests: number;
  queuedConversations: number;
  oldestQueueWaitMs: number;
}

export function buildQueueSnapshot(
  entries: Iterable<[string, QueueEntryLike]>,
  now = Date.now(),
): QueueSnapshot {
  const queueStatus: Record<string, QueueStatusEntry> = {};
  let queuedRequests = 0;
  let queuedConversations = 0;
  let oldestQueueWaitMs = 0;

  for (const [conversationId, entry] of entries) {
    if (entry.queue.length === 0 && !entry.processing) {
      continue;
    }
    queuedConversations += 1;
    queuedRequests += entry.queue.length;

    const oldestItem = entry.queue[0];
    const waitMs = oldestItem ? Math.max(0, now - oldestItem.enqueuedAt) : undefined;
    if (typeof waitMs === "number") {
      oldestQueueWaitMs = Math.max(oldestQueueWaitMs, waitMs);
    }

    queueStatus[conversationId] = {
      queued: entry.queue.length,
      processing: entry.processing,
      waitMs,
    };
  }

  return {
    queueStatus,
    queuedRequests,
    queuedConversations,
    oldestQueueWaitMs,
  };
}
