import { subscribeToLogs, type LogEntry } from "../logger.js";

export interface OpsLogBufferOptions {
  maxEntries?: number;
  autoSubscribe?: boolean;
}

type OpsLogListener = (entry: LogEntry) => void;

export class OpsLogBuffer {
  private readonly entries: LogEntry[] = [];
  private readonly listeners = new Set<OpsLogListener>();
  private readonly maxEntries: number;
  private readonly unsubscribe?: () => void;

  constructor(options: OpsLogBufferOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 400);
    if (options.autoSubscribe !== false) {
      this.unsubscribe = subscribeToLogs((entry) => {
        this.ingest(entry);
      });
    }
  }

  ingest(entry: LogEntry): void {
    this.entries.push(entry);
    const overflow = this.entries.length - this.maxEntries;
    if (overflow > 0) {
      this.entries.splice(0, overflow);
    }

    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (error) {
        console.error("[OpsLogBuffer] Listener error:", error);
      }
    }
  }

  getEntries(limit = this.maxEntries): LogEntry[] {
    const safeLimit = Math.max(0, Math.floor(limit));
    if (safeLimit === 0) return [];
    return this.entries.slice(-safeLimit);
  }

  subscribe(listener: OpsLogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.unsubscribe?.();
    this.listeners.clear();
    this.entries.length = 0;
  }
}

export const opsLogBuffer = new OpsLogBuffer();
