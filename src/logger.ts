/**
 * Structured JSON Logger
 *
 * Emits structured log entries for key proxy events.
 * All entries include timestamp and event type.
 */

export type LogEvent =
  | "request.start"
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
  | "queue.enqueue"
  | "queue.blocked"
  | "queue.timeout"
  | "health.check"
  | "server.shutdown"
  | "server.start";

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

function emit(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}

export function log(event: LogEvent, fields: Omit<LogEntry, "ts" | "event"> = {}): void {
  emit({ ts: new Date().toISOString(), event, ...fields });
}

export function logError(event: LogEvent, error: unknown, fields: Omit<LogEntry, "ts" | "event"> = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  emit({ ts: new Date().toISOString(), event, reason: message, ...fields });
}
