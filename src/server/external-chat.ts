import type { Response } from "express";
import { createDoneChunk, estimateTokens } from "../adapter/cli-to-openai.js";
import type { ClaudeProxyError } from "../claude-cli.inspect.js";
import {
  extractAssistantContentFromChatChunk,
  extractAssistantContentFromChatPayload,
  parseFallbackProviderError,
} from "../fallback-provider.js";
import type { ExternalChatProvider } from "../external-provider-types.js";
import { log, logError } from "../logger.js";
import { getModelTimeout, stripModelProviderPrefix } from "../models.js";
import { conversationStore } from "../store/conversation.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import {
  respondWithError,
  sendJsonError,
} from "./chat-execution.js";
import {
  conversationRequestQueue,
  RequestCancelledError,
} from "./request-queue.js";

const SYNTHETIC_STREAM_KEEPALIVE_INTERVAL = 5000;

class CleanupSet {
  private fns = new Set<() => void>();
  private ran = false;

  add(fn: () => void): void {
    if (!this.ran) {
      this.fns.add(fn);
    }
  }

  runAll(): void {
    if (this.ran) return;
    this.ran = true;
    for (const fn of this.fns) {
      try {
        fn();
      } catch (error) {
        console.error("[External Chat Cleanup] Error:", error);
      }
    }
    this.fns.clear();
  }
}

function readLastUserMessage(
  messages: OpenAIChatRequest["messages"],
): string | null {
  const lastUserMessage = [...messages].reverse().find((message) =>
    message.role === "user"
  );
  if (!lastUserMessage) {
    return null;
  }

  if (typeof lastUserMessage.content === "string") {
    return lastUserMessage.content;
  }

  return lastUserMessage.content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

function startExternalStreamingResponse(res: Response, requestId: string): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(":ok\n\n");
}

function parseJsonIfPossible(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function readUsageTotals(payload: unknown): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} | undefined {
  if (!payload || typeof payload !== "object" || !("usage" in payload)) {
    return undefined;
  }

  const usage = payload.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const readNumber = (...values: unknown[]): number | undefined => {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
    return undefined;
  };

  const promptTokens = readNumber(
    "prompt_tokens" in usage ? usage.prompt_tokens : undefined,
    "input_tokens" in usage ? usage.input_tokens : undefined,
  ) ?? 0;
  const completionTokens = readNumber(
    "completion_tokens" in usage ? usage.completion_tokens : undefined,
    "output_tokens" in usage ? usage.output_tokens : undefined,
  );
  const totalTokens = readNumber(
    "total_tokens" in usage ? usage.total_tokens : undefined,
  );

  if (completionTokens == null && totalTokens == null && promptTokens === 0) {
    return undefined;
  }

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens ?? 0,
    total_tokens: totalTokens ?? promptTokens + (completionTokens ?? 0),
  };
}

function chunkSyntheticStreamText(text: string, targetSize = 160): string[] {
  if (!text) {
    return [];
  }

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + targetSize, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      const space = text.lastIndexOf(" ", end);
      const breakpoint = Math.max(newline, space);
      if (breakpoint > cursor + Math.floor(targetSize / 2)) {
        end = breakpoint + 1;
      }
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }

  return chunks;
}

