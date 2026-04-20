import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGeminiCliChatCompletion,
  buildGeminiCliErrorResponse,
  buildGeminiCliPrompt,
  GeminiCliProvider,
  readGeminiCliJsonUsage,
  readGeminiCliStreamUsage,
} from "./gemini-cli-provider.js";

test("buildGeminiCliPrompt serializes system, user, and assistant turns", () => {
  const prompt = buildGeminiCliPrompt([
    { role: "system", content: "Follow the house style." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
    { role: "user", content: [{ text: "Explain" }, " this"] },
  ]);

  assert.match(prompt, /<system>/);
  assert.match(prompt, /Follow the house style\./);
  assert.match(prompt, /<user>\nHello\n<\/user>/);
  assert.match(prompt, /<assistant>\nHi there\n<\/assistant>/);
  assert.match(prompt, /Explain\n this/);
  assert.match(prompt, /next assistant message only/i);
});

test("readGeminiCliJsonUsage derives OpenAI usage from Gemini JSON stats", () => {
  const usage = readGeminiCliJsonUsage(
    {
      stats: {
        models: {
          "gemini-2.5-pro": {
            tokens: {
              prompt: 120,
              candidates: 18,
              total: 138,
            },
          },
        },
      },
    },
    "example response",
  );

  assert.deepEqual(usage, {
    prompt_tokens: 120,
    completion_tokens: 18,
    total_tokens: 138,
  });
});

test("readGeminiCliStreamUsage prefers stream-json token totals", () => {
  const usage = readGeminiCliStreamUsage(
    {
      stats: {
        input_tokens: 200,
        output_tokens: 25,
        total_tokens: 225,
      },
    },
    "example response",
  );

  assert.deepEqual(usage, {
    prompt_tokens: 200,
    completion_tokens: 25,
    total_tokens: 225,
  });
});

test("buildGeminiCliErrorResponse maps capacity failures to rate limits", () => {
  const failure = buildGeminiCliErrorResponse(
    "",
    JSON.stringify({
      error: {
        message:
          "You have exhausted your capacity on this model. Your quota will reset after 2s.",
      },
    }),
  );

  assert.deepEqual(failure, {
    status: 429,
    body: {
      error: {
        message:
          "You have exhausted your capacity on this model. Your quota will reset after 2s.",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    },
  });
});

test("buildGeminiCliChatCompletion returns an OpenAI chat completion payload", () => {
  const completion = buildGeminiCliChatCompletion(
    {
      response: "OK",
      stats: {
        models: {
          "gemini-2.5-pro": {
            tokens: {
              prompt: 10,
              candidates: 1,
              total: 11,
            },
          },
        },
      },
    },
    "gemini-2.5-pro",
    "req123",
    1_700_000_000_000,
  );

  assert.deepEqual(completion, {
    id: "chatcmpl-req123",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "gemini-2.5-pro",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "OK",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 1,
      total_tokens: 11,
    },
  });
});

test("GeminiCliProvider advertises default and extra local CLI models", () => {
  const provider = new GeminiCliProvider(
    {
      provider: "gemini-cli",
      command: "/opt/homebrew/bin/gemini",
      model: "gemini-2.5-pro",
      extraModels: ["gemini-2.5-flash"],
      workdir: "/tmp/gemini-proxy",
      streamMode: "passthrough",
    },
    {
      now: () => 1_700_000_000_000,
      randomId: () => "req123",
    },
  );

  assert.equal(provider.supportsModel("gemini-2.5-pro"), true);
  assert.equal(provider.supportsModel("maxproxy/gemini-2.5-flash"), true);
  assert.equal(provider.resolveModel("GEMINI-2.5-FLASH"), "gemini-2.5-flash");
  assert.equal(provider.resolveModel(undefined), "gemini-2.5-pro");
  assert.deepEqual(provider.getPublicModelList(), [
    {
      id: "gemini-2.5-pro",
      object: "model",
      owned_by: "gemini-cli",
      created: 1_700_000_000,
    },
    {
      id: "gemini-2.5-flash",
      object: "model",
      owned_by: "gemini-cli",
      created: 1_700_000_000,
    },
  ]);
  assert.deepEqual(provider.getPublicInfo(), {
    provider: "gemini-cli",
    transport: "local-cli",
    model: "gemini-2.5-pro",
    extraModels: ["gemini-2.5-flash"],
    streamMode: "passthrough",
    command: "/opt/homebrew/bin/gemini",
    workdir: "/tmp/gemini-proxy",
  });
});
