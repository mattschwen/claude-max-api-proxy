import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type SessionMapping } from "./manager.js";

test("SessionManager load preserves mappings created while disk state is loading", async () => {
  const directory = mkdtempSync(join(tmpdir(), "proxy-sessions-"));
  const sessionFile = join(directory, "sessions.json");
  const persisted: SessionMapping = {
    clawdbotId: "persisted",
    claudeSessionId: "session-persisted",
    createdAt: 1,
    lastUsedAt: 1,
    model: "sonnet",
  };
  writeFileSync(sessionFile, JSON.stringify({ persisted }));

  try {
    const manager = new SessionManager({
      sessionFile,
      now: () => 100,
    });
    const loading = manager.load();
    const created = manager.getOrCreate("created-during-load", "opus");
    manager.commitSession(
      "created-during-load",
      created.sessionId,
      "opus",
    );

    await loading;

    assert.equal(manager.get("persisted")?.claudeSessionId, "session-persisted");
    assert.equal(
      manager.get("created-during-load")?.claudeSessionId,
      created.sessionId,
    );

    await manager.save();
    const saved = JSON.parse(readFileSync(sessionFile, "utf8")) as Record<
      string,
      SessionMapping
    >;
    assert.deepEqual(Object.keys(saved).sort(), [
      "created-during-load",
      "persisted",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SessionManager never exposes or persists a fresh session before success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "proxy-sessions-"));
  const sessionFile = join(directory, "sessions.json");

  try {
    const manager = new SessionManager({ sessionFile, now: () => 100 });
    const provisional = manager.getOrCreate("conversation", "sonnet");

    assert.equal(provisional.isResume, false);
    assert.equal(manager.get("conversation"), undefined);
    assert.equal(manager.size, 0);

    await manager.save();
    const beforeCommit = JSON.parse(
      readFileSync(sessionFile, "utf8"),
    ) as Record<string, SessionMapping>;
    assert.equal(beforeCommit.conversation, undefined);

    manager.commitSession(
      "conversation",
      provisional.sessionId,
      "sonnet",
    );
    assert.equal(
      manager.get("conversation")?.claudeSessionId,
      provisional.sessionId,
    );

    await manager.save();
    const afterCommit = JSON.parse(
      readFileSync(sessionFile, "utf8"),
    ) as Record<string, SessionMapping>;
    assert.equal(
      afterCommit.conversation.claudeSessionId,
      provisional.sessionId,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SessionManager discards a failed provisional without making it resumable", () => {
  const manager = new SessionManager({
    sessionFile: join(tmpdir(), "unused-session-test.json"),
    now: () => 100,
  });
  const failed = manager.getOrCreate("conversation", "sonnet");

  assert.equal(
    manager.discardProvisional("conversation", failed.sessionId),
    true,
  );
  assert.equal(manager.get("conversation"), undefined);
  const retry = manager.getOrCreate("conversation", "sonnet");
  assert.equal(retry.isResume, false);
  assert.notEqual(retry.sessionId, failed.sessionId);
});

test("SessionManager serializes rapid mutations into one complete atomic snapshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "proxy-sessions-"));
  const sessionFile = join(directory, "nested", "sessions.json");

  try {
    const manager = new SessionManager({ sessionFile });
    manager.getOrCreate("conversation-a", "sonnet");
    manager.getOrCreate("conversation-b", "opus");
    manager.delete("conversation-a");
    manager.commitSession("conversation-b", "forked-session", "fable");

    await manager.save();

    const saved = JSON.parse(readFileSync(sessionFile, "utf8")) as Record<
      string,
      SessionMapping
    >;
    assert.equal(saved["conversation-a"], undefined);
    assert.equal(
      saved["conversation-b"].claudeSessionId,
      "forked-session",
    );
    assert.equal(saved["conversation-b"].model, "fable");
    assert.equal(saved["conversation-b"].resumeFailures, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SessionManager commitSession promotes only the explicit completed session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "proxy-sessions-"));
  const sessionFile = join(directory, "sessions.json");

  try {
    let now = 10;
    const manager = new SessionManager({
      sessionFile,
      now: () => now,
    });
    const original = manager.getOrCreate("conversation", "sonnet");
    now = 20;
    manager.commitSession("conversation", "completed-child", "opus");

    const mapping = manager.get("conversation");
    assert.equal(mapping?.claudeSessionId, "completed-child");
    assert.equal(mapping?.model, "opus");
    assert.equal(mapping?.createdAt, 10);
    assert.equal(mapping?.lastUsedAt, 20);
    assert.notEqual(mapping?.claudeSessionId, original.sessionId);

    await manager.save();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
