import assert from "node:assert/strict";
import test from "node:test";
import { mergeCommittedConversationMessages } from "./conversation-replay.js";

const committed = [
  { role: "user", content: "first", created_at: 1 },
  { role: "assistant", content: "answer", created_at: 2 },
];

test("fresh provider replay prepends history to an incremental request", () => {
  const merged = mergeCommittedConversationMessages(
    {
      model: "local/model",
      messages: [{ role: "user", content: "follow up" }],
    },
    committed,
  );

  assert.deepEqual(merged.messages, [
    { role: "user", content: "first" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "follow up" },
  ]);
});

test("fresh provider replay does not duplicate history a client resent", () => {
  const merged = mergeCommittedConversationMessages(
    {
      model: "local/model",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "follow up" },
      ],
    },
    committed,
  );

  assert.equal(merged.messages.length, 3);
  assert.deepEqual(merged.messages, [
    { role: "user", content: "first" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "follow up" },
  ]);
});

test("fresh provider replay preserves new leading instructions and tail overlap", () => {
  const merged = mergeCommittedConversationMessages(
    {
      model: "local/model",
      messages: [
        { role: "developer", content: "new policy" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "follow up" },
      ],
    },
    committed,
  );

  assert.deepEqual(merged.messages, [
    { role: "developer", content: "new policy" },
    { role: "user", content: "first" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "follow up" },
  ]);
});
