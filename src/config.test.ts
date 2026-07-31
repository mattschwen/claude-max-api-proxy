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
  parseExternalProviderConfigs,
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
    requireClaude: true,
    sameConversationPolicy: "queue",
    debugQueues: true,
    enableAdminApi: true,
    defaultThinkingBudget: undefined,
    defaultAgent: undefined,
    systemPromptFile: undefined,
    maxConcurrentRequests: config.maxConcurrentRequests,
    modelFallbacks: [],
    geminiCliFallback: null,
    externalFallback: null,
    externalProviders: [],
  });
  assert.ok(config.maxConcurrentRequests >= 1);
});

test("readRuntimeConfig reads default thinking budget", () => {
  const config = readRuntimeConfig({
    DEFAULT_THINKING_BUDGET: "high",
  }, undefined);

  assert.deepEqual(config, {
    requireClaude: true,
    sameConversationPolicy: "latest-wins",
    debugQueues: false,
    enableAdminApi: false,
    defaultThinkingBudget: "high",
    defaultAgent: undefined,
    systemPromptFile: undefined,
    maxConcurrentRequests: config.maxConcurrentRequests,
    modelFallbacks: [],
    geminiCliFallback: null,
    externalFallback: null,
    externalProviders: [],
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
    requireClaude: true,
    sameConversationPolicy: "latest-wins",
    debugQueues: false,
    enableAdminApi: false,
    defaultThinkingBudget: "low",
    defaultAgent: undefined,
    systemPromptFile: undefined,
    maxConcurrentRequests: config.maxConcurrentRequests,
    modelFallbacks: [],
    geminiCliFallback: null,
    externalFallback: null,
    externalProviders: [],
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
    requireClaude: true,
    sameConversationPolicy: "latest-wins",
    debugQueues: false,
    enableAdminApi: false,
    defaultThinkingBudget: undefined,
    defaultAgent: "expert-coder",
    systemPromptFile: undefined,
    maxConcurrentRequests: config.maxConcurrentRequests,
    modelFallbacks: [],
    geminiCliFallback: null,
    externalFallback: null,
    externalProviders: [],
  });
  assert.ok(config.maxConcurrentRequests >= 1);
});

test("readRuntimeConfig reads the house system prompt file", () => {
  const config = readRuntimeConfig(
    {
      CLAUDE_PROXY_SYSTEM_PROMPT_FILE: " /etc/claude/house-prompt.md ",
    },
    undefined,
  );

  assert.equal(config.systemPromptFile, "/etc/claude/house-prompt.md");
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
  assert.equal(config.requireClaude, false);
  assert.equal(config.externalProviders.length, 1);
});

test("parseExternalProviderConfigs supports multiple named providers and models", () => {
  const providers = parseExternalProviderConfigs({
    OPENAI_COMPAT_PROVIDERS_JSON: JSON.stringify([
      {
        provider: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        models: [
          {
            id: "local/qwen3",
            upstreamId: "qwen3",
            timeoutMs: 420000,
            capabilities: {
              reasoning: true,
              tools: true,
              contextWindow: 131072,
            },
          },
          "local/deepseek-r1",
        ],
      },
      {
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
        models: ["openrouter/google/gemini-3-pro"],
        streamMode: "passthrough",
      },
    ]),
    OPENROUTER_API_KEY: "router-secret",
  });

  assert.equal(providers.length, 2);
  assert.deepEqual(
    providers[0].models?.map((model) => model.id),
    ["local/qwen3", "local/deepseek-r1"],
  );
  assert.equal(providers[0].models?.[0].timeoutMs, 420000);
  assert.equal(providers[0].models?.[0].upstreamId, "qwen3");
  assert.equal(providers[0].models?.[0].capabilities.reasoning, true);
  assert.equal(providers[0].models?.[0].capabilities.tools, true);
  assert.equal(providers[0].models?.[0].capabilities.contextWindow, 131072);
  assert.equal(providers[1].apiKey, "router-secret");
  assert.equal(providers[1].streamMode, "passthrough");
});

test("parseExternalProviderConfigs rejects bare Claude route collisions", () => {
  assert.throws(
    () =>
      parseExternalProviderConfigs({
        OPENAI_COMPAT_PROVIDERS_JSON: JSON.stringify({
          provider: "unsafe",
          baseUrl: "https://example.com/v1",
          models: ["sonnet"],
        }),
      }),
    /collides with a Claude alias/i,
  );
});

test("parseExternalProviderConfigs rejects unsafe provider base URLs", () => {
  assert.throws(
    () =>
      parseExternalProviderConfigs({
        OPENAI_COMPAT_PROVIDERS_JSON: JSON.stringify({
          provider: "malformed",
          baseUrl: "not-a-url-with-secret-token",
          models: ["malformed/model"],
        }),
      }),
    (error: unknown) =>
      error instanceof Error &&
      /invalid baseUrl/i.test(error.message) &&
      !error.message.includes("secret-token"),
  );
  assert.throws(
    () =>
      parseExternalProviderConfigs({
        OPENAI_COMPAT_PROVIDERS_JSON: JSON.stringify({
          provider: "credentialed",
          baseUrl: "https://user:secret@example.com/v1",
          models: ["credentialed/model"],
        }),
      }),
    /must not contain credentials/i,
  );
  assert.throws(
    () =>
      parseExternalProviderConfigs({
        OPENAI_COMPAT_PROVIDERS_JSON: JSON.stringify({
          provider: "unsupported-scheme",
          baseUrl: "file:///tmp/provider",
          models: ["unsupported/model"],
        }),
      }),
    /must use http or https/i,
  );
  assert.throws(
    () =>
      parseExternalFallbackConfig({
        OPENAI_COMPAT_FALLBACK_PROVIDER: "legacy",
        OPENAI_COMPAT_FALLBACK_BASE_URL:
          "https://user:secret@example.com/v1",
        OPENAI_COMPAT_FALLBACK_API_KEY: "key",
        OPENAI_COMPAT_FALLBACK_MODEL: "legacy/model",
      }),
    /must not contain credentials/i,
  );
});

test("parseExternalProviderConfigs fails when an explicit apiKeyEnv is unset", () => {
  assert.throws(
    () =>
      parseExternalProviderConfigs({
        OPENAI_COMPAT_PROVIDERS_JSON: JSON.stringify({
          provider: "remote",
          baseUrl: "https://example.com/v1",
          apiKeyEnv: "MISSING_REMOTE_API_KEY",
          models: ["remote/model"],
        }),
      }),
    /unset apiKeyEnv 'MISSING_REMOTE_API_KEY'/i,
  );
});

test("OPENAI_COMPAT_PROVIDERS_JSON replaces legacy external fallback state", () => {
  const config = readRuntimeConfig(
    {
      GEMINI_API_KEY: "legacy-key",
      OPENAI_COMPAT_PROVIDERS_JSON: JSON.stringify({
        provider: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        models: ["local/qwen3"],
      }),
    },
    undefined,
  );

  assert.equal(config.externalFallback, null);
  assert.deepEqual(
    config.externalProviders.map((provider) => provider.provider),
    ["local"],
  );
});

test("readRuntimeConfig can explicitly require Claude with external providers", () => {
  const config = readRuntimeConfig(
    {
      GEMINI_API_KEY: "gemini-key",
      CLAUDE_PROXY_REQUIRE_CLAUDE: "true",
    },
    undefined,
  );

  assert.equal(config.requireClaude, true);
  assert.equal(config.externalProviders.length, 1);
});
