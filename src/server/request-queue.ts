import type { ClaudeProxyError } from "../claude-cli.inspect.js";
import { type SameConversationPolicy, runtimeConfig } from "../config.js";
import { log } from "../logger.js";
import type { QueueEntryLike, QueueItemLike } from "./queue-snapshot.js";

interface QueueItem extends QueueItemLike {
  requestId: string;
  handler: () => Promise<void>;
  resolve: (value: void) => void;
  reject: (reason: unknown) => void;
}

interface QueueEntry extends QueueEntryLike {
  queue: QueueItem[];
  processing: boolean;
}

interface ActiveRequestEntry {
  requestId: string;
  startedAt: number;
  stream: boolean;
  cancel?: (error: ClaudeProxyError) => void;
  pendingCancel?: ClaudeProxyError;
}

export interface ActiveRequestSnapshot {
  conversationId: string;
  requestId: string;
  startedAt: number;
  durationMs: number;
  stream: boolean;
  hasCancelHandler: boolean;
  pendingCancel: boolean;
}

interface RequestQueueOptions {
  debugQueues?: () => boolean;
  sameConversationPolicy?: () => SameConversationPolicy;
  maxConcurrent?: number;
  log?: typeof log;
  now?: () => number;
}

type QueueDebugEvent =
  | "queue.enqueue"
  | "queue.drop"
  | "queue.blocked"
  | "request.cancel";

export const MAX_QUEUE_DEPTH = 5;

export class RequestCancelledError extends Error {
  constructor(public readonly proxyError: ClaudeProxyError) {
    super(proxyError.message);
    this.name = "RequestCancelledError";
  }
}

export class ConversationRequestQueue {
  private readonly conversationQueues = new Map<string, QueueEntry>();
  private readonly activeRequests = new Map<string, ActiveRequestEntry>();
  private readonly readyConversationIds: string[] = [];
  private readonly readyConversationSet = new Set<string>();
  private readonly now: () => number;
  private readonly writeLog: typeof log;
  private readonly isDebugQueuesEnabled: () => boolean;
  private readonly getSameConversationPolicy: () => SameConversationPolicy;
  private readonly maxConcurrent: number;
  private activeHandlers = 0;

  constructor(options: RequestQueueOptions = {}) {
    this.now = options.now ?? Date.now;
    this.writeLog = options.log ?? log;
    this.isDebugQueuesEnabled =
      options.debugQueues ?? (() => runtimeConfig.debugQueues);
    this.getSameConversationPolicy =
      options.sameConversationPolicy ??
      (() => runtimeConfig.sameConversationPolicy);
    this.maxConcurrent = Math.max(
      1,
      options.maxConcurrent ?? runtimeConfig.maxConcurrentRequests,
    );
  }

