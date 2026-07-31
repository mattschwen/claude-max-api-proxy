/**
 * SQLite-backed Conversation Store
 *
 * Persists full message history per conversation independently of Claude CLI sessions.
 */
import { DatabaseSync } from "node:sqlite";
import path from "path";

const DB_PATH =
  process.env.DB_PATH ||
  path.join(process.env.HOME || "/tmp", ".claude-proxy-conversations.db");

interface MetricParams {
  conversationId?: string;
  durationMs?: number;
  success?: boolean;
  error?: string;
  clientDisconnected?: boolean;
}

export interface ConversationMessageRecord {
  role: string;
  content: string;
  created_at: number;
}

export interface RecentConversationSummary {
  id: string;
  created_at: number;
  updated_at: number;
  model: string | null;
  session_id: string | null;
  message_count: number;
  last_role: string | null;
  last_content: string | null;
  last_message_at: number | null;
}

export type TurnStatus =
  | "queued"
  | "running"
  | "completed"
  | "superseded"
  | "cancelled"
  | "failed"
  | "timed_out";

export interface TurnRecord {
  request_id: string;
  conversation_id: string;
  response_id: string | null;
  parent_response_id: string | null;
  status: TurnStatus;
  model: string | null;
  provider: string | null;
  input: string | null;
  output: string | null;
  session_id: string | null;
  idempotency_key: string | null;
  checkpoint_messages: string | null;
  terminal_reason: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface BeginTurnParams {
  requestId: string;
  conversationId: string;
  parentResponseId?: string;
  model?: string;
  provider?: string;
  input?: string;
  idempotencyKey?: string;
}

export interface ResponseCheckpointMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string | Array<{ type?: string; text?: string } | string>;
}

export class ConversationStore {
  private db: DatabaseSync | null = null;
  private readonly dbPath: string;

  constructor(dbPath = DB_PATH) {
    this.dbPath = dbPath;
  }

