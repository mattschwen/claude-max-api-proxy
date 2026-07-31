import assert from "node:assert/strict";
import test from "node:test";
import type { ExternalProviderAvailability } from "../external-provider-types.js";
import type { ModelAvailabilitySnapshot } from "../model-availability.js";
import {
  buildHealthModelSummary,
  buildPublicHealthQueueStatus,
  resolveExternalModelAvailability,
} from "./health-models.js";

test("per-model availability never inherits a sibling model's provider state", () => {
  const availability: ExternalProviderAvailability = {
    configured: true,
    state: "available",
    checkedAt: 2_000,
    availableModels: ["router/working"],
    unavailableModels: ["router/offline"],
  };

  assert.equal(
    resolveExternalModelAvailability("router/working", availability),
    "available",
  );
  assert.equal(
    resolveExternalModelAvailability("router/offline", availability),
    "unavailable",
  );
  assert.equal(
    resolveExternalModelAvailability("router/not-yet-probed", availability),
    "configured",
  );
});

test("health model summary distinguishes external configured and probe states", () => {
  const claude = {
    checkedAt: 1_000,
    auth: null,
    cli: null,
    available: [
      {
        id: "claude-sonnet-4-6",
        family: "sonnet",
        alias: "sonnet",
        timeoutMs: 1,
        stallTimeoutMs: 1,
      },
    ],
    unavailable: [
      {
        definition: {
          id: "opus",
          family: "opus",
          alias: "opus",
          timeoutMs: 1,
          stallTimeoutMs: 1,
        },
        error: {
          status: 503,
          type: "server_error",
          code: "model_unavailable",
          message: "not entitled",
        },
      },
    ],
  } satisfies ModelAvailabilitySnapshot;

  const summary = buildHealthModelSummary(
    claude,
    ["local/qwen", "router/gemini", "router/offline"],
    [
      {
        provider: "local",
        availability: {
          configured: true,
          state: "available",
          checkedAt: 2_000,
          availableModels: ["local/qwen"],
          unavailableModels: [],
        },
      },
      {
        provider: "router",
        availability: {
          configured: true,
          state: "unavailable",
          checkedAt: 3_000,
          availableModels: [],
          unavailableModels: ["router/offline"],
          error: "upstream unavailable",
        },
      },
    ],
  );

  assert.deepEqual(summary.advertised, [
    "claude-sonnet-4-6",
    "local/qwen",
    "router/gemini",
    "router/offline",
  ]);
  assert.deepEqual(summary.available, ["claude-sonnet-4-6", "local/qwen"]);
  assert.deepEqual(summary.configured, ["router/gemini"]);
  assert.equal(summary.checkedAt, new Date(3_000).toISOString());
  assert.deepEqual(
    summary.unavailable.map(({ id, provider, code }) => ({
      id,
      provider,
      code,
    })),
    [
      {
        id: "opus",
        provider: "claude-cli",
        code: "model_unavailable",
      },
      {
        id: "router/offline",
        provider: "router",
        code: "external_provider_unavailable",
      },
    ],
  );
});

test("external-only health still reports advertised models before probing", () => {
  const summary = buildHealthModelSummary(
    null,
    ["local/model"],
    [
      {
        provider: "local",
        availability: {
          configured: true,
          state: "unknown",
          availableModels: [],
          unavailableModels: [],
        },
      },
    ],
  );

  assert.deepEqual(summary.advertised, ["local/model"]);
  assert.deepEqual(summary.available, []);
  assert.deepEqual(summary.configured, ["local/model"]);
  assert.deepEqual(summary.unavailable, []);
  assert.equal(summary.checkedAt, null);
});

test("public health queue state never exposes cancellation request IDs", () => {
  const publicStatus = buildPublicHealthQueueStatus({
    "thread-1": {
      queued: 2,
      processing: true,
      waitMs: 42,
      queuedRequestIds: ["secret-request-1", "secret-request-2"],
    },
  });

  assert.deepEqual(publicStatus, {
    "thread-1": {
      queued: 2,
      processing: true,
      waitMs: 42,
    },
  });
  assert.doesNotMatch(JSON.stringify(publicStatus), /secret-request/);
});
