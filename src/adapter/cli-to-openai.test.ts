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

test("cliResultToOpenai reports the served model, not an auxiliary one", () => {
  // Claude Code bills auxiliary work to a cheaper model alongside the real
  // turn, and lists it first in modelUsage. Taking key[0] reported haiku for
  // every request regardless of the model actually asked for.
  const result = makeResult();
  result.modelUsage = {
    "claude-haiku-4-5-20251001": { inputTokens: 525, outputTokens: 12, costUSD: 0 },
    "claude-sonnet-5": { inputTokens: 2, outputTokens: 9, costUSD: 0 },
  };

  const response = cliResultToOpenai(result, "req-aux", "sonnet");

  // The auxiliary entry is both first and larger, so this only passes if the
  // requested family actually decides the winner.
  assert.equal(response.model, "claude-sonnet-5");
});

test("cliResultToOpenai uses the assistant event for a cross-family fallback", () => {
  // The auxiliary model can produce more output than the real turn, so token
  // counts cannot reliably identify which model served the response.
  const result = makeResult();
  result.modelUsage = {
    "claude-haiku-4-5-20251001": {
      inputTokens: 525,
      outputTokens: 120,
      costUSD: 0,
    },
    "claude-sonnet-4-6": { inputTokens: 40, outputTokens: 9, costUSD: 0 },
  };

  const response = cliResultToOpenai(
    result,
    "req-fallback",
    "opus",
    "claude-sonnet-4-6",
  );

  assert.equal(response.model, "claude-sonnet-4-6");
});

test("cliResultToOpenai does not guess from usage when no model evidence exists", () => {
  const result = makeResult();
  result.modelUsage = {
    "claude-haiku-4-5-20251001": {
      inputTokens: 525,
      outputTokens: 120,
      costUSD: 0,
    },
    "claude-sonnet-4-6": { inputTokens: 40, outputTokens: 9, costUSD: 0 },
  };

  const response = cliResultToOpenai(result, "req-unknown", "opus");

  assert.equal(response.model, "opus");
});
