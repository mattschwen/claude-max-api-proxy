/**
 * Session Manager
 *
 * Maps conversation IDs to Claude CLI session IDs for maintaining context
 * across requests.
 *
 * Phase 3b: Session resume failure tracking — auto-invalidate after consecutive failures
 * Phase 5d: Track session context size for token counting
 */
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { log } from "../logger.js";

const SESSION_FILE =
  process.env.SESSION_FILE ||
  path.join(process.env.HOME || "/tmp", ".claude-code-cli-sessions.json");
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TASKS_PER_SESSION = 50;
const MAX_RESUME_FAILURES = 2;

export interface SessionMapping {
  clawdbotId: string;
  claudeSessionId: string;
  createdAt: number;
  lastUsedAt: number;
  model: string;
  taskCount?: number;
  /** Consecutive resume failure count */
  resumeFailures?: number;
}

export interface SessionManagerOptions {
  sessionFile?: string;
  now?: () => number;
}

export class SessionManager {
  private sessions = new Map<string, SessionMapping>();
  /**
   * Fresh --session-id values are attempt-local until Claude returns a
   * successful result. They must never be visible as resumable or persisted.
   */
  private provisionalSessions = new Map<string, SessionMapping>();
  private loaded = false;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loadPromise: Promise<void> | null = null;
  private writePromise: Promise<void> | null = null;
  private revision = 0;
  private savedRevision = 0;
  private readonly sessionFile: string;
  private readonly now: () => number;

