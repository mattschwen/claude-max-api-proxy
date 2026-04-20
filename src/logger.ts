/**
 * Structured JSON Logger
 *
 * Emits structured log entries for key proxy events.
 * All entries include timestamp and event type.
 */
import fs from "node:fs";
import path from "node:path";

export type LogEvent =
  | "request.start"
  | "request.cancel"
  | "request.complete"
  | "request.retry"
  | "request.timeout"
  | "request.error"
  | "subprocess.spawn"
  | "subprocess.stall"
  | "subprocess.kill"
  | "subprocess.close"
  | "session.invalidate"
  | "session.resume_fail"
  | "session.created"
  | "session.context"
  | "token.validation_failed"
  | "queue.enqueue"
  | "queue.drop"
  | "queue.blocked"
  | "queue.timeout"
  | "health.check"
  | "server.shutdown"
  | "server.start"
  | "admin.thinking_budget.set"
  | "admin.thinking_budget.cleared"
  | "auth.proactive_refresh"
  | "auth.failure"
  | "auth.recovered"
  | "cli.error"
  | "pool.warmed"
  | "pool.warm_failed";

export interface LogEntry {
  ts: string;
  event: LogEvent;
  conversationId?: string;
  requestId?: string;
  model?: string;
  pid?: number;
  durationMs?: number;
  reason?: string;
  [key: string]: unknown;
}

type LogListener = (entry: LogEntry) => void;

const listeners = new Set<LogListener>();
const LOG_FILE =
  typeof process.env.CLAUDE_PROXY_LOG_FILE === "string" &&
    process.env.CLAUDE_PROXY_LOG_FILE.trim()
    ? process.env.CLAUDE_PROXY_LOG_FILE.trim()
    : null;
let fileStream: fs.WriteStream | null = null;

function getFileStream(): fs.WriteStream | null {
  if (!LOG_FILE) return null;
  if (fileStream) return fileStream;

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fileStream = fs.createWriteStream(LOG_FILE, {
      flags: "a",
      encoding: "utf8",
    });
    fileStream.on("error", (error) => {
      console.error("[Logger File Error]:", error);
      fileStream = null;
    });
  } catch (error) {
    console.error("[Logger File Init Error]:", error);
    fileStream = null;
  }

  return fileStream;
}

function emit(entry: LogEntry): void {
  const line = JSON.stringify(entry);
  console.log(line);
  getFileStream()?.write(`${line}\n`);
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch (err) {
      console.error("[Logger Listener Error]:", err);
    }
  }
}

export function log(
  event: LogEvent,
  fields: Omit<LogEntry, "ts" | "event"> = {},
): void {
  emit({ ts: new Date().toISOString(), event, ...fields });
}

export function logError(
  event: LogEvent,
  error: unknown,
  fields: Omit<LogEntry, "ts" | "event"> = {},
): void {
  const message = error instanceof Error ? error.message : String(error);
  emit({ ts: new Date().toISOString(), event, reason: message, ...fields });
}

export function subscribeToLogs(listener: LogListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
