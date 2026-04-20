import assert from "node:assert/strict";
import test from "node:test";
import {
  extractAssistantContentFromChatChunk,
  extractAssistantContentFromChatPayload,
  OpenAICompatFallbackProvider,
  parseFallbackProviderError,
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
