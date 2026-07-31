import assert from "node:assert/strict";
import test from "node:test";
import {
  extractAssistantContentFromChatChunk,
  extractAssistantContentFromChatPayload,
  OpenAICompatFallbackProvider,
  parseFallbackProviderError,
  sanitizePublicProviderBaseUrl,
  sanitizeFallbackChatRequestBody,
} from "./fallback-provider.js";

test("sanitizeFallbackChatRequestBody strips proxy-only reasoning fields", () => {
  const body = sanitizeFallbackChatRequestBody(
    {
      model: "sonnet",
      messages: [{ role: "user", content: "Hi" }],
      agent: "expert-coder",
      thinking: { budget_tokens: 32000 },
      reasoning: { effort: "high" },
      reasoning_effort: "high",
      output_config: { effort: "high" },
      temperature: 0.2,
    },
    "gemini-2.5-flash",
    { stream: false },
  );

  assert.deepEqual(body, {
    model: "gemini-2.5-flash",
    messages: [{ role: "user", content: "Hi" }],
    stream: false,
    temperature: 0.2,
  });
});

test("sanitizePublicProviderBaseUrl removes credentials, query, and fragment", () => {
  assert.equal(
    sanitizePublicProviderBaseUrl(
      "https://user:secret@example.test/v1?token=hidden#fragment",
    ),
    "https://example.test/v1",
  );
});

test("OpenAICompatFallbackProvider advertises and matches the configured model", () => {
  const provider = new OpenAICompatFallbackProvider(
    {
      provider: "zai",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "secret",
      model: "glm-4.7",
      streamMode: "synthetic",
    },
    {
      fetch: globalThis.fetch.bind(globalThis),
      now: () => 1_700_000_000_000,
    },
  );

  assert.equal(provider.supportsModel("glm-4.7"), true);
  assert.equal(provider.supportsModel("GLM-4.7"), true);
  assert.equal(provider.supportsModel("maxproxy/glm-4.7"), true);
  assert.equal(provider.supportsModel("sonnet"), false);
  assert.deepEqual(provider.getPublicModelList(), [
    {
      id: "glm-4.7",
      object: "model",
      owned_by: "zai",
      created: 1_700_000_000,
    },
  ]);
  assert.equal(provider.usesSyntheticStreaming(), true);
});

test("OpenAICompatFallbackProvider forwards chat completions to the configured endpoint", async () => {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: string;
  }> = [];
  const provider = new OpenAICompatFallbackProvider(
    {
      provider: "zai",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "secret",
      model: "glm-4.7-flash",
      streamMode: "synthetic",
    },
    {
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          headers: init?.headers as Record<string, string>,
          body: String(init?.body || ""),
        });
        return new Response(
          JSON.stringify({
            id: "chatcmpl_test",
            object: "chat.completion",
            created: 1,
            model: "glm-4.7-flash",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
      now: Date.now,
    },
  );

  const response = await provider.requestChatCompletion(
    {
      model: "sonnet",
      messages: [{ role: "user", content: "Hello" }],
      reasoning_effort: "high",
    },
    "glm-4.7-flash",
    { stream: false },
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.z.ai/api/paas/v4/chat/completions",
  );
  assert.deepEqual(calls[0].headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer secret",
  });
  assert.deepEqual(JSON.parse(calls[0].body), {
    model: "glm-4.7-flash",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
  });
});

test("extractAssistantContent helpers normalize string and array content", () => {
  assert.equal(
    extractAssistantContentFromChatPayload({
      choices: [
        {
          message: {
            content: [
              { text: "Hello" },
              " world",
            ],
          },
        },
      ],
    }),
    "Hello world",
  );
  assert.equal(
    extractAssistantContentFromChatChunk({
      choices: [
        {
          delta: {
            content: [{ text: "chunk" }],
          },
        },
      ],
    }),
    "chunk",
  );
});