  enqueue(
    conversationId: string,
    requestId: string,
    handler: () => Promise<void>,
    hardTimeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let entry = this.conversationQueues.get(conversationId);
      if (!entry) {
        entry = { queue: [], processing: false };
        this.conversationQueues.set(conversationId, entry);
      }

      const queuePosition = entry.queue.length;
      const queueBufferMs = Math.max(60000, queuePosition * 60000);
      const queueTimeoutMs = hardTimeoutMs + queueBufferMs;

      const item: QueueItem = {
        requestId,
        handler: () => {
          return new Promise<void>((handlerResolve, handlerReject) => {
            const queueTimer = setTimeout(() => {
              this.writeLog("queue.timeout", {
                conversationId,
                timeoutMs: queueTimeoutMs,
              });
              handlerReject(
                new Error(`Queue timeout after ${queueTimeoutMs / 1000}s`),
              );
            }, queueTimeoutMs);

            handler()
              .then(() => {
                clearTimeout(queueTimer);
                handlerResolve();
              })
              .catch((error) => {
                clearTimeout(queueTimer);
                handlerReject(error);
              });
          });
        },
        resolve,
        reject,
        enqueuedAt: this.now(),
      };

      entry.queue.push(item);
      this.writeLog("queue.enqueue", {
        conversationId,
        depth: entry.queue.length,
      });
      this.logQueueDebug("queue.enqueue", {
        conversationId,
        requestId,
        depth: entry.queue.length,
        processing: entry.processing,
        activeHandlers: this.activeHandlers,
        maxConcurrent: this.maxConcurrent,
        policy: this.getSameConversationPolicy(),
      });

      if (!entry.processing) {
        this.markConversationReady(conversationId, entry);
        this.drainQueues();
      }
    });
  }

  applyLatestWins(
    conversationId: string,
    supersedingRequestId: string,
  ): void {
    this.clearQueuedRequests(conversationId, supersedingRequestId);
    this.supersedeActiveRequest(conversationId, supersedingRequestId);
  }

  logBlockedRequest(
    conversationId: string,
    requestId: string,
    depth: number,
  ): void {
    this.writeLog("queue.blocked", { conversationId, depth });
    this.logQueueDebug("queue.blocked", {
      conversationId,
      requestId,
      depth,
      policy: this.getSameConversationPolicy(),
    });
  }

  registerActiveRequest(
    conversationId: string,
    requestId: string,
    stream: boolean,
  ): {
    setCancel: (cancel: (error: ClaudeProxyError) => void) => void;
    clear: () => void;
  } {
    const entry: ActiveRequestEntry = {
      requestId,
      startedAt: this.now(),
      stream,
    };
    this.activeRequests.set(conversationId, entry);

    return {
      setCancel: (cancel: (error: ClaudeProxyError) => void): void => {
        entry.cancel = cancel;
        if (entry.pendingCancel) {
          const pending = entry.pendingCancel;
          entry.pendingCancel = undefined;
          cancel(pending);
        }
      },
      clear: (): void => {
        const current = this.activeRequests.get(conversationId);
        if (current === entry) {
          this.activeRequests.delete(conversationId);
        }
      },
    };
  }

  getQueueDepth(conversationId: string): number {
    return this.conversationQueues.get(conversationId)?.queue.length ?? 0;
  }

  getQueueEntries(): Iterable<[string, QueueEntryLike]> {
    return this.conversationQueues.entries();
  }

  getActiveRequestCount(): number {
    return this.activeRequests.size;
  }

  getActiveRequests(now = this.now()): ActiveRequestSnapshot[] {
    return Array.from(this.activeRequests.entries())
      .map(([conversationId, entry]) => ({
        conversationId,
        requestId: entry.requestId,
        startedAt: entry.startedAt,
        durationMs: Math.max(0, now - entry.startedAt),
        stream: entry.stream,
        hasCancelHandler: typeof entry.cancel === "function",
        pendingCancel: Boolean(entry.pendingCancel),
      }))
      .sort((left, right) => right.durationMs - left.durationMs);
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  private markConversationReady(
    conversationId: string,
    entry: QueueEntry,
  ): void {
    if (
      entry.processing ||
      entry.queue.length === 0 ||
      this.readyConversationSet.has(conversationId)
    ) {
      return;
    }
    this.readyConversationSet.add(conversationId);
    this.readyConversationIds.push(conversationId);
  }

  private cleanupConversationEntry(conversationId: string): void {
    const entry = this.conversationQueues.get(conversationId);
    if (!entry || entry.processing || entry.queue.length > 0) {
      return;
    }
    this.conversationQueues.delete(conversationId);
  }

  private drainQueues(): void {
    while (
      this.activeHandlers < this.maxConcurrent &&
      this.readyConversationIds.length > 0
    ) {
      const conversationId = this.readyConversationIds.shift()!;
      this.readyConversationSet.delete(conversationId);
      const entry = this.conversationQueues.get(conversationId);
      if (!entry) {
        continue;
      }
      if (entry.processing || entry.queue.length === 0) {
        this.cleanupConversationEntry(conversationId);
        continue;
      }

      entry.processing = true;
      this.activeHandlers += 1;
      const item = entry.queue.shift()!;
      void this.runItem(conversationId, entry, item);
    }
  }

  private async runItem(
    conversationId: string,
    entry: QueueEntry,
    item: QueueItem,
  ): Promise<void> {
    try {
      const result = await item.handler();
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      this.activeHandlers = Math.max(0, this.activeHandlers - 1);
      const current = this.conversationQueues.get(conversationId);
      if (current === entry) {
        entry.processing = false;
        if (entry.queue.length > 0) {
          this.markConversationReady(conversationId, entry);
        } else {
          this.cleanupConversationEntry(conversationId);
        }
      }
      this.drainQueues();
    }
  }

  private logQueueDebug(
    event: QueueDebugEvent,
    fields: Record<string, unknown>,
  ): void {
    if (!this.isDebugQueuesEnabled()) return;
    this.writeLog(event, fields);
  }

  private createSupersededError(
    conversationId: string,
    supersedingRequestId: string,
  ): ClaudeProxyError {
    return {
      status: 409,
      type: "invalid_request_error",
      code: "request_superseded",
      message: `Request for conversation '${conversationId}' was superseded by a newer message (${supersedingRequestId}).`,
    };
  }

  private clearQueuedRequests(
    conversationId: string,
    supersedingRequestId: string,
  ): void {
    const entry = this.conversationQueues.get(conversationId);
    if (!entry || entry.queue.length === 0) return;

    const staleItems = entry.queue.splice(0);
    this.cleanupConversationEntry(conversationId);
    for (const item of staleItems) {
      this.writeLog("queue.drop", {
        conversationId,
        requestId: item.requestId,
        reason: "superseded_by_newer_request",
        supersedingRequestId,
      });
      this.logQueueDebug("queue.drop", {
        conversationId,
        requestId: item.requestId,
        reason: "superseded_by_newer_request",
        supersedingRequestId,
        droppedQueuedRequests: staleItems.length,
      });
      item.reject(
        new RequestCancelledError(
          this.createSupersededError(conversationId, supersedingRequestId),
        ),
      );
    }
  }

  private supersedeActiveRequest(
    conversationId: string,
    supersedingRequestId: string,
  ): void {
    const active = this.activeRequests.get(conversationId);
    if (!active || active.requestId === supersedingRequestId) return;

    const error = this.createSupersededError(
      conversationId,
      supersedingRequestId,
    );
    this.writeLog("request.cancel", {
      conversationId,
      requestId: active.requestId,
      reason: "superseded_by_newer_request",
      supersedingRequestId,
    });
    this.logQueueDebug("request.cancel", {
      conversationId,
      requestId: active.requestId,
      supersedingRequestId,
      reason: "superseded_by_newer_request",
      startedAt: active.startedAt,
      stream: active.stream,
    });

    if (active.cancel) {
      active.cancel(error);
    } else {
      active.pendingCancel = error;
    }
  }
}

export const conversationRequestQueue = new ConversationRequestQueue();
