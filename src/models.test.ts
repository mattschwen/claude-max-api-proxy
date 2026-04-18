import test from "node:test";
import assert from "node:assert/strict";
import {
  createModelDefinition,
  getModelList,
  isValidModel,
  normalizeModelName,
  resolveModelFamily,
} from "./models.js";

test("resolveModelFamily handles provider-prefixed and versioned model ids", () => {
  assert.equal(resolveModelFamily("claude-code-cli/claude-haiku-9-1"), "haiku");
  assert.equal(resolveModelFamily("maxproxy/claude-opus-5-0"), "opus");
  assert.equal(
    resolveModelFamily("claude-max-api-proxy/claude-sonnet-4-6"),
    "sonnet",
  );
  assert.equal(resolveModelFamily("sonnet"), "sonnet");
});

test("isValidModel accepts future versioned family ids", () => {
  assert.equal(isValidModel("claude-sonnet-9-9"), true);
  assert.equal(isValidModel("claude-max-api-proxy/claude-opus-42-1"), true);
  assert.equal(isValidModel("gpt-4.1"), false);
});

test("normalizeModelName strips provider prefixes and preserves resolved ids", () => {
  assert.equal(
    normalizeModelName("claude-max-api-proxy/claude-sonnet-4-7"),
    "claude-sonnet-4-7",
  );
  assert.equal(normalizeModelName(""), "sonnet");
});

test("getModelList can render a filtered model list", () => {
  const models = getModelList([
    createModelDefinition("sonnet", "claude-sonnet-4-7"),
  ]);
  assert.deepEqual(models.map((model) => model.id), ["claude-sonnet-4-7"]);
});