  init(): void {
    if (this.db) return;
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (this.dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        model TEXT,
        session_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT,
        event TEXT NOT NULL,
        duration_ms INTEGER,
        success INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_event ON metrics(event);
      CREATE INDEX IF NOT EXISTS idx_metrics_time ON metrics(created_at);
      CREATE TABLE IF NOT EXISTS turns (
        request_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        response_id TEXT UNIQUE,
        parent_response_id TEXT,
        status TEXT NOT NULL,
        model TEXT,
        provider TEXT,
        input TEXT,
        output TEXT,
        session_id TEXT,
        idempotency_key TEXT,
        checkpoint_messages TEXT,
        terminal_reason TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );
      CREATE INDEX IF NOT EXISTS idx_turns_conversation
        ON turns(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_turns_response
        ON turns(response_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_idempotency
        ON turns(conversation_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
    const columns = this.db.prepare("PRAGMA table_info(conversations)").all() as
      Array<{ name: string }>;
    if (!columns.some((column) => column.name === "revision")) {
      this.db.exec(
        "ALTER TABLE conversations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
      );
    }
    const turnColumns = this.db.prepare("PRAGMA table_info(turns)").all() as
      Array<{ name: string }>;
    if (!turnColumns.some((column) => column.name === "checkpoint_messages")) {
      this.db.exec("ALTER TABLE turns ADD COLUMN checkpoint_messages TEXT");
    }
    console.log(`[ConversationStore] Initialized at ${this.dbPath}`);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  ensureConversation(
    conversationId: string,
    model?: string,
    sessionId?: string,
  ): void {
    this.init();
    const now = Date.now();
    this.db!.prepare(
      `INSERT INTO conversations
         (id, created_at, updated_at, model, session_id, revision)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET
         updated_at = excluded.updated_at,
         model = COALESCE(excluded.model, conversations.model),
         session_id = COALESCE(excluded.session_id, conversations.session_id),
         revision = conversations.revision + 1`,
    ).run(
      conversationId,
      now,
      now,
      model || null,
      sessionId || null,
    );
  }

  addMessage(conversationId: string, role: string, content: string): void {
    this.init();
    const now = Date.now();
    this.db!.exec("BEGIN IMMEDIATE");
    try {
      this.db!.prepare(
        "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
      ).run(conversationId, role, content, now);
      this.db!.prepare(
        "UPDATE conversations SET updated_at = ?, revision = revision + 1 WHERE id = ?",
      ).run(now, conversationId);
      this.db!.exec("COMMIT");
    } catch (error) {
      this.db!.exec("ROLLBACK");
      throw error;
    }
  }

  beginTurn(params: BeginTurnParams): {
    created: boolean;
    turn: TurnRecord;
  } {
    this.init();
    this.ensureConversation(
      params.conversationId,
      params.model,
      undefined,
    );

    if (params.idempotencyKey) {
      const existing = this.getTurnByIdempotencyKey(
        params.conversationId,
        params.idempotencyKey,
      );
      if (existing) {
        return { created: false, turn: existing };
      }
    }

    const now = Date.now();
    this.db!.prepare(
      `INSERT INTO turns
         (request_id, conversation_id, parent_response_id, status, model,
          provider, input, idempotency_key, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    ).run(
      params.requestId,
      params.conversationId,
      params.parentResponseId || null,
      params.model || null,
      params.provider || null,
      params.input ?? null,
      params.idempotencyKey || null,
      now,
    );
    return {
      created: true,
      turn: this.getTurn(params.requestId)!,
    };
  }

  markTurnRunning(requestId: string): boolean {
    this.init();
    return this.db!.prepare(
      `UPDATE turns
       SET status = 'running', started_at = COALESCE(started_at, ?)
       WHERE request_id = ? AND status = 'queued'`,
    ).run(Date.now(), requestId).changes > 0;
  }

  finishTurn(
    requestId: string,
    status: Exclude<TurnStatus, "queued" | "running">,
    options: {
      output?: string;
      responseId?: string;
      sessionId?: string;
      reason?: string;
      model?: string;
      clearSession?: boolean;
      persistInputMessage?: boolean;
      persistAssistantMessage?: boolean;
    } = {},
  ): boolean {
    this.init();
    const turn = this.getTurn(requestId);
    if (!turn || !["queued", "running"].includes(turn.status)) {
      return false;
    }
    const now = Date.now();
    this.db!.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.db!.prepare(
        `UPDATE turns
         SET status = ?, output = COALESCE(?, output),
             response_id = COALESCE(?, response_id),
             session_id = COALESCE(?, session_id),
             model = COALESCE(?, model),
             terminal_reason = ?, completed_at = ?
         WHERE request_id = ? AND status IN ('queued', 'running')`,
      ).run(
        status,
        options.output ?? null,
        options.responseId ?? null,
        options.sessionId ?? null,
        options.model ?? null,
        options.reason ?? null,
        now,
        requestId,
      );
      if (
        updated.changes > 0 &&
        status === "completed" &&
        options.persistInputMessage &&
        turn.input !== null
      ) {
        this.db!.prepare(
          "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', ?, ?)",
        ).run(turn.conversation_id, turn.input, now);
      }
      if (
        updated.changes > 0 &&
        status === "completed" &&
        options.persistAssistantMessage &&
        options.output !== undefined
      ) {
        this.db!.prepare(
          "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)",
        ).run(turn.conversation_id, options.output, now);
      }
      if (updated.changes > 0) {
        this.db!.prepare(
          `UPDATE conversations
           SET updated_at = ?, revision = revision + 1,
               model = COALESCE(?, model),
               session_id = CASE
                 WHEN ? = 'completed' AND ? = 1 THEN NULL
                 WHEN ? = 'completed' THEN COALESCE(?, session_id)
                 ELSE session_id
               END
           WHERE id = ?`,
        ).run(
          now,
          options.model ?? null,
          status,
          options.clearSession ? 1 : 0,
          status,
          options.sessionId ?? null,
          turn.conversation_id,
        );
      }
      this.db!.exec("COMMIT");
      return updated.changes > 0;
    } catch (error) {
      this.db!.exec("ROLLBACK");
      throw error;
    }
  }

  rememberTurnResponse(
    requestId: string,
    responseId: string,
    parentResponseId?: string,
    checkpointMessages?: ResponseCheckpointMessage[],
  ): boolean {
    this.init();
    return this.db!.prepare(
      `UPDATE turns
       SET response_id = COALESCE(response_id, ?),
           parent_response_id = COALESCE(parent_response_id, ?),
           checkpoint_messages = COALESCE(checkpoint_messages, ?)
       WHERE request_id = ?`,
    ).run(
      responseId,
      parentResponseId || null,
      checkpointMessages ? JSON.stringify(checkpointMessages) : null,
      requestId,
    ).changes > 0;
  }

  getTurn(requestId: string): TurnRecord | undefined {
    this.init();
    return this.db!.prepare(
      "SELECT * FROM turns WHERE request_id = ?",
    ).get(requestId) as unknown as TurnRecord | undefined;
  }

  getTurnByResponseId(responseId: string): TurnRecord | undefined {
    this.init();
    return this.db!.prepare(
      "SELECT * FROM turns WHERE response_id = ?",
    ).get(responseId) as unknown as TurnRecord | undefined;
  }

  /**
   * Return the exact message snapshot captured when a Responses API node was
   * published. The snapshot is immutable (COALESCE on write), so retries cannot
   * move an existing response checkpoint to a newer conversation head.
   */
  getResponseCheckpoint(
    responseId: string,
  ): ResponseCheckpointMessage[] | undefined {
    const serialized = this.getTurnByResponseId(responseId)?.checkpoint_messages;
    if (!serialized) return undefined;
    try {
      const parsed = JSON.parse(serialized) as unknown;
      if (!Array.isArray(parsed)) return undefined;
      const messages = parsed.filter(
        (message): message is ResponseCheckpointMessage =>
          Boolean(
            message &&
            typeof message === "object" &&
            "role" in message &&
            typeof message.role === "string" &&
            ["system", "developer", "user", "assistant"].includes(
              message.role,
            ) &&
            "content" in message &&
            (typeof message.content === "string" ||
              Array.isArray(message.content)),
          ),
      );
      return messages.length === parsed.length ? messages : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Reconstruct a response branch from durable parent_response_id links.
   * This is a compatibility fallback for response rows created before exact
   * checkpoint snapshots were introduced.
   */
  getResponseLineage(responseId: string, maxDepth = 1024): TurnRecord[] {
    const reverse: TurnRecord[] = [];
    const visited = new Set<string>();
    let current = this.getTurnByResponseId(responseId);
    while (current && reverse.length < maxDepth) {
      const identity = current.response_id || current.request_id;
      if (visited.has(identity)) break;
      visited.add(identity);
      reverse.push(current);
      current = current.parent_response_id
        ? this.getTurnByResponseId(current.parent_response_id)
        : undefined;
    }
    return reverse.reverse();
  }

  getTurnByIdempotencyKey(
    conversationId: string,
    idempotencyKey: string,
  ): TurnRecord | undefined {
    this.init();
    return this.db!.prepare(
      `SELECT * FROM turns
       WHERE conversation_id = ? AND idempotency_key = ?`,
    ).get(conversationId, idempotencyKey) as unknown as TurnRecord | undefined;
  }

  getMessages(
    conversationId: string,
  ): ConversationMessageRecord[] {
    this.init();
    return this.db!.prepare(
      "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC",
    ).all(conversationId) as unknown as ConversationMessageRecord[];
  }

  getRecentMessages(
    conversationId: string,
    limit = 12,
  ): ConversationMessageRecord[] {
    this.init();
    return (
      this.db!.prepare(
        "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
      ).all(conversationId, limit) as unknown as ConversationMessageRecord[]
    ).reverse();
  }

  getConversation(conversationId: string): Record<string, unknown> | undefined {
    this.init();
    return this.db!.prepare("SELECT * FROM conversations WHERE id = ?").get(
      conversationId,
    ) as Record<string, unknown> | undefined;
  }

  recordMetric(event: string, params: MetricParams = {}): void {
    this.init();
    this.db!.prepare(
      "INSERT INTO metrics (conversation_id, event, duration_ms, success, error, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      params.conversationId || null,
      event,
      params.durationMs ?? null,
      params.success === undefined ? null : params.success ? 1 : 0,
      params.error || null,
      Date.now(),
    );
  }

  getHealthMetrics(minutesBack = 60): Array<Record<string, unknown>> {
    this.init();
    const cutoff = Date.now() - minutesBack * 60 * 1000;
    return this.db!.prepare(
      `
      SELECT
        event,
        COUNT(*) as count,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
        AVG(duration_ms) as avg_duration_ms,
        MIN(duration_ms) as min_duration_ms,
        MAX(duration_ms) as max_duration_ms
      FROM metrics
      WHERE created_at > ?
      GROUP BY event
    `,
    ).all(cutoff) as Array<Record<string, unknown>>;
  }

  getRecentErrors(limit = 10): Array<Record<string, unknown>> {
    this.init();
    return this.db!.prepare(
      "SELECT * FROM metrics WHERE success = 0 AND error IS NOT NULL ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as Array<Record<string, unknown>>;
  }

  cleanup(daysOld = 7): number {
    this.init();
    const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
    const convIds = (
      this.db!.prepare("SELECT id FROM conversations WHERE updated_at < ?").all(
        cutoff,
      ) as Array<{ id: string }>
    ).map((r) => r.id);
    if (convIds.length === 0) return 0;
    const placeholders = convIds.map(() => "?").join(",");
    this.db!.prepare(
      `DELETE FROM turns WHERE conversation_id IN (${placeholders})`,
    ).run(...convIds);
    this.db!.prepare(
      `DELETE FROM messages WHERE conversation_id IN (${placeholders})`,
    ).run(...convIds);
    this.db!.prepare(
      `DELETE FROM conversations WHERE id IN (${placeholders})`,
    ).run(...convIds);
    this.db!.prepare("DELETE FROM metrics WHERE created_at < ?").run(cutoff);
    console.log(
      `[ConversationStore] Cleaned up ${convIds.length} old conversations`,
    );
    return convIds.length;
  }

  getStats(): { conversations: number; messages: number; metrics: number } {
    this.init();
    const convCount = (
      this.db!.prepare("SELECT COUNT(*) as c FROM conversations").get() as {
        c: number;
      }
    ).c;
    const msgCount = (
      this.db!.prepare("SELECT COUNT(*) as c FROM messages").get() as {
        c: number;
      }
    ).c;
    const metricCount = (
      this.db!.prepare("SELECT COUNT(*) as c FROM metrics").get() as {
        c: number;
      }
    ).c;
    return {
      conversations: convCount,
      messages: msgCount,
      metrics: metricCount,
    };
  }

  getRecentConversations(limit = 12): RecentConversationSummary[] {
    this.init();
    return this.db!.prepare(
      `
      SELECT
        c.id,
        c.created_at,
        c.updated_at,
        c.model,
        c.session_id,
        COUNT(m.id) AS message_count,
        (
          SELECT role
          FROM messages
          WHERE conversation_id = c.id
          ORDER BY id DESC
          LIMIT 1
        ) AS last_role,
        (
          SELECT content
          FROM messages
          WHERE conversation_id = c.id
          ORDER BY id DESC
          LIMIT 1
        ) AS last_content,
        (
          SELECT created_at
          FROM messages
          WHERE conversation_id = c.id
          ORDER BY id DESC
          LIMIT 1
        ) AS last_message_at
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC
      LIMIT ?
    `,
    ).all(limit) as unknown as RecentConversationSummary[];
  }
}

export const conversationStore = new ConversationStore();

const conversationCleanupTimer = setInterval(
  () => {
    try {
      conversationStore.cleanup();
    } catch (e) {
      console.error("[ConversationStore] Cleanup error:", e);
    }
  },
  6 * 60 * 60 * 1000,
);

if (typeof conversationCleanupTimer.unref === "function") {
  conversationCleanupTimer.unref();
}
