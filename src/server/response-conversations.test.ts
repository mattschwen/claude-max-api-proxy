import { strict as assert } from "node:assert";
import test from "node:test";
import { ResponseConversationStore } from "./response-conversations.js";

test("ResponseConversationStore remembers and resolves response ids", () => {
  let now = 1000;
  const store = new ResponseConversationStore({
    autoCleanup: false,
    now: () => now,
  });

  store.remember("resp_1", "conv_a");
  store.remember("resp_2", "conv_b");

  assert.equal(store.get("resp_1"), "conv_a");
  assert.equal(store.get("resp_2"), "conv_b");
  assert.equal(store.get("resp_missing"), undefined);
  assert.equal(store.size, 2);
});

test("ResponseConversationStore cleanup evicts expired entries", () => {
  let now = 1000;
  const store = new ResponseConversationStore({
    ttlMs: 100,
    autoCleanup: false,
    now: () => now,
  });

  store.remember("resp_old", "conv_old");
  now = 1050;
  store.remember("resp_new", "conv_new");
  now = 1150;

  const removed = store.cleanup();

  assert.equal(removed, 1);
  assert.equal(store.get("resp_old"), undefined);
  assert.equal(store.get("resp_new"), "conv_new");
  assert.equal(store.size, 1);
});
