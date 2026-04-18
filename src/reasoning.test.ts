import test from "node:test";
import assert from "node:assert/strict";
import {
  REASONING_EFFORT_MAP,
  parseEffortOrTokens,
  resolveReasoningConfig,
  thinkingBudgetToEffort,
} from "./reasoning.js";

test("parseEffortOrTokens accepts effort labels and integers", () => {
  assert.equal(parseEffortOrTokens("medium"), REASONING_EFFORT_MAP.medium);
  assert.equal(parseEffortOrTokens("32000"), 32000);
  assert.equal(parseEffortOrTokens("invalid"), undefined);
});

test("resolveReasoningConfig keeps fixed-budget reasoning on older models", () => {
  const config = resolveReasoningConfig({
    body: {
      thinking: { type: "enabled", budget_tokens: 10000 },
    },
    resolvedModel: "claude-haiku-4-5",
    cliVersion: "claude 2.1.112",
  });

  assert.equal(config.active, true);
  assert.equal(config.mode, "fixed");
  assert.equal(config.budgetTokens, 10000);
  assert.equal(config.effort, undefined);
});

test("resolveReasoningConfig normalizes compatible adaptive models to effort mode", () => {
  const config = resolveReasoningConfig({
    body: {
      reasoning_effort: "high",
    },
    resolvedModel: "claude-sonnet-4-7",
    cliVersion: "claude 2.1.112",
  });

  assert.equal(config.active, true);
  assert.equal(config.mode, "adaptive");
  assert.equal(config.effort, "high");
  assert.equal(config.requiresCliUpgrade, false);
});

test("resolveReasoningConfig flags adaptive models when the CLI is too old", () => {
  const config = resolveReasoningConfig({
    body: {
      reasoning: { mode: "adaptive", effort: "medium" },
    },
    resolvedModel: "claude-opus-4-7",
    cliVersion: "claude 2.1.110",
  });

  assert.equal(config.active, true);
  assert.equal(config.mode, "adaptive");
  assert.equal(config.requiresCliUpgrade, true);
});

test("thinkingBudgetToEffort maps larger budgets to the nearest CLI effort tier", () => {
  assert.equal(thinkingBudgetToEffort(40000, false), "max");
  assert.equal(thinkingBudgetToEffort(40000, true), "xhigh");
  assert.equal(thinkingBudgetToEffort(10000, true), "medium");
});
