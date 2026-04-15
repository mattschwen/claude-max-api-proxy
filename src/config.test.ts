import test from "node:test";
import assert from "node:assert/strict";
import { parseSameConversationPolicy, readRuntimeConfig } from "./config.js";

test("parseSameConversationPolicy defaults to latest-wins", () => {
  assert.equal(parseSameConversationPolicy(undefined), "latest-wins");
  assert.equal(parseSameConversationPolicy("invalid"), "latest-wins");
});

test("parseSameConversationPolicy accepts queue", () => {
  assert.equal(parseSameConversationPolicy("queue"), "queue");
});

test("readRuntimeConfig parses booleans", () => {
  const config = readRuntimeConfig({
    CLAUDE_PROXY_SAME_CONVERSATION_POLICY: "queue",
    CLAUDE_PROXY_DEBUG_QUEUES: "true",
    CLAUDE_PROXY_ENABLE_ADMIN_API: "true",
  }, undefined);

  assert.deepEqual(config, {
    sameConversationPolicy: "queue",
    debugQueues: true,
    enableAdminApi: true,
    defaultThinkingBudget: undefined,
  });
});

test("readRuntimeConfig reads default thinking budget", () => {
  const config = readRuntimeConfig({
    DEFAULT_THINKING_BUDGET: "high",
  }, undefined);

  assert.deepEqual(config, {
    sameConversationPolicy: "latest-wins",
    debugQueues: false,
    enableAdminApi: false,
    defaultThinkingBudget: "high",
  });
});

test("readRuntimeConfig prefers persisted thinking budget over env", () => {
  const config = readRuntimeConfig(
    {
      DEFAULT_THINKING_BUDGET: "high",
    },
    "low",
  );

  assert.deepEqual(config, {
    sameConversationPolicy: "latest-wins",
    debugQueues: false,
    enableAdminApi: false,
    defaultThinkingBudget: "low",
  });
});
