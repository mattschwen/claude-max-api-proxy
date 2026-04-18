import test from "node:test";
import assert from "node:assert/strict";
import {
  ModelAvailabilityManager,
  type ModelAvailabilitySnapshot,
} from "./model-availability.js";
import type { ModelDefinition } from "./models.js";

const definition: ModelDefinition = {
  id: "sonnet",
  family: "sonnet",
  alias: "sonnet",
  timeoutMs: 1,
  stallTimeoutMs: 1,
};

function makeManager(
  verifyAuthCalls: Array<() => Promise<{ ok: boolean; error?: string; status?: { loggedIn: boolean } }>>,
  exits: number[],
): ModelAvailabilityManager {
  let idx = 0;
  return new ModelAvailabilityManager({
    verifyAuth: async () => verifyAuthCalls[Math.min(idx++, verifyAuthCalls.length - 1)](),
    probeModelAvailability: async (model) => ({
      ok: true,
      model,
      resolvedModel: "claude-sonnet-4-7",
    }),
    getModelDefinitions: () => [definition],
    exitProcess: (code: number) => {
      exits.push(code);
    },
  });
}

test("ModelAvailabilityManager cancels a scheduled self-exit after auth recovery", async () => {
  const exits: number[] = [];
  const manager = makeManager(
    [
      async () => ({ ok: false, error: "auth failed" }),
      async () => ({ ok: false, error: "auth failed" }),
      async () => ({ ok: false, error: "auth failed" }),
      async () => ({ ok: false, error: "auth failed" }),
      async () => ({ ok: false, error: "auth failed" }),
      async () => ({ ok: true, status: { loggedIn: true } }),
    ],
    exits,
  );

  for (let i = 0; i < 5; i++) {
    await manager.getSnapshot(true);
  }
  assert.equal(manager.getConsecutiveAuthFailures(), 5);

  const recovered = (await manager.getSnapshot(true)) as ModelAvailabilitySnapshot;
  assert.equal(manager.getConsecutiveAuthFailures(), 0);
  assert.deepEqual(recovered.available.map((model) => model.id), ["claude-sonnet-4-7"]);

  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(exits, []);
});

test("ModelAvailabilityManager exits after sustained auth failure", async () => {
  const exits: number[] = [];
  const manager = makeManager(
    [
      async () => ({ ok: false, error: "auth failed" }),
      async () => ({ ok: false, error: "auth failed" }),
      async () => ({ ok: false, error: "auth failed" }),
      async () => ({ ok: false, error: "auth failed" }),
      async () => ({ ok: false, error: "auth failed" }),
    ],
    exits,
  );

  for (let i = 0; i < 5; i++) {
    await manager.getSnapshot(true);
  }

  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(exits, [1]);
});

test("ModelAvailabilityManager resolves older versioned requests to the current available family model", async () => {
  const exits: number[] = [];
  const manager = makeManager(
    [async () => ({ ok: true, status: { loggedIn: true } })],
    exits,
  );

  const resolved = await manager.resolveRequestedModel(
    "claude-max-api-proxy/claude-sonnet-4-6",
  );

  assert.equal(resolved?.id, "claude-sonnet-4-7");
  assert.equal(resolved?.family, "sonnet");
});

test("ModelAvailabilityManager publishes resolved runtime model ids", async () => {
  const exits: number[] = [];
  const manager = makeManager(
    [async () => ({ ok: true, status: { loggedIn: true } })],
    exits,
  );

  const publicModels = await manager.getPublicModelList();

  assert.deepEqual(publicModels.map((model) => model.id), ["claude-sonnet-4-7"]);
});
