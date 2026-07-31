import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveConversationId,
  resolveConversationPolicy,
  resolveIdempotencyKey,
  setRequestIdentityHeaders,
} from "./request-context.js";

function requestWithHeaders(
  headers: Record<string, string | undefined>,
): { header(name: string): string | undefined } {
  return {
    header(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
  };
}

test("conversation identity uses explicit fields before legacy user", () => {
  const req = requestWithHeaders({ "x-conversation-id": "header-thread" });
  assert.equal(
    resolveConversationId(
      req,
      {
        conversation_id: "body-thread",
        metadata: { conversation_id: "metadata-thread" },
        user: "legacy-user",
      },
      "fallback",
    ),
    "body-thread",
  );
  assert.equal(
    resolveConversationId(
      req,
      { metadata: { conversation_id: "metadata-thread" }, user: "legacy" },
      "fallback",
    ),
    "metadata-thread",
  );
  assert.equal(
    resolveConversationId(req, { user: "legacy-user" }, "fallback"),
    "header-thread",
  );
});

test("conversation identity rejects unsafe or oversized values", () => {
  const req = requestWithHeaders({});
  assert.equal(
    resolveConversationId(req, { conversation_id: "bad\nvalue" }, "fallback"),
    "fallback",
  );
  assert.equal(
    resolveConversationId(
      req,
      { conversation_id: "x".repeat(257) },
      "fallback",
    ),
    "fallback",
  );
});

test("idempotency keys provide a stable opaque scope without explicit identity", () => {
  const first = resolveConversationId(
    requestWithHeaders({ "idempotency-key": "retry-secret" }),
    {},
    "random-request-one",
  );
  const retry = resolveConversationId(
    requestWithHeaders({ "idempotency-key": "retry-secret" }),
    {},
    "random-request-two",
  );
  const different = resolveConversationId(
    requestWithHeaders({ "idempotency-key": "other-key" }),
    {},
    "random-request-three",
  );

  assert.equal(first, retry);
  assert.match(first, /^idem_[a-f0-9]{32}$/);
  assert.equal(first.includes("retry-secret"), false);
  assert.notEqual(first, different);
  assert.notEqual(
    first,
    resolveConversationId(
      requestWithHeaders({ "idempotency-key": "retry-secret" }),
      {},
      "random-request-four",
      "responses",
    ),
  );
  assert.equal(
    resolveConversationId(
      requestWithHeaders({ "idempotency-key": "retry-secret" }),
      { conversation_id: "explicit-thread" },
      "fallback",
    ),
    "explicit-thread",
  );
});

test("per-request policy maps interrupt and queue onto queue policies", () => {
  assert.equal(
    resolveConversationPolicy(
      requestWithHeaders({}),
      { conversation_policy: "interrupt" },
      "queue",
    ),
    "latest-wins",
  );
  assert.equal(
    resolveConversationPolicy(
      requestWithHeaders({ "x-conversation-policy": "queue" }),
      {},
      "latest-wins",
    ),
    "queue",
  );
});

test("identity response headers and idempotency keys are normalized", () => {
  const headers = new Map<string, string>();
  setRequestIdentityHeaders(
    {
      setHeader(name: string, value: string) {
        headers.set(name, value);
        return undefined as never;
      },
    },
    "request-1",
    "thread-1",
  );
  assert.equal(headers.get("X-Request-Id"), "request-1");
  assert.equal(headers.get("X-Conversation-Id"), "thread-1");
  assert.equal(
    resolveIdempotencyKey(
      requestWithHeaders({ "idempotency-key": " retry-1 " }),
    ),
    "retry-1",
  );
});
