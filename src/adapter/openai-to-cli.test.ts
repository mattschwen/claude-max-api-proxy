import test from "node:test";
import assert from "node:assert/strict";
import { openaiToCli } from "./openai-to-cli.js";

test("openaiToCli uses explicit CLI model override", () => {
  const cliInput = openaiToCli({
    model: "claude-sonnet-4",
    messages: [{ role: "user", content: "Hello" }],
  }, false, "claude-sonnet-4-5");

  assert.equal(cliInput.model, "claude-sonnet-4-5");
  assert.equal(cliInput.prompt, "Hello");
});

test("openaiToCli resume mode keeps only the last user message", () => {
  const cliInput = openaiToCli({
    model: "claude-sonnet-4",
    user: "conv-1",
    messages: [
      { role: "user", content: "First" },
      { role: "assistant", content: "Answer" },
      { role: "user", content: "Second" },
    ],
  }, true, "claude-sonnet-4-5");

  assert.equal(cliInput.model, "claude-sonnet-4-5");
  assert.equal(cliInput.prompt, "Second");
  assert.equal(cliInput.systemPrompt, undefined);
});

test("openaiToCli defaults to the sonnet alias when no model is provided", () => {
  const cliInput = openaiToCli({
    model: "",
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.equal(cliInput.model, "sonnet");
});
