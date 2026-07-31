import type { SameConversationPolicy } from "../config.js";
import { createHash } from "node:crypto";

const MAX_IDENTIFIER_LENGTH = 256;

interface HeaderReader {
  header(name: string): string | undefined;
}

interface HeaderWriter {
  setHeader?(name: string, value: string): unknown;
}

function normalizeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_IDENTIFIER_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

export function resolveConversationId(
  req: HeaderReader,
  body: Record<string, unknown>,
  fallbackRequestId: string,
  idempotencyScope = "chat_completions",
): string {
  const metadata =
    body.metadata && typeof body.metadata === "object"
      ? body.metadata as Record<string, unknown>
      : undefined;
  const explicitIdentity =
    normalizeIdentifier(body.conversation_id) ||
    normalizeIdentifier(metadata?.conversation_id) ||
    normalizeIdentifier(req.header("x-conversation-id")) ||
    normalizeIdentifier(body.user);
  if (explicitIdentity) return explicitIdentity;

  // A client retry without an explicit conversation identity must still map
  // to the same durable idempotency scope. Hash the key so neither logs nor
  // response headers expose caller-provided idempotency material.
  const idempotencyKey = normalizeIdentifier(req.header("idempotency-key"));
  if (idempotencyKey) {
    const digest = createHash("sha256")
      .update(idempotencyScope)
      .update("\u0000")
      .update(idempotencyKey)
      .digest("hex")
      .slice(0, 32);
    return `idem_${digest}`;
  }
  return fallbackRequestId;
}

export function resolveConversationPolicy(
  req: HeaderReader,
  body: Record<string, unknown>,
  configured: SameConversationPolicy,
): SameConversationPolicy {
  const requested =
    normalizeIdentifier(body.conversation_policy) ||
    normalizeIdentifier(req.header("x-conversation-policy"));
  if (requested === "queue") return "queue";
  if (requested === "interrupt" || requested === "latest-wins") {
    return "latest-wins";
  }
  return configured;
}

export function resolveIdempotencyKey(
  req: HeaderReader,
): string | undefined {
  return normalizeIdentifier(req.header("idempotency-key"));
}

export function setRequestIdentityHeaders(
  res: HeaderWriter,
  requestId: string,
  conversationId: string,
): void {
  res.setHeader?.("X-Request-Id", requestId);
  res.setHeader?.("X-Conversation-Id", conversationId);
}
