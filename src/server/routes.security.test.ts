import assert from "node:assert/strict";
import test from "node:test";
import { runtimeConfig } from "../config.js";
import { buildPublicRuntimeConfig } from "./routes.js";

test("public runtime diagnostics never expose external provider credentials", () => {
  const previous = runtimeConfig.externalFallback;
  runtimeConfig.externalFallback = {
    provider: "example",
    baseUrl:
      "https://user:sentinel-password@example.test/v1?token=sentinel-query",
    apiKey: "sentinel-secret-that-must-not-leak",
    model: "example/model",
    streamMode: "passthrough",
  };
  try {
    const serialized = JSON.stringify(buildPublicRuntimeConfig());
    assert.doesNotMatch(serialized, /sentinel-secret-that-must-not-leak/);
    assert.doesNotMatch(serialized, /sentinel-password|sentinel-query|user:/);
    assert.match(serialized, /example\/model/);
  } finally {
    runtimeConfig.externalFallback = previous;
  }
});
