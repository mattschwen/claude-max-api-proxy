import assert from "node:assert/strict";
import test from "node:test";
import type { LogEntry } from "../logger.js";
import { OpsLogBuffer } from "./ops-log-buffer.js";

test("OpsLogBuffer trims to its ring size and fans out live entries", () => {
  const buffer = new OpsLogBuffer({ maxEntries: 2, autoSubscribe: false });
  const seen: LogEntry[] = [];
  const unsubscribe = buffer.subscribe((entry) => {
    seen.push(entry);
  });

  buffer.ingest({ ts: "2026-04-20T00:00:00.000Z", event: "request.start" });
  buffer.ingest({ ts: "2026-04-20T00:00:01.000Z", event: "queue.enqueue" });
  buffer.ingest({ ts: "2026-04-20T00:00:02.000Z", event: "request.complete" });

  assert.deepEqual(
    buffer.getEntries().map((entry) => entry.event),
    ["queue.enqueue", "request.complete"],
  );
  assert.deepEqual(
    seen.map((entry) => entry.event),
    ["request.start", "queue.enqueue", "request.complete"],
  );

  unsubscribe();
  buffer.dispose();
});
