/**
 * Session Manager
 *
 * Maps Clawdbot conversation IDs to Claude CLI session IDs
 * for maintaining conversation context across requests.
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

class SessionManager {
  private sessions = new Map<string, SessionMapping>();
  private loaded = false;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await fs.readFile(SESSION_FILE, "utf-8");
      const parsed = JSON.parse(data) as Record<string, SessionMapping>;
      this.sessions = new Map(Object.entries(parsed));
      this.loaded = true;
      console.log(`[SessionManager] Loaded ${this.sessions.size} sessions`);
    } catch {
      this.sessions = new Map();
      this.loaded = true;
    }
  }

  saveSync(): void {
    try {
      const data = Object.fromEntries(this.sessions);
      fsSync.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
      this.dirty = false;
    } catch (err) {
      console.error("[SessionManager] Sync save error:", err);
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      if (!this.dirty) return;
      try {
        const data = Object.fromEntries(this.sessions);
        await fs.writeFile(SESSION_FILE, JSON.stringify(data, null, 2));
        this.dirty = false;
      } catch (err) {
        console.error("[SessionManager] Async save error:", err);
      }
    }, 1000);
  }

  async save(): Promise<void> {
    this.scheduleSave();
  }

  /**
   * Get or create a Claude session ID for a Clawdbot conversation.
   * Returns { sessionId, isResume } so callers know whether to use --resume.
   */
  getOrCreate(
    clawdbotId: string,
    model = "sonnet",
  ): { sessionId: string; isResume: boolean } {
    const existing = this.sessions.get(clawdbotId);
    if (existing) {
      const ageMs = Date.now() - existing.lastUsedAt;
      const MAX_RESUME_AGE_MS = 6 * 60 * 60 * 1000;

      if (ageMs > MAX_RESUME_AGE_MS) {
        console.log(
          `[SessionManager] Session ${clawdbotId} stale (${Math.round(ageMs / 3600000)}h), creating fresh`,
        );
        this.sessions.delete(clawdbotId);
      } else {
        existing.taskCount = (existing.taskCount || 0) + 1;
        if (existing.taskCount > MAX_TASKS_PER_SESSION) {
          console.log(
            `[SessionManager] Session ${clawdbotId} hit task limit (${existing.taskCount}), resetting`,
          );
          this.sessions.delete(clawdbotId);
        } else {
          existing.lastUsedAt = Date.now();
          existing.model = model;
          this.scheduleSave();
          return { sessionId: existing.claudeSessionId, isResume: true };
        }
      }
    }

    const claudeSessionId = uuidv4();
    const mapping: SessionMapping = {
      clawdbotId,
      claudeSessionId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      model,
      taskCount: 0,
      resumeFailures: 0,
    };
    this.sessions.set(clawdbotId, mapping);
    log("session.created", {
      conversationId: clawdbotId,
      sessionId: claudeSessionId.slice(0, 8),
    });
    this.scheduleSave();
    return { sessionId: claudeSessionId, isResume: false };
  }

  get(clawdbotId: string): SessionMapping | undefined {
    return this.sessions.get(clawdbotId);
  }

  delete(clawdbotId: string): boolean {
    const deleted = this.sessions.delete(clawdbotId);
    if (deleted) {
      log("session.invalidate", { conversationId: clawdbotId });
      this.scheduleSave();
    }
    return deleted;
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
    const cutoff = Date.now() - SESSION_TTL_MS;
    let removed = 0;
    for (const [key, session] of this.sessions) {
      if (session.lastUsedAt < cutoff) {
        this.sessions.delete(key);
        removed++;
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

setInterval(
  () => {
    sessionManager.cleanup();
  },
  60 * 60 * 1000,
);
