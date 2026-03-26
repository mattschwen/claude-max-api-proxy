/**
 * Structured JSON Logger
 *
 * Emits structured log entries for key proxy events.
 * All entries include timestamp and event type.
 */
export type LogEvent = "request.start" | "request.complete" | "request.retry" | "request.timeout" | "request.error" | "subprocess.spawn" | "subprocess.stall" | "subprocess.kill" | "subprocess.close" | "session.invalidate" | "session.resume_fail" | "session.created" | "queue.enqueue" | "queue.blocked" | "queue.timeout" | "health.check" | "server.shutdown" | "server.start";
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
export declare function log(event: LogEvent, fields?: Omit<LogEntry, "ts" | "event">): void;
export declare function logError(event: LogEvent, error: unknown, fields?: Omit<LogEntry, "ts" | "event">): void;
//# sourceMappingURL=logger.d.ts.map