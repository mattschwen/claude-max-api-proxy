import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudePrompt,
  getHouseSystemPrompt,
  thinkingBudgetToEffort,
} from "./manager.js";

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

test("buildClaudePrompt places the house prompt before the request prompt", () => {
  assert.equal(
    buildClaudePrompt("Hello", "Request rules", "House rules"),
    "<instructions>\nHouse rules\n\nRequest rules\n</instructions>\n\nHello",
  );
  assert.equal(buildClaudePrompt("Hello", undefined, ""), "Hello");
});

test("getHouseSystemPrompt reads and refreshes prompt files", () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-proxy-prompt-"));
  const promptFile = join(directory, "house.md");
  try {
    writeFileSync(promptFile, "  First prompt  \n");
    assert.equal(getHouseSystemPrompt(promptFile), "First prompt");

    writeFileSync(promptFile, "Second prompt with a different size");
    const refreshedAt = new Date(Date.now() + 2000);
    utimesSync(promptFile, refreshedAt, refreshedAt);
    assert.equal(
      getHouseSystemPrompt(promptFile),
      "Second prompt with a different size",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
