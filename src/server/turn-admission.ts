import type { Response } from "express";
import {
  conversationStore,
  type TurnRecord,
} from "../store/conversation.js";
import type { OpenAIChatRequest } from "../types/openai.js";

export function readLastUserText(
  messages: OpenAIChatRequest["messages"],
): string | undefined {
  const message = [...messages].reverse().find((entry) => entry.role === "user");
  if (!message) return undefined;
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      if (typeof part === "string") return part;
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function hasIdempotencyPayloadConflict(
  turn: Pick<TurnRecord, "input" | "parent_response_id">,
  request: { input?: string; parentResponseId?: string },
): boolean {
  return (
    turn.input !== (request.input ?? null) ||
    turn.parent_response_id !== (request.parentResponseId ?? null)
  );
}

export function beginDurableTurn(params: {
  res: Response;
  requestId: string;
  conversationId: string;
  parentResponseId?: string;
  model: string;
  provider: string;
  input?: string;
  idempotencyKey?: string;
  stream?: boolean;
}): boolean {
  const result = conversationStore.beginTurn({
    requestId: params.requestId,
    conversationId: params.conversationId,
    parentResponseId: params.parentResponseId,
    model: params.model,
    provider: params.provider,
    input: params.input,
    idempotencyKey: params.idempotencyKey,
  });
  if (result.created) return true;

  params.res.setHeader("X-Original-Request-Id", result.turn.request_id);
  if (
    params.idempotencyKey &&
    hasIdempotencyPayloadConflict(result.turn, params)
  ) {
    params.res.status(409).json({
      error: {
        message:
          "Idempotency-Key was already used with different input or response lineage.",
        type: "conflict_error",
        code: "idempotency_key_mismatch",
      },
    });
    return false;
  }
  if (
    result.turn.status === "completed" &&
    result.turn.output !== null &&
    !params.stream
  ) {
    params.res.status(200).json({
      id: `chatcmpl-${result.turn.request_id}`,
      object: "chat.completion",
      created: Math.floor(result.turn.created_at / 1000),
      model: result.turn.model || params.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.turn.output },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
      proxy: {
        idempotent_replay: true,
        original_request_id: result.turn.request_id,
      },
    });
    return false;
  }

  params.res.status(409).json({
    error: {
      message: `Idempotency key is already associated with request '${result.turn.request_id}' (${result.turn.status}).`,
      type: "conflict_error",
      code: "idempotency_key_in_use",
    },
  });
  return false;
}