function writeSyntheticStreamingResponse(params: {
  res: Response;
  requestId: string;
  model: string;
  content: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}): void {
  const { res, requestId, model, content, usage } = params;
  if (!res.headersSent) {
    startExternalStreamingResponse(res, requestId);
  }

  const chunkId = `chatcmpl-${requestId}`;
  let isFirst = true;
  for (const chunk of chunkSyntheticStreamText(content)) {
    res.write(
      `data: ${JSON.stringify({
        id: chunkId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: isFirst
              ? { role: "assistant", content: chunk }
              : { content: chunk },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    isFirst = false;
  }

  const doneChunk = createDoneChunk(requestId, model);
  doneChunk.usage = usage ?? {
    prompt_tokens: 0,
    completion_tokens: estimateTokens(content),
    total_tokens: estimateTokens(content),
  };
  res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function buildTransportErrorMessage(error: unknown): {
  message: string;
  details: Record<string, unknown>;
} {
  const baseMessage = error instanceof Error ? error.message : String(error);
  const details: Record<string, unknown> = {};

  if (error instanceof Error) {
    details.errorName = error.name;
    if (error.stack) {
      details.errorStack = error.stack.split("\n").slice(0, 6);
    }
    const cause = "cause" in error ? error.cause : undefined;
    if (cause && typeof cause === "object") {
      if ("name" in cause && typeof cause.name === "string") {
        details.errorCauseName = cause.name;
      }
      if ("message" in cause && typeof cause.message === "string") {
        details.errorCauseMessage = cause.message;
      }
      if ("code" in cause && typeof cause.code === "string") {
        details.errorCauseCode = cause.code;
      }
    } else if (typeof cause === "string") {
      details.errorCauseMessage = cause;
    }
  }

  const causeCode = typeof details.errorCauseCode === "string"
    ? details.errorCauseCode
    : null;
  const causeMessage = typeof details.errorCauseMessage === "string"
    ? details.errorCauseMessage
    : null;

  if (baseMessage === "fetch failed" && (causeCode || causeMessage)) {
    return {
      message: `fetch failed (${causeCode || causeMessage})`,
      details,
    };
  }

  return {
    message: baseMessage,
    details,
  };
}

function recordCompletion(params: {
  conversationId: string;
  requestId: string;
  model: string;
  provider: string;
  startTime: number;
  responseLength: number;
}): void {
  conversationStore.recordMetric("request_complete", {
    conversationId: params.conversationId,
    durationMs: Date.now() - params.startTime,
    success: true,
  });
  log("request.complete", {
    requestId: params.requestId,
    conversationId: params.conversationId,
    model: params.model,
    durationMs: Date.now() - params.startTime,
    responseLength: params.responseLength,
    upstreamProvider: params.provider,
  });
}

function recordError(params: {
  conversationId: string;
  requestId: string;
  model: string;
  provider: string;
  startTime: number;
  error: string;
}): void {
  conversationStore.recordMetric("request_error", {
    conversationId: params.conversationId,
    durationMs: Date.now() - params.startTime,
    success: false,
    error: params.error,
  });
  log("request.error", {
    requestId: params.requestId,
    conversationId: params.conversationId,
    model: params.model,
    reason: params.error,
    upstreamProvider: params.provider,
  });
}

async function executeExternalChat(params: {
  provider: ExternalChatProvider;
  res: Response;
  body: OpenAIChatRequest & Record<string, unknown>;
  requestId: string;
  conversationId: string;
  stream: boolean;
  resolvedModel: string;
  startTime: number;
  registerCancel?: (cancel: (error: ClaudeProxyError) => void) => void;
}): Promise<void> {
  const {
    provider,
    res,
    body,
    requestId,
    conversationId,
    stream,
    resolvedModel,
    startTime,
    registerCancel,
  } = params;
  const providerInfo = provider.getPublicInfo();
  if (!providerInfo) {
    sendJsonError(res, {
      status: 503,
      type: "server_error",
      code: "external_provider_unavailable",
      message: "No external fallback provider is configured.",
    });
    return;
  }

  const cleanup = new CleanupSet();
  const abortController = new AbortController();
  let completed = false;
  let assistantText = "";

  const finish = (): void => {
    if (completed) return;
    completed = true;
    cleanup.runAll();
  };

  registerCancel?.((error: ClaudeProxyError) => {
    if (completed) return;
    log("request.cancel", {
      requestId,
      conversationId,
      model: resolvedModel,
      reason: error.code || "cancelled",
      upstreamProvider: providerInfo.provider,
    });
    if (!res.writableEnded) {
      respondWithError(res, error, stream, requestId);
    }
    abortController.abort(error.message);
    finish();
  });

  const onClose = (): void => {
    if (completed) return;
    log("request.cancel", {
      requestId,
      conversationId,
      model: resolvedModel,
      reason: "client_disconnected",
      upstreamProvider: providerInfo.provider,
    });
    abortController.abort("client_disconnected");
    if (assistantText) {
      conversationStore.addMessage(
        conversationId,
        "assistant",
        `${assistantText}\n\n[Response truncated — client disconnected]`,
      );
    }
    finish();
  };
  res.on("close", onClose);
  cleanup.add(() => res.removeListener("close", onClose));

  try {
    const useUpstreamStreaming = stream && !provider.usesSyntheticStreaming();
    if (stream && !useUpstreamStreaming) {
      startExternalStreamingResponse(res, requestId);
      const keepaliveId = setInterval(() => {
        if (!completed && !res.writableEnded) {
          res.write(":keepalive\n\n");
        }
      }, SYNTHETIC_STREAM_KEEPALIVE_INTERVAL);
      cleanup.add(() => clearInterval(keepaliveId));
    }
    const response = await provider.requestChatCompletion(body, resolvedModel, {
      signal: abortController.signal,
      stream: useUpstreamStreaming,
    });
    if (completed) return;

    if (!response.ok) {
      const upstreamError = await parseFallbackProviderError(
        response,
        providerInfo.provider,
      );
      recordError({
        conversationId,
        requestId,
        model: resolvedModel,
        provider: providerInfo.provider,
        startTime,
        error: upstreamError.message,
      });
      respondWithError(res, upstreamError, stream, requestId);
      finish();
      return;
    }

    if (stream && useUpstreamStreaming) {
      startExternalStreamingResponse(res, requestId);
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Fallback provider returned an empty stream body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let streamErrorMessage: string | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!res.writableEnded) {
          res.write(chunk);
        }
        buffer += chunk;

        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            assistantText += extractAssistantContentFromChatChunk(parsed);
            if (
              parsed &&
              typeof parsed === "object" &&
              "error" in parsed &&
              parsed.error &&
              typeof parsed.error === "object" &&
              "message" in parsed.error &&
              typeof parsed.error.message === "string"
            ) {
              streamErrorMessage = parsed.error.message;
            }
          } catch {
            /* ignore malformed chunks and keep streaming */
          }
        }
      }

      const tail = decoder.decode();
      if (tail) {
        buffer += tail;
      }
      for (const line of buffer.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload);
          assistantText += extractAssistantContentFromChatChunk(parsed);
          if (
            parsed &&
            typeof parsed === "object" &&
            "error" in parsed &&
            parsed.error &&
            typeof parsed.error === "object" &&
            "message" in parsed.error &&
            typeof parsed.error.message === "string"
          ) {
            streamErrorMessage = parsed.error.message;
          }
        } catch {
          /* ignore malformed tail chunks */
        }
      }

      if (streamErrorMessage) {
        recordError({
          conversationId,
          requestId,
          model: resolvedModel,
          provider: providerInfo.provider,
          startTime,
          error: streamErrorMessage,
        });
      } else if (assistantText) {
        conversationStore.addMessage(conversationId, "assistant", assistantText);
        recordCompletion({
          conversationId,
          requestId,
          model: resolvedModel,
          provider: providerInfo.provider,
          startTime,
          responseLength: assistantText.length,
        });
      } else {
        recordCompletion({
          conversationId,
          requestId,
          model: resolvedModel,
          provider: providerInfo.provider,
          startTime,
          responseLength: 0,
        });
      }
      if (!res.writableEnded) {
        res.end();
      }
      finish();
      return;
    }

    const raw = await response.text();
    if (completed) return;

    const payload = parseJsonIfPossible(raw);

    const finalText = typeof payload === "string"
      ? payload
      : extractAssistantContentFromChatPayload(payload);
    const usage = readUsageTotals(payload);
    if (finalText) {
      conversationStore.addMessage(conversationId, "assistant", finalText);
    }
    recordCompletion({
      conversationId,
      requestId,
      model: resolvedModel,
      provider: providerInfo.provider,
      startTime,
      responseLength: finalText.length,
    });

    if (stream) {
      writeSyntheticStreamingResponse({
        res,
        requestId,
        model: resolvedModel,
        content: finalText,
        usage,
      });
      finish();
      return;
    }

    if (!res.headersSent) {
      if (typeof payload === "string") {
        res.status(response.status).send(payload);
      } else {
        res.status(response.status).json(payload);
      }
    }
    finish();
  } catch (error) {
    if (completed || abortController.signal.aborted) {
      return;
    }
    const { message, details } = buildTransportErrorMessage(error);
    logError("request.error", error, {
      requestId,
      conversationId,
      model: resolvedModel,
      upstreamProvider: providerInfo.provider,
      ...details,
    });
    conversationStore.recordMetric("request_error", {
      conversationId,
      durationMs: Date.now() - startTime,
      success: false,
      error: message,
    });
    if (!res.writableEnded) {
      if (stream) {
        respondWithError(res, {
          status: 502,
          type: "server_error",
          code: "external_provider_error",
          message,
        }, true, requestId);
      } else if (!res.headersSent) {
        sendJsonError(res, {
          status: 502,
          type: "server_error",
          code: "external_provider_error",
          message,
        });
      }
    }
    finish();
  }
}

export async function handleExternalChatCompletions(params: {
  provider: ExternalChatProvider;
  res: Response;
  body: OpenAIChatRequest & Record<string, unknown>;
  requestId: string;
  conversationId: string;
  requestedModel?: string;
  stream: boolean;
  agentId?: string;
  queueDepth: number;
  startTime: number;
  resolvedModel: string;
}): Promise<void> {
  const {
    provider,
    res,
    body,
    requestId,
    conversationId,
    requestedModel,
    stream,
    agentId,
    queueDepth,
    startTime,
    resolvedModel,
  } = params;
  const providerInfo = provider.getPublicInfo();
  const normalizedRequestedModel = requestedModel
    ? stripModelProviderPrefix(requestedModel)
    : undefined;
  const fallbackUsed = Boolean(
    normalizedRequestedModel && normalizedRequestedModel !== resolvedModel,
  );

  log("request.start", {
    requestId,
    conversationId,
    model: resolvedModel,
    requestedModel: normalizedRequestedModel,
    upstreamProvider: providerInfo?.provider,
    fallbackUsed,
    stream,
    agent: agentId,
    queueDepth,
  });

  try {
    await conversationRequestQueue.enqueue(
      conversationId,
      requestId,
      async () => {
        const activeRequest = conversationRequestQueue.registerActiveRequest(
          conversationId,
          requestId,
          stream,
        );
        try {
          conversationStore.ensureConversation(conversationId, resolvedModel);
          const lastUserMessage = readLastUserMessage(body.messages);
          if (lastUserMessage) {
            conversationStore.addMessage(conversationId, "user", lastUserMessage);
          }
          await executeExternalChat({
            provider,
            res,
            body,
            requestId,
            conversationId,
            stream,
            resolvedModel,
            startTime,
            registerCancel: activeRequest.setCancel,
          });
        } finally {
          activeRequest.clear();
        }
      },
      getModelTimeout(resolvedModel),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logError("request.error", error, { requestId, conversationId });
    if (error instanceof RequestCancelledError) {
      respondWithError(res, error.proxyError, stream, requestId);
      return;
    }
    if (!res.headersSent) {
      sendJsonError(res, {
        status: 500,
        message,
        type: "server_error",
        code: null,
      });
    }
  }
}
