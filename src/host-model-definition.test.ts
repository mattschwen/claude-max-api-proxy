import assert from "node:assert/strict";
import test from "node:test";
import { buildHostModelDefinition } from "./host-model-definition.js";

test("buildHostModelDefinition preserves known model names and reasoning", () => {
  const definition = buildHostModelDefinition({
    id: "claude-sonnet-4-7",
    family: "sonnet",
    alias: "sonnet",
    timeoutMs: 600000,
    stallTimeoutMs: 90000,
  });

  assert.equal(definition.name, "Claude Sonnet");
  assert.equal(definition.reasoning, true);
});

test("buildHostModelDefinition labels future Claude families without calling them Sonnet", () => {
  const definition = buildHostModelDefinition({
    id: "claude-nova-code-1-0",
    family: "nova-code",
    alias: "default",
    timeoutMs: 180000,
    stallTimeoutMs: 90000,
  });

  assert.equal(definition.name, "Claude Nova Code");
  assert.equal(definition.reasoning, true);
});
