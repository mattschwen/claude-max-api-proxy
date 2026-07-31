import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationStore } from "./conversation.js";

test("messages and model changes advance the conversation revision", () => {
  const store = new ConversationStore(":memory:");
  try {
    store.ensureConversation("thread-1", "sonnet", "session-1");
    const initial = store.getConversation("thread-1") as {
      revision: number;
      model: string;
    };

    store.addMessage("thread-1", "user", "hello");
    store.ensureConversation("thread-1", "opus", "session-2");

    const updated = store.getConversation("thread-1") as {
      revision: number;
      model: string;
      session_id: string;
    };
    assert.ok(updated.revision > initial.revision);
    assert.equal(updated.model, "opus");
    assert.equal(updated.session_id, "session-2");
    assert.equal(store.getMessages("thread-1").length, 1);
  } finally {
    store.close();
  }
});

test("turn lifecycle is terminal and idempotency keys resolve existing work", () => {
  const store = new ConversationStore(":memory:");
  try {
    const first = store.beginTurn({
      requestId: "request-1",
      conversationId: "thread-1",
      model: "sonnet",
      provider: "claude-cli",
      input: "hello",
      idempotencyKey: "retry-key",
    });
    assert.equal(first.created, true);
    assert.equal(first.turn.status, "queued");
    assert.equal(store.markTurnRunning("request-1"), true);

    const duplicate = store.beginTurn({
      requestId: "request-2",
      conversationId: "thread-1",
      idempotencyKey: "retry-key",
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.turn.request_id, "request-1");

    assert.equal(
      store.finishTurn("request-1", "completed", {
        output: "world",
        responseId: "resp-1",
        sessionId: "session-child",
        model: "claude-sonnet-4-6",
        persistAssistantMessage: true,
      }),
      true,
    );
    assert.equal(
      store.finishTurn("request-1", "cancelled", { reason: "late cancel" }),
      false,
    );

    assert.equal(
      store.getTurnByResponseId("resp-1")?.session_id,
      "session-child",
    );
    assert.deepEqual(
      store.getMessages("thread-1").map((message) => message.content),
      ["world"],
    );
  } finally {
    store.close();
  }
});

test("cancelled turns never advance the committed conversation session", () => {
  const store = new ConversationStore(":memory:");
  try {
    store.ensureConversation("thread-1", "sonnet", "committed-parent");
    store.beginTurn({
      requestId: "request-1",
      conversationId: "thread-1",
      model: "opus",
    });
    store.markTurnRunning("request-1");
    store.finishTurn("request-1", "superseded", {
      sessionId: "discarded-child",
      reason: "newer request",
      model: "opus",
    });

    const conversation = store.getConversation("thread-1") as {
      session_id: string;
      model: string;
    };
    assert.equal(conversation.session_id, "committed-parent");
    assert.equal(conversation.model, "opus");
  } finally {
    store.close();
  }
});

test("only completed turns publish their input/output pair to transcript history", () => {
  const store = new ConversationStore(":memory:");
  try {
    store.beginTurn({
      requestId: "cancelled-request",
      conversationId: "thread-1",
      input: "discard this prompt",
    });
    store.markTurnRunning("cancelled-request");
    store.finishTurn("cancelled-request", "cancelled", {
      output: "discard this partial answer",
      persistInputMessage: true,
      persistAssistantMessage: true,
    });
    assert.deepEqual(store.getMessages("thread-1"), []);

    store.beginTurn({
      requestId: "completed-request",
      conversationId: "thread-1",
      input: "keep this prompt",
    });
    store.markTurnRunning("completed-request");
    store.finishTurn("completed-request", "completed", {
      output: "keep this answer",
      persistInputMessage: true,
      persistAssistantMessage: true,
    });
    assert.deepEqual(
      store.getMessages("thread-1").map(({ role, content }) => ({
        role,
        content,
      })),
      [
        { role: "user", content: "keep this prompt" },
        { role: "assistant", content: "keep this answer" },
      ],
    );
  } finally {
    store.close();
  }
});

test("response checkpoints survive a store restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "proxy-turn-store-"));
  const dbPath = join(directory, "turns.db");
  try {
    const writer = new ConversationStore(dbPath);
    writer.beginTurn({
      requestId: "request-1",
      conversationId: "thread-1",
      model: "sonnet",
    });
    writer.markTurnRunning("request-1");
    writer.finishTurn("request-1", "completed", {
      output: "persisted",
      sessionId: "checkpoint-1",
    });
    writer.rememberTurnResponse("request-1", "resp-1");
    writer.rememberTurnResponse("request-1", "resp-retry");
    writer.close();

    const reader = new ConversationStore(dbPath);
    assert.deepEqual(
      {
        conversation: reader.getTurnByResponseId("resp-1")?.conversation_id,
        session: reader.getTurnByResponseId("resp-1")?.session_id,
        output: reader.getTurnByResponseId("resp-1")?.output,
      },
      {
        conversation: "thread-1",
        session: "checkpoint-1",
        output: "persisted",
      },
    );
    reader.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("response checkpoints are immutable and replay an exact historical branch", () => {
  const store = new ConversationStore(":memory:");
  try {
    store.beginTurn({
      requestId: "root-request",
      conversationId: "thread-1",
      input: "root question",
    });
    store.markTurnRunning("root-request");
    store.finishTurn("root-request", "completed", {
      output: "root answer",
    });
    store.rememberTurnResponse("root-request", "resp-root", undefined, [
      { role: "developer", content: "root instructions" },
      { role: "user", content: "root question" },
      { role: "assistant", content: "root answer" },
    ]);

    store.beginTurn({
      requestId: "child-request",
      conversationId: "thread-1",
      parentResponseId: "resp-root",
      input: "child question",
    });
    store.markTurnRunning("child-request");
    store.finishTurn("child-request", "completed", {
      output: "child answer",
    });
    store.rememberTurnResponse("child-request", "resp-child", "resp-root", [
      { role: "developer", content: "root instructions" },
      { role: "user", content: "root question" },
      { role: "assistant", content: "root answer" },
      { role: "user", content: "child question" },
      { role: "assistant", content: "child answer" },
    ]);

    // A retry cannot replace an already-published response snapshot.
    store.rememberTurnResponse("root-request", "resp-other", undefined, [
      { role: "user", content: "incorrect newer head" },
    ]);

    assert.deepEqual(store.getResponseCheckpoint("resp-root"), [
      { role: "developer", content: "root instructions" },
      { role: "user", content: "root question" },
      { role: "assistant", content: "root answer" },
    ]);
    assert.deepEqual(
      store
        .getResponseLineage("resp-child")
        .map((turn) => turn.response_id),
      ["resp-root", "resp-child"],
    );
  } finally {
    store.close();
  }
});

test("a completed external turn atomically clears an incompatible session head", () => {
  const store = new ConversationStore(":memory:");
  try {
    store.ensureConversation("thread-1", "sonnet", "claude-session");
    store.beginTurn({
      requestId: "external-request",
      conversationId: "thread-1",
      provider: "external",
      input: "switch providers",
    });
    store.markTurnRunning("external-request");
    store.finishTurn("external-request", "completed", {
      output: "",
      clearSession: true,
      persistInputMessage: true,
      persistAssistantMessage: true,
    });

    const conversation = store.getConversation("thread-1") as {
      session_id: string | null;
    };
    assert.equal(conversation.session_id, null);
    assert.deepEqual(
      store.getMessages("thread-1").map(({ role, content }) => ({
        role,
        content,
      })),
      [
        { role: "user", content: "switch providers" },
        { role: "assistant", content: "" },
      ],
    );
  } finally {
    store.close();
  }
});
