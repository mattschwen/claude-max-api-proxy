import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GEMINI_CLI_MODEL,
  DEFAULT_GEMINI_FALLBACK_MODEL,
  DEFAULT_ZAI_FALLBACK_MODEL,
  GEMINI_OPENAI_BASE_URL,
  ZAI_CODING_OPENAI_BASE_URL,
  ZAI_OPENAI_BASE_URL,
  parseExternalFallbackConfig,
  parseGeminiCliFallbackConfig,
  parseSameConversationPolicy,
  readRuntimeConfig,
} from "./config.js";

test("parseSameConversationPolicy defaults to latest-wins", () => {
  assert.equal(parseSameConversationPolicy(undefined), "latest-wins");
  assert.equal(parseSameConversationPolicy("invalid"), "latest-wins");
});

test("parseSameConversationPolicy accepts queue", () => {
  assert.equal(parseSameConversationPolicy("queue"), "queue");
});

test("readRuntimeConfig parses booleans", () => {
  const config = readRuntimeConfig({
    CLAUDE_PROXY_SAME_CONVERSATION_POLICY: "queue",
    CLAUDE_PROXY_DEBUG_QUEUES: "true",
    CLAUDE_PROXY_ENABLE_ADMIN_API: "true",
  }, undefined);

  assert.deepEqual(config, {
    sameConversationPolicy: "queue",
    debugQueues: true,
    enableAdminApi: true,
    defaultThinkingBudget: undefined,
    defaultAgent: undefined,
    maxConcurrentRequests: config.maxConcurrentRequests,
    modelFallbacks: [],
    geminiCliFallback: null,
    externalFallback: null,
  });
  assert.ok(config.maxConcurrentRequests >= 1);
});

test("readRuntimeConfig reads default thinking budget", () => {
  const config = readRuntimeConfig({
    DEFAULT_THINKING_BUDGET: "high",
  }, undefined);

  assert.deepEqual(config, {
    sameConversationPolicy: "latest-wins",
    debugQueues: false,
    enableAdminApi: false,
    defaultThinkingBudget: "high",
    defaultAgent: undefined,
    maxConcurrentRequests: config.maxConcurrentRequests,
    modelFallbacks: [],
    geminiCliFallback: null,
    externalFallback: null,
  });
  assert.ok(config.maxConcurrentRequests >= 1);
});

test("readRuntimeConfig prefers persisted thinking budget over env", () => {
  const config = readRuntimeConfig(
    {
      DEFAULT_THINKING_BUDGET: "high",
    },
    "low",
  );

  assert.deepEqual(config, {
    sameConversationPolicy: "latest-wins",
    debugQueues: false,
    enableAdminApi: false,
    defaultThinkingBudget: "low",
    defaultAgent: undefined,
    maxConcurrentRequests: config.maxConcurrentRequests,
    modelFallbacks: [],
    geminiCliFallback: null,
    externalFallback: null,
  });
  assert.ok(config.maxConcurrentRequests >= 1);
});

test("readRuntimeConfig reads default expert agent", () => {
  const config = readRuntimeConfig(
    {
      CLAUDE_PROXY_DEFAULT_AGENT: "expert-coder",
    },
    undefined,
  );

  assert.deepEqual(config, {
    sameConversationPolicy: "latest-wins",
    debugQueues: false,
    enableAdminApi: false,
    defaultThinkingBudget: undefined,
    defaultAgent: "expert-coder",
    maxConcurrentRequests: config.maxConcurrentRequests,
    modelFallbacks: [],
    geminiCliFallback: null,
    externalFallback: null,
  });
  assert.ok(config.maxConcurrentRequests >= 1);
});

test("readRuntimeConfig reads max concurrent requests override", () => {
  const config = readRuntimeConfig(
    {
      CLAUDE_PROXY_MAX_CONCURRENT_REQUESTS: "7",
    },
    undefined,
  );

  assert.equal(config.maxConcurrentRequests, 7);
  assert.deepEqual(config.modelFallbacks, []);
});

test("readRuntimeConfig parses fallback model aliases", () => {
  const config = readRuntimeConfig(
    {
      CLAUDE_PROXY_MODEL_FALLBACKS: "default, haiku,default , sonnet",
    },
    undefined,
  );

  assert.deepEqual(config.modelFallbacks, ["default", "haiku", "sonnet"]);
});

test("parseGeminiCliFallbackConfig enables local Gemini CLI with defaults", () => {
  const fallback = parseGeminiCliFallbackConfig({
    GEMINI_CLI_ENABLED: "true",
  });

  assert.deepEqual(fallback, {
    provider: "gemini-cli",
    command: "gemini",
    model: DEFAULT_GEMINI_CLI_MODEL,
    extraModels: [],
    workdir: fallback?.workdir,
    streamMode: "passthrough",
  });
  assert.ok(fallback?.workdir);
});

