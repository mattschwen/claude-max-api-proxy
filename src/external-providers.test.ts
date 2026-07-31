import assert from "node:assert/strict";
import test from "node:test";
import { buildExternalProviderRegistry } from "./external-providers.js";
import { GeminiCliProvider } from "./gemini-cli-provider.js";

test("buildExternalProviderRegistry creates one provider per named config", () => {
  const providers = buildExternalProviderRegistry(
    [
      {
        provider: "one",
        baseUrl: "https://one.example/v1",
        model: "one/model-a",
        streamMode: "synthetic",
      },
      {
        provider: "two",
        baseUrl: "https://two.example/v1",
        model: "two/model-b",
        streamMode: "passthrough",
      },
    ],
    new GeminiCliProvider(null),
  );

  assert.equal(providers.length, 3);
  assert.equal(providers[1].supportsModel("one/model-a"), true);
  assert.equal(providers[2].supportsModel("two/model-b"), true);
});

test("buildExternalProviderRegistry rejects ambiguous model ownership", () => {
  assert.throws(
    () =>
      buildExternalProviderRegistry(
        [
          {
            provider: "one",
            baseUrl: "https://one.example/v1",
            model: "shared/model",
            streamMode: "synthetic",
          },
          {
            provider: "two",
            baseUrl: "https://two.example/v1",
            model: "SHARED/MODEL",
            streamMode: "synthetic",
          },
        ],
        new GeminiCliProvider(null),
      ),
    /claimed by both/i,
  );
});
