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

interface RequestQueueOptions {
  debugQueues?: () => boolean;
  sameConversationPolicy?: () => SameConversationPolicy;
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
  private readonly now: () => number;
  private readonly writeLog: typeof log;
  private readonly isDebugQueuesEnabled: () => boolean;
  private readonly getSameConversationPolicy: () => SameConversationPolicy;

  constructor(options: RequestQueueOptions = {}) {
    this.now = options.now ?? Date.now;
    this.writeLog = options.log ?? log;
    this.isDebugQueuesEnabled =
      options.debugQueues ?? (() => runtimeConfig.debugQueues);
    this.getSameConversationPolicy =
      options.sameConversationPolicy ??
      (() => runtimeConfig.sameConversationPolicy);
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
        policy: this.getSameConversationPolicy(),
      });

      if (!entry.processing) {
        void this.processQueue(conversationId);
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

  private async processQueue(conversationId: string): Promise<void> {
    const entry = this.conversationQueues.get(conversationId);
    if (!entry || entry.queue.length === 0) {
      if (entry) {
        entry.processing = false;
        if (entry.queue.length === 0) {
          this.conversationQueues.delete(conversationId);
        }
      }
      return;
    }

    entry.processing = true;
    const item = entry.queue.shift()!;

    try {
      const result = await item.handler();
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      void this.processQueue(conversationId);
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
