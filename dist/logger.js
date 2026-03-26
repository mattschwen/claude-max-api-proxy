/**
 * Structured JSON Logger
 *
 * Emits structured log entries for key proxy events.
 * All entries include timestamp and event type.
 */
function emit(entry) {
    console.log(JSON.stringify(entry));
}
export function log(event, fields = {}) {
    emit({ ts: new Date().toISOString(), event, ...fields });
}
export function logError(event, error, fields = {}) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ ts: new Date().toISOString(), event, reason: message, ...fields });
}
//# sourceMappingURL=logger.js.map