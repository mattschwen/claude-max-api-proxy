import type { ClaudeProxyError } from "../claude-cli.inspect.js";
import { type SameConversationPolicy, runtimeConfig } from "../config.js";
import { log } from "../logger.js";
import type { QueueEntryLike, QueueItemLike } from "./queue-snapshot.js";

interface QueueItem extends QueueItemLike {
  requestId: string;
  handler: () => Promise<void>;
  resolve: (value: void) => void;
  reject: (reason: unknown) => void;
  queueTimeout?: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
  sequence?: number;
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
  latestHistoryTtlMs?: number;
  latestHistoryLimit?: number;
}

export interface QueueSubmissionOptions {
  hardTimeoutMs: number;
  /**
   * Sequence reserved when the HTTP request first arrived. Supplying this is
   * what makes latest-wins deterministic even when validation finishes out of
   * order.
   */
  sequence?: number;
  policy?: SameConversationPolicy;
  signal?: AbortSignal;
  maxQueueDepth?: number;
  /** Override primarily intended for tests and specialized callers. */
  queueWaitTimeoutMs?: number;
}

type QueueDebugEvent =
  | "queue.enqueue"
  | "queue.drop"
  | "queue.blocked"
  | "request.cancel";

export const MAX_QUEUE_DEPTH = 5;
const DEFAULT_LATEST_HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LATEST_HISTORY_LIMIT = 10_000;

export class RequestCancelledError extends Error {
  constructor(public readonly proxyError: ClaudeProxyError) {
    super(proxyError.message);
    this.name = "RequestCancelledError";
  }
}

export class QueueFullError extends Error {
  readonly code = "queue_full";

  constructor(
    public readonly conversationId: string,
    public readonly depth: number,
  ) {
    super(
      `Too many queued requests for conversation '${conversationId}' (${depth}).`,
    );
    this.name = "QueueFullError";
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
  private readonly latestSubmissions = new Map<
    string,
    {
      sequence: number;
      requestId: string;
      policy: SameConversationPolicy;
      updatedAt: number;
    }
  >();
  private readonly latestHistoryTtlMs: number;
  private readonly latestHistoryLimit: number;
  private sequenceCounter = 0;
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
    this.latestHistoryTtlMs = Math.max(
      1,
      options.latestHistoryTtlMs ?? DEFAULT_LATEST_HISTORY_TTL_MS,
    );
    this.latestHistoryLimit = Math.max(
      1,
      options.latestHistoryLimit ?? DEFAULT_LATEST_HISTORY_LIMIT,
    );
  }

  enqueue(
    conversationId: string,
    requestId: string,
    handler: () => Promise<void>,
    hardTimeoutMs: number,
  ): Promise<void> {
    return this.enqueueInternal(conversationId, requestId, handler, {
      hardTimeoutMs,
      // Preserve the legacy API: routes currently call applyLatestWins()
      // separately. New callers should use submit() for atomic admission.
      policy: "queue",
    });
  }

  /**
   * Reserve ordering at request arrival, before asynchronous validation.
   * Pass the returned value to submit() once validation succeeds.
   */
  reserveSequence(_conversationId: string): number {
    this.sequenceCounter += 1;
    return this.sequenceCounter;
  }

  /**
   * Atomically applies same-conversation policy, queue pressure, and enqueue.
   * This is the preferred admission API; enqueue()/applyLatestWins() remain for
   * compatibility with the existing route layer.
   */
  submit(
    conversationId: string,
    requestId: string,
    handler: () => Promise<void>,
    options: QueueSubmissionOptions,
  ): Promise<void> {
    this.pruneLatestSubmissionHistory();
    const sequence =
      options.sequence ?? this.reserveSequence(conversationId);
    const policy = options.policy ?? this.getSameConversationPolicy();
    const latest = this.latestSubmissions.get(conversationId);

    if (options.signal?.aborted) {
      return Promise.reject(
        new RequestCancelledError(
          this.createAbortedError(conversationId, requestId),
        ),
      );
    }

    if (
      latest &&
      sequence <= latest.sequence &&
      (policy === "latest-wins" || latest.policy === "latest-wins")
    ) {
      return Promise.reject(
        new RequestCancelledError(
          this.createSupersededError(conversationId, latest.requestId),
        ),
      );
    }

    if (policy === "latest-wins") {
      this.latestSubmissions.set(conversationId, {
        sequence,
        requestId,
        policy,
        updatedAt: this.now(),
      });
      this.clearQueuedRequests(conversationId, requestId);
      this.supersedeActiveRequest(conversationId, requestId);
    }

    const depth = this.getQueueDepth(conversationId);
    const maxQueueDepth = options.maxQueueDepth ?? MAX_QUEUE_DEPTH;
    if (depth >= maxQueueDepth) {
      return Promise.reject(new QueueFullError(conversationId, depth));
    }

    // Queue-policy requests still establish the newest admitted arrival. This
    // prevents an older, slow-to-validate latest-wins request from later
    // cancelling work that arrived and was admitted after it.
    const newestAdmitted = this.latestSubmissions.get(conversationId);
    if (!newestAdmitted || sequence > newestAdmitted.sequence) {
      this.latestSubmissions.set(conversationId, {
        sequence,
        requestId,
        policy,
        updatedAt: this.now(),
      });
    }
    this.pruneLatestSubmissionHistory();

    return this.enqueueInternal(conversationId, requestId, handler, {
      ...options,
      sequence,
      policy,
    });
  }

