import test from "node:test";
import assert from "node:assert/strict";
import {
  chatToResponsesResponse,
  responsesToChatRequest,
} from "./responses.js";

test("responsesToChatRequest converts instructions and input text into chat messages", () => {
  const request = responsesToChatRequest(
    {
      model: "sonnet",
      instructions: "Be concise.",
      input: [
        { type: "input_text", text: "Hello" },
        { role: "assistant", content: "Earlier reply" },
      ],
      reasoning_effort: "high",
    },
    "conv-1",
  );

  assert.equal(request.model, "sonnet");
  assert.equal(request.user, "conv-1");
  assert.equal(request.reasoning_effort, "high");
  assert.deepEqual(request.messages, [
    { role: "developer", content: "Be concise." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Earlier reply" },
  ]);
});

test("chatToResponsesResponse wraps chat completions in a minimal responses payload", () => {
  const response = chatToResponsesResponse(
    {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 123,
      model: "claude-sonnet-4-7",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello back",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
      },
    },
    {
      responseId: "resp_1",
      previousResponseId: "resp_0",
    },
  );

  assert.equal(response.id, "resp_1");
  assert.equal(response.object, "response");
  assert.equal(response.output_text, "Hello back");
  assert.equal(response.previous_response_id, "resp_0");
  assert.deepEqual(response.usage, {
    input_tokens: 5,
    output_tokens: 3,
    total_tokens: 8,
  });
});
