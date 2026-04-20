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
  fallbackAliases: string[] = [],
): ModelAvailabilityManager {
  let idx = 0;
  return new ModelAvailabilityManager({
    verifyClaude: async () => ({ ok: true, version: "claude 2.1.112" }),
    verifyAuth: async () => verifyAuthCalls[Math.min(idx++, verifyAuthCalls.length - 1)](),
    probeModelAvailability: async (model) => ({
      ok: true,
      model,
      resolvedModel: "claude-sonnet-4-7",
      init: {
        type: "system",
        subtype: "init",
        cwd: process.cwd(),
        session_id: "session-1",
        tools: ["Read", "Write"],
        mcp_servers: [],
        model: "claude-sonnet-4-7",
        permissionMode: "default",
        slash_commands: [],
        skills: [],
        plugins: [],
        uuid: "uuid-1",
      },
    }),
    getModelDefinitions: () => [definition],
    getFallbackAliases: () => fallbackAliases,
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
  assert.equal(recovered.cli?.supportsAdaptiveReasoning, true);

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

test("ModelAvailabilityManager accepts the default selector as a fallback target", async () => {
  const exits: number[] = [];
  const manager = makeManager(
    [async () => ({ ok: true, status: { loggedIn: true } })],
    exits,
    ["default"],
  );

  const resolved = await manager.resolveRequestedModel("default");

  assert.equal(resolved?.id, "claude-sonnet-4-7");
});

test("ModelAvailabilityManager falls back when the requested family is unavailable", async () => {
  const exits: number[] = [];
  const manager = new ModelAvailabilityManager({
    verifyClaude: async () => ({ ok: true, version: "claude 2.1.112" }),
    verifyAuth: async () => ({ ok: true, status: { loggedIn: true } }),
    probeModelAvailability: async (model) => {
      if (model === "sonnet") {
        return {
          ok: true,
          model,
          resolvedModel: "claude-sonnet-4-7",
        };
      }
      return {
        ok: false,
        model,
        error: {
          status: 400,
          type: "invalid_request_error",
          code: "model_unavailable",
          message: "not available",
        },
      };
    },
    getModelDefinitions: () => [
      definition,
      {
        id: "opus",
        family: "opus",
        alias: "opus",
        timeoutMs: 1,
        stallTimeoutMs: 1,
      },
    ],
    getFallbackAliases: () => ["default"],
    exitProcess: (code: number) => {
      exits.push(code);
    },
  });

  const resolved = await manager.resolveRequestedModel("opus");

  assert.equal(resolved?.id, "claude-sonnet-4-7");
  assert.equal(resolved?.family, "sonnet");
});

test("ModelAvailabilityManager probes configured fallback aliases and publishes successful results", async () => {
  const exits: number[] = [];
  const manager = new ModelAvailabilityManager({
    verifyClaude: async () => ({ ok: true, version: "claude 2.1.112" }),
    verifyAuth: async () => ({ ok: true, status: { loggedIn: true } }),
    probeModelAvailability: async (model) => {
      if (model === "sonnet") {
        return {
          ok: false,
          model,
          error: {
            status: 400,
            type: "invalid_request_error",
            code: "model_unavailable",
            message: "sonnet unavailable",
          },
        };
      }
      if (model === "default") {
        return {
          ok: true,
          model,
          resolvedModel: "claude-haiku-4-5",
        };
      }
      throw new Error(`unexpected probe: ${model}`);
    },
    getModelDefinitions: () => [definition],
    getFallbackAliases: () => ["default"],
    exitProcess: (code: number) => {
      exits.push(code);
    },
  });

  const publicModels = await manager.getPublicModelList();
  const resolved = await manager.resolveRequestedModel("default");

  assert.deepEqual(publicModels.map((model) => model.id), ["claude-haiku-4-5"]);
  assert.equal(resolved?.id, "claude-haiku-4-5");
  assert.equal(resolved?.alias, "default");
  assert.equal(resolved?.family, "haiku");
});