  private enqueueInternal(
    conversationId: string,
    requestId: string,
    handler: () => Promise<void>,
    options: QueueSubmissionOptions,
  ): Promise<void> {
    if (options.signal?.aborted) {
      return Promise.reject(
        new RequestCancelledError(
          this.createAbortedError(conversationId, requestId),
        ),
      );
    }

    return new Promise<void>((resolve, reject) => {
      let entry = this.conversationQueues.get(conversationId);
      if (!entry) {
        entry = { queue: [], processing: false };
        this.conversationQueues.set(conversationId, entry);
      }

      const queuePosition = entry.queue.length;
      const queueBufferMs = Math.max(60000, queuePosition * 60000);
      const queueTimeoutMs =
        options.queueWaitTimeoutMs ??
        options.hardTimeoutMs + queueBufferMs;

      const item: QueueItem = {
        requestId,
        handler,
        resolve,
        reject,
        enqueuedAt: this.now(),
        abortSignal: options.signal,
        sequence: options.sequence,
      };

      const laterItemIndex =
        options.policy === "queue" && options.sequence !== undefined
          ? entry.queue.findIndex(
              (queued) =>
                queued.sequence !== undefined &&
                queued.sequence > options.sequence!,
            )
          : -1;
      if (laterItemIndex >= 0) {
        entry.queue.splice(laterItemIndex, 0, item);
      } else {
        entry.queue.push(item);
      }
      item.queueTimeout = setTimeout(() => {
        if (!this.removeQueuedItem(conversationId, entry!, item)) return;
        this.writeLog("queue.timeout", {
          conversationId,
          requestId,
          timeoutMs: queueTimeoutMs,
        });
        item.reject(
          new Error(`Queue timeout after ${queueTimeoutMs / 1000}s`),
        );
      }, queueTimeoutMs);

      if (options.signal) {
        item.abortListener = () => {
          if (!this.removeQueuedItem(conversationId, entry!, item)) return;
          item.reject(
            new RequestCancelledError(
              this.createAbortedError(conversationId, requestId),
            ),
          );
        };
        options.signal.addEventListener("abort", item.abortListener, {
          once: true,
        });
      }

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
        policy: options.policy ?? this.getSameConversationPolicy(),
        sequence: options.sequence,
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

  /**
   * Cancel queued or active work by its public request id.
   * Returns false when the request is already terminal or unknown.
   */
  cancelRequest(requestId: string, reason = "cancelled_by_client"): boolean {
    for (const [conversationId, entry] of this.conversationQueues) {
      const queued = entry.queue.find((item) => item.requestId === requestId);
      if (!queued) continue;
      if (!this.removeQueuedItem(conversationId, entry, queued)) return false;
      queued.reject(
        new RequestCancelledError(
          this.createCancelledError(conversationId, requestId, reason),
        ),
      );
      this.writeLog("request.cancel", {
        conversationId,
        requestId,
        reason,
        state: "queued",
      });
      return true;
    }

    for (const [conversationId, active] of this.activeRequests) {
      if (active.requestId !== requestId) continue;
      const error = this.createCancelledError(
        conversationId,
        requestId,
        reason,
      );
      this.writeLog("request.cancel", {
        conversationId,
        requestId,
        reason,
        state: "active",
      });
      if (active.cancel) {
        active.cancel(error);
      } else {
        active.pendingCancel = error;
      }
      return true;
    }
    return false;
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

  getLatestSubmissionHistorySize(): number {
    return this.latestSubmissions.size;
  }

  private pruneLatestSubmissionHistory(): void {
    if (this.latestSubmissions.size === 0) return;
    const cutoff = this.now() - this.latestHistoryTtlMs;
    const isIdle = (conversationId: string): boolean =>
      !this.conversationQueues.has(conversationId) &&
      !this.activeRequests.has(conversationId);

    for (const [conversationId, entry] of this.latestSubmissions) {
      if (entry.updatedAt < cutoff && isIdle(conversationId)) {
        this.latestSubmissions.delete(conversationId);
      }
    }
    const excess = this.latestSubmissions.size - this.latestHistoryLimit;
    if (excess <= 0) return;

    const idleEntries = [...this.latestSubmissions.entries()]
      .filter(([conversationId]) => isIdle(conversationId))
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt);
    for (const [conversationId] of idleEntries.slice(0, excess)) {
      this.latestSubmissions.delete(conversationId);
    }
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
      this.clearQueuedItemWaiters(item);
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

  private clearQueuedItemWaiters(item: QueueItem): void {
    if (item.queueTimeout) {
      clearTimeout(item.queueTimeout);
      item.queueTimeout = undefined;
    }
    if (item.abortSignal && item.abortListener) {
      item.abortSignal.removeEventListener("abort", item.abortListener);
      item.abortListener = undefined;
    }
  }

  private removeQueuedItem(
    conversationId: string,
    entry: QueueEntry,
    item: QueueItem,
  ): boolean {
    const current = this.conversationQueues.get(conversationId);
    if (current !== entry) return false;
    const index = entry.queue.indexOf(item);
    if (index < 0) return false;

    entry.queue.splice(index, 1);
    this.clearQueuedItemWaiters(item);
    if (entry.queue.length === 0) {
      this.cleanupConversationEntry(conversationId);
    }
    // Flush stale ready-list entries and make capacity available immediately.
    this.drainQueues();
    return true;
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

  private createAbortedError(
    conversationId: string,
    requestId: string,
  ): ClaudeProxyError {
    return {
      status: 499,
      type: "invalid_request_error",
      code: "request_cancelled",
      message: `Request '${requestId}' for conversation '${conversationId}' was cancelled before execution.`,
    };
  }

  private createCancelledError(
    conversationId: string,
    requestId: string,
    reason: string,
  ): ClaudeProxyError {
    return {
      status: 409,
      type: "invalid_request_error",
      code: "request_cancelled",
      message: `Request '${requestId}' for conversation '${conversationId}' was cancelled (${reason}).`,
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
      this.clearQueuedItemWaiters(item);
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
