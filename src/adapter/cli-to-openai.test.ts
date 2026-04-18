import test from "node:test";
import assert from "node:assert/strict";
import { cliResultToOpenai } from "./cli-to-openai.js";
import type { ClaudeCliResult } from "../types/claude-cli.js";

function makeResult(): ClaudeCliResult {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: "OK",
    session_id: "session-1",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  };
}

test("cliResultToOpenai uses the caller fallback model when modelUsage is empty", () => {
  const response = cliResultToOpenai(
    makeResult(),
    "req-1",
    "claude-sonnet-4-7",
  );

  assert.equal(response.model, "claude-sonnet-4-7");
});

test("cliResultToOpenai strips provider prefixes without pinning model versions", () => {
  const result = makeResult();
  result.modelUsage = {
    "claude-max-api-proxy/claude-opus-4-7": {
      inputTokens: 1,
      outputTokens: 1,
      costUSD: 0,
    },
  };

  const response = cliResultToOpenai(result, "req-2");

  assert.equal(response.model, "claude-opus-4-7");
});
