import test from "node:test";
import assert from "node:assert/strict";
import {
  createModelDefinition,
  createModelDefinitionFromProbe,
  getAcceptedClaudeModelSelectors,
  getDefaultModelFamilyOrder,
  getModelDefinitions,
  getModelList,
  isCollisionProneExternalModelId,
  isClaudeModelRequest,
  isExtendedContextModel,
  isValidModel,
  normalizeModelName,
  parseClaudeModelVersion,
  resolveModelFamily,
  supportsAdaptiveReasoningModel,
} from "./models.js";

test("resolveModelFamily handles provider-prefixed and versioned model ids", () => {
  assert.equal(resolveModelFamily("claude-code-cli/claude-haiku-9-1"), "haiku");
  assert.equal(resolveModelFamily("maxproxy/claude-opus-5-0"), "opus");
  assert.equal(
    resolveModelFamily("claude-max-api-proxy/claude-sonnet-4-6"),
    "sonnet",
  );
  assert.equal(resolveModelFamily("sonnet"), "sonnet");
  assert.equal(resolveModelFamily("best"), "opus");
  assert.equal(resolveModelFamily("claude-fable-5-0"), "fable");
  assert.equal(resolveModelFamily("claude-fable-5"), "fable");
  assert.equal(resolveModelFamily("opus[1m]"), "opus");
  assert.equal(resolveModelFamily("claude-sonnet-5[1m]"), "sonnet");
});

test("isValidModel accepts future versioned family ids", () => {
  assert.equal(isValidModel("claude-sonnet-9-9"), true);
  assert.equal(isValidModel("claude-max-api-proxy/claude-opus-42-1"), true);
  assert.equal(isValidModel("fable"), true);
  assert.equal(isValidModel("claude-fable-5-0"), true);
  assert.equal(isValidModel("claude-fable-5"), true);
  assert.equal(isValidModel("best"), true);
  assert.equal(isValidModel("opus[1m]"), true);
  assert.equal(isValidModel("claude-sonnet-5[1m]"), true);
  assert.equal(isValidModel("haiku[1m]"), false);
  assert.equal(isValidModel("default"), true);
  assert.equal(isValidModel("gpt-4.1"), false);
});

test("isClaudeModelRequest keeps omitted and Claude-family selections on the Claude path", () => {
  assert.equal(isClaudeModelRequest(undefined), true);
  assert.equal(isClaudeModelRequest(""), true);
  assert.equal(isClaudeModelRequest("default"), true);
  assert.equal(isClaudeModelRequest("sonnet"), true);
  assert.equal(isClaudeModelRequest("best"), true);
  assert.equal(isClaudeModelRequest("claude-sonnet-4-7"), true);
  assert.equal(isClaudeModelRequest("opus[1m]"), true);
  assert.equal(isClaudeModelRequest("fable"), true);
  assert.equal(isClaudeModelRequest("gemini-3.1-pro-preview"), false);
  assert.equal(isClaudeModelRequest("glm-4.7-flash"), false);
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

test("parseClaudeModelVersion extracts family and resolved model version", () => {
  assert.deepEqual(parseClaudeModelVersion("claude-sonnet-4-7"), {
    family: "sonnet",
    major: 4,
    minor: 7,
  });
  assert.equal(parseClaudeModelVersion("sonnet"), null);
  assert.deepEqual(parseClaudeModelVersion("claude-fable-5-0"), {
    family: "fable",
    major: 5,
    minor: 0,
  });
  assert.deepEqual(parseClaudeModelVersion("claude-fable-5"), {
    family: "fable",
    major: 5,
    minor: 0,
  });
  assert.deepEqual(parseClaudeModelVersion("claude-sonnet-5[1m]"), {
    family: "sonnet",
    major: 5,
    minor: 0,
  });
});

test("supportsAdaptiveReasoningModel enables supported Sonnet, Opus, and Fable versions", () => {
  assert.equal(supportsAdaptiveReasoningModel("claude-sonnet-4-7"), true);
  assert.equal(supportsAdaptiveReasoningModel("claude-opus-4-6"), true);
  assert.equal(supportsAdaptiveReasoningModel("claude-sonnet-4-5"), false);
  assert.equal(supportsAdaptiveReasoningModel("claude-haiku-4-7"), false);
  assert.equal(supportsAdaptiveReasoningModel("claude-fable-5-0"), true);
  assert.equal(supportsAdaptiveReasoningModel("claude-fable-5"), true);
  assert.equal(supportsAdaptiveReasoningModel("claude-sonnet-5"), true);
  assert.equal(supportsAdaptiveReasoningModel("claude-opus-5[1m]"), true);
});

test("extended-context selectors are detected without changing their family", () => {
  assert.equal(isExtendedContextModel("opus[1m]"), true);
  assert.equal(
    isExtendedContextModel("maxproxy/claude-sonnet-5[1m]"),
    true,
  );
  assert.equal(isExtendedContextModel("opus"), false);
  assert.equal(isExtendedContextModel("claude-haiku-4-5"), false);
});

test("future Claude families remain valid and routable after a successful probe", () => {
  const definition = createModelDefinitionFromProbe(
    "default",
    "claude-nova-1-0",
  );

  assert.equal(isValidModel("claude-nova-1-0"), true);
  assert.equal(resolveModelFamily("claude-nova-1-0"), "nova");
  assert.equal(resolveModelFamily("claude-nova-latest"), "nova");
  assert.deepEqual(definition, {
    id: "claude-nova-1-0",
    family: "nova",
    alias: "default",
    timeoutMs: 180000,
    stallTimeoutMs: 90000,
  });
});

test("default family order includes Fable before Haiku", () => {
  assert.deepEqual(getDefaultModelFamilyOrder(), [
    "sonnet",
    "opus",
    "fable",
    "haiku",
  ]);
});

test("runtime probes the account-tier default before family selectors", () => {
  assert.deepEqual(
    getModelDefinitions().map((definition) => definition.alias),
    ["default", "sonnet", "opus", "fable", "haiku"],
  );
});

test("accepted selectors expose aliases and account-gated context variants", () => {
  assert.deepEqual(getAcceptedClaudeModelSelectors(), [
    "default",
    "sonnet",
    "opus",
    "best",
    "fable",
    "haiku",
    "sonnet[1m]",
    "opus[1m]",
  ]);
});

test("external model collision checks allow provider-qualified IDs only", () => {
  assert.equal(isCollisionProneExternalModelId("sonnet"), true);
  assert.equal(
    isCollisionProneExternalModelId("claude-sonnet-4-7"),
    true,
  );
  assert.equal(
    isCollisionProneExternalModelId("openrouter/anthropic/claude-sonnet-4-7"),
    false,
  );
});
