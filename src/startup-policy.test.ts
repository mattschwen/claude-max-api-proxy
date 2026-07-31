import assert from "node:assert/strict";
import test from "node:test";
import { shouldFailStartupForMissingClaudeModels } from "./startup-policy.js";

test("required Claude startup fails when no Claude model is accessible", () => {
  assert.equal(shouldFailStartupForMissingClaudeModels(true, 0), true);
  assert.equal(shouldFailStartupForMissingClaudeModels(true, 1), false);
});

test("optional Claude startup can continue without a Claude model", () => {
  assert.equal(shouldFailStartupForMissingClaudeModels(false, 0), false);
});
