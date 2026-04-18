import test from "node:test";
import assert from "node:assert/strict";
import { thinkingBudgetToEffort } from "./manager.js";

test("thinkingBudgetToEffort falls back to max when xhigh is unsupported", () => {
  assert.equal(thinkingBudgetToEffort(40000, false), "max");
});

test("thinkingBudgetToEffort uses xhigh when the CLI supports it", () => {
  assert.equal(thinkingBudgetToEffort(40000, true), "xhigh");
});

test("thinkingBudgetToEffort preserves lower effort tiers", () => {
  assert.equal(thinkingBudgetToEffort(5000, false), "low");
  assert.equal(thinkingBudgetToEffort(10000, false), "medium");
  assert.equal(thinkingBudgetToEffort(32000, false), "high");
  assert.equal(thinkingBudgetToEffort(64000, true), "max");
});