test("parseGeminiCliFallbackConfig supports extra advertised models", () => {
  const fallback = parseGeminiCliFallbackConfig({
    GEMINI_CLI_MODEL: "gemini-2.5-pro",
    GEMINI_CLI_EXTRA_MODELS: "gemini-2.5-flash, gemini-2.5-pro",
    GEMINI_CLI_COMMAND: "/opt/homebrew/bin/gemini",
    GEMINI_CLI_WORKDIR: "/tmp/gemini-proxy",
    GEMINI_CLI_STREAM_MODE: "synthetic",
  });

  assert.deepEqual(fallback, {
    provider: "gemini-cli",
    command: "/opt/homebrew/bin/gemini",
    model: "gemini-2.5-pro",
    extraModels: ["gemini-2.5-flash"],
    workdir: "/tmp/gemini-proxy",
    streamMode: "synthetic",
  });
});

test("parseExternalFallbackConfig infers Gemini defaults from GEMINI_API_KEY", () => {
  const fallback = parseExternalFallbackConfig({
    GEMINI_API_KEY: "gemini-key",
  });

  assert.deepEqual(fallback, {
    provider: "google",
    baseUrl: GEMINI_OPENAI_BASE_URL,
    apiKey: "gemini-key",
    model: DEFAULT_GEMINI_FALLBACK_MODEL,
    streamMode: "synthetic",
  });
});

test("parseExternalFallbackConfig requires explicit model for generic providers", () => {
  const fallback = parseExternalFallbackConfig({
    OPENAI_COMPAT_FALLBACK_BASE_URL: "https://example.com/v1",
    OPENAI_COMPAT_FALLBACK_API_KEY: "secret",
  });

  assert.equal(fallback, null);
});

test("parseExternalFallbackConfig does not let ZAI inference hijack an explicit generic base url", () => {
  const fallback = parseExternalFallbackConfig({
    OPENAI_COMPAT_FALLBACK_BASE_URL: "https://example.com/v1",
    OPENAI_COMPAT_FALLBACK_API_KEY: "secret",
    ZAI_API_KEY: "zai-key",
  });

  assert.equal(fallback, null);
});

test("parseExternalFallbackConfig infers ZAI defaults from ZAI_API_KEY", () => {
  const fallback = parseExternalFallbackConfig({
    ZAI_API_KEY: "zai-key",
  });

  assert.deepEqual(fallback, {
    provider: "zai",
    baseUrl: ZAI_OPENAI_BASE_URL,
    apiKey: "zai-key",
    model: DEFAULT_ZAI_FALLBACK_MODEL,
    streamMode: "synthetic",
  });
});

test("parseExternalFallbackConfig supports ZAI coding plan overrides", () => {
  const fallback = parseExternalFallbackConfig({
    BIGMODEL_API_KEY: "zai-key",
    ZAI_CODING_PLAN: "true",
    ZAI_MODEL: "glm-5",
  });

  assert.deepEqual(fallback, {
    provider: "zai",
    baseUrl: ZAI_CODING_OPENAI_BASE_URL,
    apiKey: "zai-key",
    model: "glm-5",
    streamMode: "synthetic",
  });
});

test("parseExternalFallbackConfig accepts passthrough stream mode override", () => {
  const fallback = parseExternalFallbackConfig({
    ZAI_API_KEY: "zai-key",
    OPENAI_COMPAT_FALLBACK_STREAM_MODE: "passthrough",
  });

  assert.deepEqual(fallback, {
    provider: "zai",
    baseUrl: ZAI_OPENAI_BASE_URL,
    apiKey: "zai-key",
    model: DEFAULT_ZAI_FALLBACK_MODEL,
    streamMode: "passthrough",
  });
});

test("readRuntimeConfig parses explicit external fallback config", () => {
  const config = readRuntimeConfig(
    {
      OPENAI_COMPAT_FALLBACK_PROVIDER: "google",
      OPENAI_COMPAT_FALLBACK_BASE_URL:
        "https://generativelanguage.googleapis.com/v1beta/openai",
      OPENAI_COMPAT_FALLBACK_API_KEY: "secret",
      OPENAI_COMPAT_FALLBACK_MODEL: "gemini-2.5-flash",
    },
    undefined,
  );

  assert.deepEqual(config.externalFallback, {
    provider: "google",
    baseUrl: GEMINI_OPENAI_BASE_URL,
    apiKey: "secret",
    model: "gemini-2.5-flash",
    streamMode: "synthetic",
  });
});

test("readRuntimeConfig lets explicit fallback model override inferred ZAI default", () => {
  const config = readRuntimeConfig(
    {
      ZAI_API_KEY: "zai-key",
      OPENAI_COMPAT_FALLBACK_MODEL: "glm-4.7",
    },
    undefined,
  );

  assert.deepEqual(config.externalFallback, {
    provider: "zai",
    baseUrl: ZAI_OPENAI_BASE_URL,
    apiKey: "zai-key",
    model: "glm-4.7",
    streamMode: "synthetic",
  });
});
