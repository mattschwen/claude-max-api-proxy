import test from "node:test";
import assert from "node:assert/strict";
import {
  ModelAvailabilityManager,
  type ModelAvailabilitySnapshot,
} from "./model-availability.js";
import type { ModelDefinition } from "./models.js";

const definition: ModelDefinition = {
  id: "claude-sonnet-4-6",
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
    probeModelAvailability: async () => ({
      ok: true,
      model: definition.id,
      resolvedModel: definition.id,
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
  assert.deepEqual(recovered.available.map((model) => model.id), [definition.id]);

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