  constructor(options: SessionManagerOptions = {}) {
    this.sessionFile = options.sessionFile ?? SESSION_FILE;
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        const data = await fs.readFile(this.sessionFile, "utf-8");
        const parsed = JSON.parse(data) as Record<string, SessionMapping>;
        // Requests may arrive while the async file read is in flight. Preserve
        // those newer in-memory mappings instead of replacing them on load.
        this.sessions = new Map([
          ...Object.entries(parsed),
          ...this.sessions.entries(),
        ]);
        console.log(`[SessionManager] Loaded ${this.sessions.size} sessions`);
      } catch {
        // Missing/corrupt state starts empty, while still preserving any
        // mappings created during the failed read.
      } finally {
        this.loaded = true;
      }
    })();

    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  saveSync(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      // Advance the revision so an in-flight async write cannot publish an
      // older snapshot after this synchronous shutdown flush.
      this.revision += 1;
      const targetRevision = this.revision;
      const data = Object.fromEntries(this.sessions);
      fsSync.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
      const tempFile =
        `${this.sessionFile}.${process.pid}.${targetRevision}.sync.tmp`;
      fsSync.writeFileSync(tempFile, JSON.stringify(data, null, 2));
      fsSync.renameSync(tempFile, this.sessionFile);
      this.savedRevision = targetRevision;
      this.dirty = false;
    } catch (err) {
      console.error("[SessionManager] Sync save error:", err);
    }
  }

  private scheduleSave(): void {
    this.revision += 1;
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.dirty) return;
      void this.flush().catch((err) => {
        console.error("[SessionManager] Async save error:", err);
      });
    }, 1000);
  }

  async save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    await this.load();
    if (this.writePromise) {
      await this.writePromise;
      if (this.savedRevision < this.revision) {
        await this.flush();
      }
      return;
    }

    const operation = (async () => {
      do {
        const targetRevision = this.revision;
        const data = JSON.stringify(Object.fromEntries(this.sessions), null, 2);
        await fs.mkdir(path.dirname(this.sessionFile), { recursive: true });
        const tempFile =
          `${this.sessionFile}.${process.pid}.${targetRevision}.tmp`;
        try {
          await fs.writeFile(tempFile, data);
          // A synchronous shutdown flush may have published a newer revision
          // while this file was being written. Never let this stale snapshot
          // overwrite it.
          if (targetRevision < this.revision) {
            await fs.unlink(tempFile).catch(() => {});
            continue;
          }
          // Keep the revision check and atomic rename in the same event-loop
          // turn so saveSync() cannot interleave between them.
          fsSync.renameSync(tempFile, this.sessionFile);
        } catch (error) {
          await fs.unlink(tempFile).catch(() => {});
          throw error;
        }
        this.savedRevision = targetRevision;
      } while (this.savedRevision < this.revision);
      this.dirty = false;
    })();
    this.writePromise = operation;
    try {
      await operation;
    } finally {
      if (this.writePromise === operation) {
        this.writePromise = null;
      }
    }
  }

  /**
   * Get or create a Claude session ID for a conversation.
   * Returns { sessionId, isResume } so callers know whether to use --resume.
   */
  getOrCreate(
    clawdbotId: string,
    model = "sonnet",
  ): { sessionId: string; isResume: boolean } {
    const existing = this.sessions.get(clawdbotId);
    if (existing) {
      const ageMs = this.now() - existing.lastUsedAt;
      const MAX_RESUME_AGE_MS = 6 * 60 * 60 * 1000;

      if (ageMs > MAX_RESUME_AGE_MS) {
        console.log(
          `[SessionManager] Session ${clawdbotId} stale (${Math.round(ageMs / 3600000)}h), creating fresh`,
        );
        this.sessions.delete(clawdbotId);
        this.scheduleSave();
      } else {
        if ((existing.taskCount || 0) >= MAX_TASKS_PER_SESSION) {
          console.log(
            `[SessionManager] Session ${clawdbotId} hit task limit (${existing.taskCount || 0}), resetting`,
          );
          this.sessions.delete(clawdbotId);
          this.scheduleSave();
        } else {
          return { sessionId: existing.claudeSessionId, isResume: true };
        }
      }
    }

    const claudeSessionId = uuidv4();
    const mapping: SessionMapping = {
      clawdbotId,
      claudeSessionId,
      createdAt: this.now(),
      lastUsedAt: this.now(),
      model,
      taskCount: 0,
      resumeFailures: 0,
    };
    this.provisionalSessions.set(clawdbotId, mapping);
    log("session.provisional", {
      conversationId: clawdbotId,
      sessionId: claudeSessionId.slice(0, 8),
    });
    return { sessionId: claudeSessionId, isResume: false };
  }

  get(clawdbotId: string): SessionMapping | undefined {
    return this.sessions.get(clawdbotId);
  }

  /**
   * Promote a successfully completed CLI/fork session to the conversation
   * head. Callers should never invoke this for cancelled or failed attempts.
   */
  commitSession(
    clawdbotId: string,
    claudeSessionId: string,
    model: string,
  ): void {
    const existing = this.sessions.get(clawdbotId);
    const provisional = this.provisionalSessions.get(clawdbotId);
    const now = this.now();
    this.provisionalSessions.delete(clawdbotId);
    this.sessions.set(clawdbotId, {
      clawdbotId,
      claudeSessionId,
      createdAt: existing?.createdAt ?? provisional?.createdAt ?? now,
      lastUsedAt: now,
      model,
      taskCount: (existing?.taskCount ?? 0) + 1,
      resumeFailures: 0,
    });
    this.scheduleSave();
  }

  delete(clawdbotId: string): boolean {
    const deletedCommitted = this.sessions.delete(clawdbotId);
    const deletedProvisional = this.provisionalSessions.delete(clawdbotId);
    if (deletedCommitted || deletedProvisional) {
      log("session.invalidate", { conversationId: clawdbotId });
    }
    if (deletedCommitted) {
      this.scheduleSave();
    }
    return deletedCommitted || deletedProvisional;
  }

  /**
   * Discard only a failed fresh attempt, preserving any separately committed
   * checkpoint that may still be the valid conversation head.
   */
  discardProvisional(
    clawdbotId: string,
    claudeSessionId?: string,
  ): boolean {
    const provisional = this.provisionalSessions.get(clawdbotId);
    if (
      !provisional ||
      (claudeSessionId &&
        provisional.claudeSessionId !== claudeSessionId)
    ) {
      return false;
    }
    this.provisionalSessions.delete(clawdbotId);
    log("session.provisional_discard", {
      conversationId: clawdbotId,
      sessionId: provisional.claudeSessionId.slice(0, 8),
    });
    return true;
  }

  /**
   * Mark a session as having a resume failure.
   * After MAX_RESUME_FAILURES consecutive failures, auto-invalidate the session.
   */
  markFailed(clawdbotId: string): void {
    const existing = this.sessions.get(clawdbotId);
    if (!existing) return;

    existing.resumeFailures = (existing.resumeFailures || 0) + 1;
    log("session.resume_fail", {
      conversationId: clawdbotId,
      failures: existing.resumeFailures,
    });

    if (existing.resumeFailures >= MAX_RESUME_FAILURES) {
      log("session.invalidate", {
        conversationId: clawdbotId,
        reason: `${existing.resumeFailures} consecutive resume failures`,
      });
      this.sessions.delete(clawdbotId);
    }
    this.scheduleSave();
  }

  /**
   * Reset failure count on successful resume.
   */
  markSuccess(clawdbotId: string): void {
    const existing = this.sessions.get(clawdbotId);
    if (existing && existing.resumeFailures) {
      existing.resumeFailures = 0;
      this.scheduleSave();
    }
  }

  /**
   * Get resume failure stats for health endpoint.
   */
  getFailureStats(): { totalFailures: number; sessionsWithFailures: number } {
    let totalFailures = 0;
    let sessionsWithFailures = 0;
    for (const [, session] of this.sessions) {
      if (session.resumeFailures && session.resumeFailures > 0) {
        totalFailures += session.resumeFailures;
        sessionsWithFailures++;
      }
    }
    return { totalFailures, sessionsWithFailures };
  }

  cleanup(): number {
    const cutoff = this.now() - SESSION_TTL_MS;
    let removed = 0;
    for (const [key, session] of this.sessions) {
      if (session.lastUsedAt < cutoff) {
        this.sessions.delete(key);
        removed++;
      }
    }
    for (const [key, session] of this.provisionalSessions) {
      if (session.lastUsedAt < cutoff) {
        this.provisionalSessions.delete(key);
      }
    }
    if (removed > 0) {
      console.log(`[SessionManager] Cleaned up ${removed} expired sessions`);
      this.scheduleSave();
    }
    return removed;
  }

  getAll(): SessionMapping[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Phase 5d: Get estimated context size (in tokens) for a session.
   * Estimates based on task count * avg tokens per task.
   * Rough estimate: ~1000 tokens per prior exchange (Q&A pair).
   */
  getContextSizeEstimate(clawdbotId: string): number {
    const session = this.sessions.get(clawdbotId);
    if (!session || !session.taskCount) return 0;
    const AVG_TOKENS_PER_TASK = 1000;
    return Math.max(0, (session.taskCount - 1) * AVG_TOKENS_PER_TASK);
  }

  get size(): number {
    return this.sessions.size;
  }
}

export const sessionManager = new SessionManager();

sessionManager
  .load()
  .catch((err) => console.error("[SessionManager] Load error:", err));

const sessionCleanupTimer = setInterval(
  () => {
    sessionManager.cleanup();
  },
  60 * 60 * 1000,
);

if (typeof sessionCleanupTimer.unref === "function") {
  sessionCleanupTimer.unref();
}
