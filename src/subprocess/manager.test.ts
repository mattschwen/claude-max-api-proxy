import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  buildClaudePrompt,
  ClaudeSubprocess,
  getHouseSystemPrompt,
  thinkingBudgetToEffort,
} from "./manager.js";

test("resumed requests fork from the committed session checkpoint", () => {
  const subprocess = new ClaudeSubprocess();
  const { args } = (
    subprocess as unknown as {
      buildArgs(
        prompt: string,
        options: {
          model: string;
          sessionId: string;
          isResume: boolean;
          forkSession: boolean;
        },
      ): { args: string[] };
    }
  ).buildArgs("hello", {
    model: "sonnet",
    sessionId: "committed-parent",
    isResume: true,
    forkSession: true,
  });

  assert.deepEqual(
    args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 3),
    ["--resume", "committed-parent", "--fork-session"],
  );
});

test("waitForExit holds completion until the child close event", async () => {
  const subprocess = new ClaudeSubprocess();
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
  };
  child.exitCode = null;
  (
    subprocess as unknown as {
      process: typeof child;
      closed: boolean;
    }
  ).process = child;

  let resolved = false;
  const waiting = subprocess.waitForExit(100).then(() => {
    resolved = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);

  child.exitCode = 0;
  child.emit("close", 0);
  await waiting;
  assert.equal(resolved, true);
});

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
