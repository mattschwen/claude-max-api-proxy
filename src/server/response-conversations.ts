export interface ResponseConversationEntry {
  conversationId: string;
  createdAt: number;
}

interface ResponseConversationStoreOptions {
  ttlMs?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
  autoCleanup?: boolean;
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
    return entry?.conversationId;
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
