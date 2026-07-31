export interface ResponseConversationEntry {
  conversationId: string;
  createdAt: number;
}

interface ResponseConversationStoreOptions {
  ttlMs?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
  autoCleanup?: boolean;
  initialEntries?: Iterable<[string, ResponseConversationEntry]>;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export class ResponseConversationStore {
  private readonly entries = new Map<string, ResponseConversationEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ResponseConversationStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    if (options.initialEntries) {
      this.restore(options.initialEntries);
    }

    if (options.autoCleanup !== false) {
      this.cleanupTimer = setInterval(() => {
        this.cleanup();
      }, options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS);
      if (typeof this.cleanupTimer.unref === "function") {
        this.cleanupTimer.unref();
      }
    }
  }

  remember(responseId: string, conversationId: string): void {
    this.entries.set(responseId, {
      conversationId,
      createdAt: this.now(),
    });
  }

  get(previousResponseId: string | undefined): string | undefined {
    if (!previousResponseId) return undefined;
    const entry = this.entries.get(previousResponseId);
    if (entry && entry.createdAt < this.now() - this.ttlMs) {
      this.entries.delete(previousResponseId);
      return undefined;
    }
    return entry?.conversationId;
  }

  /**
   * Return a persistence-safe snapshot. Callers can store this in their durable
   * state layer and provide it back through initialEntries after restart.
   */
  snapshot(): Array<[string, ResponseConversationEntry]> {
    this.cleanup();
    return Array.from(this.entries, ([responseId, entry]) => [
      responseId,
      { ...entry },
    ]);
  }

  restore(entries: Iterable<[string, ResponseConversationEntry]>): number {
    const cutoff = this.now() - this.ttlMs;
    let restored = 0;
    for (const [responseId, entry] of entries) {
      if (
        !responseId ||
        !entry?.conversationId ||
        !Number.isFinite(entry.createdAt) ||
        entry.createdAt < cutoff
      ) {
        continue;
      }
      this.entries.set(responseId, { ...entry });
      restored += 1;
    }
    return restored;
  }

  cleanup(): number {
    const cutoff = this.now() - this.ttlMs;
    let removed = 0;
    for (const [responseId, entry] of this.entries) {
      if (entry.createdAt < cutoff) {
        this.entries.delete(responseId);
        removed += 1;
      }
    }
    return removed;
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export const responseConversationStore = new ResponseConversationStore();
