import assert from "node:assert/strict";
import test from "node:test";
import {
  hasIdempotencyPayloadConflict,
  readLastUserText,
} from "./turn-admission.js";

test("readLastUserText normalizes the last multipart user message", () => {
  assert.equal(
    readLastUserText([
      { role: "user", content: "old" },
      { role: "assistant", content: "reply" },
      {
        role: "user",
        content: [{ type: "text", text: "new" }, "question"],
      },
    ]),
    "new\nquestion",
  );
});

test("idempotency replay rejects changed input or response lineage", () => {
  const turn = {
    input: "same input",
    parent_response_id: "resp-parent",
  };
  assert.equal(
    hasIdempotencyPayloadConflict(turn, {
      input: "same input",
      parentResponseId: "resp-parent",
    }),
    false,
  );
  assert.equal(
    hasIdempotencyPayloadConflict(turn, {
      input: "different input",
      parentResponseId: "resp-parent",
    }),
    true,
  );
  assert.equal(
    hasIdempotencyPayloadConflict(turn, {
      input: "same input",
      parentResponseId: "resp-other",
    }),
    true,
  );
});