test("parseFallbackProviderError preserves upstream error metadata", async () => {
  const response = new Response(
    JSON.stringify({
      error: {
        message: "quota exceeded",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    }),
    {
      status: 429,
      headers: { "Content-Type": "application/json" },
    },
  );

  const error = await parseFallbackProviderError(response, "google");

  assert.deepEqual(error, {
    status: 429,
    message: "quota exceeded",
    type: "rate_limit_error",
    code: "rate_limit_exceeded",
  });
});

test("OpenAICompatFallbackProvider exposes provider-owned model metadata", () => {
  const provider = new OpenAICompatFallbackProvider({
    provider: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "local/qwen3",
    models: [
      {
        id: "local/qwen3",
        ownedBy: "local",
        timeoutMs: 420000,
        capabilities: {
          chatCompletions: true,
          streaming: true,
          reasoning: true,
          tools: true,
          vision: false,
          structuredOutputs: true,
          contextWindow: 131072,
        },
      },
      {
        id: "local/deepseek-r1",
        ownedBy: "local",
        timeoutMs: 300000,
        capabilities: {
          chatCompletions: true,
          streaming: true,
          reasoning: true,
          tools: false,
          vision: false,
          structuredOutputs: false,
        },
      },
    ],
    streamMode: "passthrough",
  });

  assert.equal(provider.supportsModel("LOCAL/DEEPSEEK-R1"), true);
  assert.equal(provider.resolveModel("local/deepseek-r1"), "local/deepseek-r1");
  assert.equal(provider.getModelDescriptor("local/qwen3")?.timeoutMs, 420000);
  assert.equal(
    provider.getModelDescriptor("local/qwen3")?.capabilities.tools,
    true,
  );
  assert.deepEqual(
    provider.getPublicModelList().map((model) => model.id),
    ["local/qwen3", "local/deepseek-r1"],
  );
  assert.equal(provider.getAvailability().state, "unknown");
});

test("OpenAICompatFallbackProvider probes its upstream model catalog", async () => {
  const provider = new OpenAICompatFallbackProvider(
    {
      provider: "catalog",
      baseUrl: "https://example.com/v1",
      apiKey: "secret",
      model: "catalog/model-a",
      models: [
        {
          id: "catalog/model-a",
          ownedBy: "catalog",
          timeoutMs: 180000,
          capabilities: {
            chatCompletions: true,
            streaming: true,
            reasoning: false,
            tools: false,
            vision: false,
            structuredOutputs: false,
          },
        },
        {
          id: "catalog/model-b",
          ownedBy: "catalog",
          timeoutMs: 180000,
          capabilities: {
            chatCompletions: true,
            streaming: true,
            reasoning: false,
            tools: false,
            vision: false,
            structuredOutputs: false,
          },
        },
      ],
      streamMode: "synthetic",
    },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), "https://example.com/v1/models");
        assert.equal(init?.method, "GET");
        return new Response(
          JSON.stringify({ data: [{ id: "catalog/model-b" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      now: () => 1234,
    },
  );

  assert.deepEqual(await provider.probeAvailability(), {
    configured: true,
    state: "available",
    checkedAt: 1234,
    availableModels: ["catalog/model-b"],
    unavailableModels: ["catalog/model-a"],
    error: undefined,
  });
});

test("OpenAICompatFallbackProvider permits keyless local endpoints", async () => {
  let observedHeaders: Record<string, string> | undefined;
  const provider = new OpenAICompatFallbackProvider(
    {
      provider: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "local/qwen3",
      streamMode: "synthetic",
    },
    {
      fetch: async (_input, init) => {
        observedHeaders = init?.headers as Record<string, string>;
        return new Response("{}", { status: 200 });
      },
      now: Date.now,
    },
  );

  await provider.requestChatCompletion(
    { messages: [{ role: "user", content: "hi" }] },
    "local/qwen3",
  );

  assert.equal(observedHeaders?.Authorization, undefined);
});

test("OpenAICompatFallbackProvider separates public routing IDs from upstream model IDs", async () => {
  let forwardedModel = "";
  const provider = new OpenAICompatFallbackProvider(
    {
      provider: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "local/sonnet",
      models: [{
        id: "local/sonnet",
        upstreamId: "sonnet",
        ownedBy: "local",
        timeoutMs: 180000,
        capabilities: {
          chatCompletions: true,
          streaming: true,
          reasoning: false,
          tools: false,
          vision: false,
          structuredOutputs: false,
        },
      }],
      streamMode: "synthetic",
    },
    {
      fetch: async (_input, init) => {
        forwardedModel = (JSON.parse(String(init?.body)) as { model: string })
          .model;
        return new Response("{}", { status: 200 });
      },
      now: Date.now,
    },
  );

  await provider.requestChatCompletion(
    { messages: [{ role: "user", content: "hi" }] },
    "local/sonnet",
  );

  assert.equal(forwardedModel, "sonnet");
  assert.deepEqual(
    provider.getPublicModelList().map((model) => model.id),
    ["local/sonnet"],
  );
});

test("OpenAICompatFallbackProvider preserves availability after caller 4xx responses", async () => {
  let requestCount = 0;
  let now = 100;
  const provider = new OpenAICompatFallbackProvider(
    {
      provider: "remote",
      baseUrl: "https://example.com/v1",
      model: "remote/model",
      streamMode: "synthetic",
    },
    {
      fetch: async () => {
        requestCount += 1;
        return requestCount === 1
          ? new Response("{}", { status: 200 })
          : new Response(
              JSON.stringify({
                error: {
                  message: "messages is invalid",
                  type: "invalid_request_error",
                },
              }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
      },
      now: () => now++,
    },
  );

  await provider.requestChatCompletion(
    { messages: [{ role: "user", content: "valid" }] },
    "remote/model",
  );
  const available = provider.getAvailability();

  await provider.requestChatCompletion(
    { messages: [] },
    "remote/model",
  );

  assert.deepEqual(provider.getAvailability(), available);
});

test("OpenAICompatFallbackProvider updates only the model exercised by a request", async () => {
  let status = 200;
  const model = (id: string) => ({
    id,
    ownedBy: "remote",
    timeoutMs: 180000,
    capabilities: {
      chatCompletions: true,
      streaming: true,
      reasoning: false,
      tools: false,
      vision: false,
      structuredOutputs: false,
    },
  });
  const provider = new OpenAICompatFallbackProvider(
    {
      provider: "remote",
      baseUrl: "https://example.com/v1",
      model: "remote/a",
      models: [model("remote/a"), model("remote/b")],
      streamMode: "synthetic",
    },
    {
      fetch: async () => new Response("{}", { status }),
      now: () => 100,
    },
  );

  await provider.requestChatCompletion({}, "remote/a");
  await provider.requestChatCompletion({}, "remote/b");
  assert.deepEqual(provider.getAvailability().availableModels, [
    "remote/a",
    "remote/b",
  ]);

  status = 503;
  await provider.requestChatCompletion({}, "remote/a");
  assert.deepEqual(provider.getAvailability(), {
    configured: true,
    state: "available",
    checkedAt: 100,
    availableModels: ["remote/b"],
    unavailableModels: ["remote/a"],
    error: "remote returned HTTP 503",
  });
});
