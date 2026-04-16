/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for integration with OpenClaw/Clawdbot.
 *
 * CONCURRENCY MODEL: Queue-and-Serialize per conversation.
 * - Each conversation gets a FIFO queue
 * - Requests for the same conversation are processed sequentially
 * - Different conversations run fully in parallel
 * - No request is ever silently killed — every request gets a response
 *
 * Reliability improvements:
 * - Phase 1a: Activity-based stall detection (resets on each content_delta)
 * - Phase 2a: Extracted runStreamingSubprocess (single event-handler wiring)
 * - Phase 2b: Cleanup safety (Set-based, run-once, try/catch each)
 * - Phase 3a: Per-request queue timeout (absolute, with finally for processQueue)
 * - Phase 4a: Structured logging
 * - Phase 4b: Enhanced health endpoint
 */
import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess, subprocessRegistry } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import type { CliInput } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
  estimateTokens,
  validateTokens,
} from "../adapter/cli-to-openai.js";
import { extractTextContent } from "../adapter/cli-to-openai.js";
import { sessionManager } from "../session/manager.js";
import { conversationStore } from "../store/conversation.js";
import { subprocessPool } from "../subprocess/pool.js";
import { getModelTimeout, getStallTimeout, isValidModel } from "../models.js";
import { log, logError } from "../logger.js";
import { modelAvailability } from "../model-availability.js";
import {
  extractClaudeErrorFromResult,
  type ClaudeProxyError,
} from "../claude-cli.inspect.js";
import type {
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import { runtimeConfig, persistRuntimeState } from "../config.js";
import { isAuthError, withAuthRetry } from "./auth-retry.js";
export { isAuthError, withAuthRetry } from "./auth-retry.js";

// ---------------------------------------------------------------------------
// Thinking budget resolution
// ---------------------------------------------------------------------------

// Label → token-budget mapping. Labels match Claude CLI's --effort levels
// (low, medium, high, xhigh, max). "off" disables extended thinking (no --effort flag).
// xhigh was added with Claude Opus 4.7 as an intermediate tier between high and max.
const REASONING_EFFORT_MAP: Record<string, number> = {
  off: 0,
  low: 5000,
  medium: 10000,
  high: 32000,
  xhigh: 48000,
  max: 64000,
};

function parseEffortOrTokens(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower in REASONING_EFFORT_MAP) return REASONING_EFFORT_MAP[lower];
  const parsed = parseInt(trimmed, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return undefined;
}

/**
 * Resolve thinking budget from multiple sources in priority order:
 *   1. Request body `thinking.budget_tokens` (Anthropic style — explicit)
 *   2. Request body `reasoning_effort` (OpenAI style — "off" | "low" | "medium" | "high" | "max")
 *   3. Request header `X-Thinking-Budget` (simple client override)
 *   4. Environment variable `DEFAULT_THINKING_BUDGET` (server default)
 *
 * Returns `undefined` when no source provides a value (thinking stays off).
 */
function resolveThinkingBudget(
  req: Request,
  body: Record<string, unknown>,
): number | undefined {
  const thinking = body.thinking as
    | { type?: string; budget_tokens?: number }
    | undefined;
  if (
    thinking?.type === "enabled" &&
    typeof thinking.budget_tokens === "number" &&
    thinking.budget_tokens > 0
  ) {
    return thinking.budget_tokens;
  }

  const effort = body.reasoning_effort;
  if (typeof effort === "string") {
    const value = parseEffortOrTokens(effort);
    if (value !== undefined) return value > 0 ? value : undefined;
  }

  const headerVal = req.header("x-thinking-budget");
  if (headerVal) {
    const value = parseEffortOrTokens(headerVal);
    if (value !== undefined) return value > 0 ? value : undefined;
  }

  const runtimeDefault = runtimeConfig.defaultThinkingBudget;
  if (runtimeDefault) {
    const value = parseEffortOrTokens(runtimeDefault);
    if (value !== undefined) return value > 0 ? value : undefined;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Queue infrastructure
// ---------------------------------------------------------------------------

interface QueueItem {
  requestId: string;
  handler: () => Promise<void>;
  resolve: (value: void) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
}

interface QueueEntry {
  queue: QueueItem[];
  processing: boolean;
}

const conversationQueues = new Map<string, QueueEntry>();

interface ActiveRequestEntry {
  requestId: string;
  startedAt: number;
  stream: boolean;
  cancel?: (error: ClaudeProxyError) => void;
  pendingCancel?: ClaudeProxyError;
}

const activeRequests = new Map<string, ActiveRequestEntry>();

class RequestCancelledError extends Error {
  constructor(public readonly proxyError: ClaudeProxyError) {
    super(proxyError.message);
    this.name = "RequestCancelledError";
  }
}

/**
 * Enqueue a request for a conversation and process sequentially.
 * Phase 3a: Wraps handler with an absolute queue timeout.
 * Phase 5a: Scale timeout buffer based on queue depth to prevent stacking timeouts
 */
function enqueueRequest(
  conversationId: string,
  requestId: string,
  handler: () => Promise<void>,
  hardTimeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let entry = conversationQueues.get(conversationId);
    if (!entry) {
      entry = { queue: [], processing: false };
      conversationQueues.set(conversationId, entry);
    }

    // Phase 5a: Scale buffer based on queue position - 60s per item in queue
    const queuePosition = entry.queue.length;
    const queueBufferMs = Math.max(60000, queuePosition * 60000);
    const queueTimeoutMs = hardTimeoutMs + queueBufferMs;

    const item: QueueItem = {
      requestId,
      handler: () => {
        // Wrap handler in a race with the queue timeout
        return new Promise<void>((handlerResolve, handlerReject) => {
          const queueTimer = setTimeout(() => {
            log("queue.timeout", { conversationId, timeoutMs: queueTimeoutMs });
            handlerReject(
              new Error(`Queue timeout after ${queueTimeoutMs / 1000}s`),
            );
          }, queueTimeoutMs);

          handler()
            .then(() => {
              clearTimeout(queueTimer);
              handlerResolve();
            })
            .catch((err) => {
              clearTimeout(queueTimer);
              handlerReject(err);
            });
        });
      },
      resolve,
      reject,
      enqueuedAt: Date.now(),
    };

    entry.queue.push(item);
    log("queue.enqueue", { conversationId, depth: entry.queue.length });
    logQueueDebug("queue.enqueue", {
      conversationId,
      requestId,
      depth: entry.queue.length,
      processing: entry.processing,
      policy: runtimeConfig.sameConversationPolicy,
    });

    if (!entry.processing) {
      processQueue(conversationId);
    }
  });
}

/**
 * Process the next item in a conversation's queue.
 * Phase 3a: Uses finally to guarantee queue always advances.
 */
async function processQueue(conversationId: string): Promise<void> {
  const entry = conversationQueues.get(conversationId);
  if (!entry || entry.queue.length === 0) {
    if (entry) {
      entry.processing = false;
      if (entry.queue.length === 0) {
        conversationQueues.delete(conversationId);
      }
    }
    return;
  }

  entry.processing = true;
  const item = entry.queue.shift()!;

  try {
    const result = await item.handler();
    item.resolve(result);
  } catch (err) {
    item.reject(err);
  } finally {
    // Phase 3a: always advance the queue, even if handler throws
    processQueue(conversationId);
  }
}

// ---------------------------------------------------------------------------
// Cleanup set (Phase 2b)
// ---------------------------------------------------------------------------

/**
 * Safe cleanup collection. Each function runs at most once, wrapped in try/catch.
 */
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
      } catch (e) {
        console.error("[Cleanup] Error:", e);
      }
    }
    this.fns.clear();
  }
}

// ---------------------------------------------------------------------------
// SSE constants
// ---------------------------------------------------------------------------

const SSE_KEEPALIVE_INTERVAL = 5000;

// ---------------------------------------------------------------------------
// Stall detection stats (Phase 4b)
// ---------------------------------------------------------------------------

let stallDetections = 0;

function sendJsonError(res: Response, error: ClaudeProxyError): void {
  res.status(error.status).json({
    error: {
      message: error.message,
      type: error.type,
      code: error.code,
    },
  });
}

function startStreamingResponse(res: Response, requestId: string): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(":ok\n\n");
}

function writeStreamingError(res: Response, error: ClaudeProxyError): void {
  if (res.writableEnded) return;
  res.write(
    `data: ${JSON.stringify({
      error: {
        message: error.message,
        type: error.type,
        code: error.code,
      },
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

function respondWithError(
  res: Response,
  error: ClaudeProxyError,
  stream: boolean,
  requestId: string,
): void {
  if (res.writableEnded) return;

  if (stream) {
    if (!res.headersSent) {
      startStreamingResponse(res, requestId);
    }
    writeStreamingError(res, error);
    return;
  }

  if (!res.headersSent) {
    sendJsonError(res, error);
  }
}

function logQueueDebug(
  event: "queue.enqueue" | "queue.drop" | "queue.blocked" | "request.cancel",
  fields: Record<string, unknown>,
): void {
  if (!runtimeConfig.debugQueues) return;
  log(event, fields);
}

function createSupersededError(
  conversationId: string,
  supersedingRequestId: string,
): ClaudeProxyError {
  return {
    status: 409,
    type: "invalid_request_error",
    code: "request_superseded",
    message: `Request for conversation '${conversationId}' was superseded by a newer message (${supersedingRequestId}).`,
  };
}

function clearQueuedRequests(
  conversationId: string,
  supersedingRequestId: string,
): void {
  const entry = conversationQueues.get(conversationId);
  if (!entry || entry.queue.length === 0) return;

  const staleItems = entry.queue.splice(0);
  for (const item of staleItems) {
    log("queue.drop", {
      conversationId,
      requestId: item.requestId,
      reason: "superseded_by_newer_request",
      supersedingRequestId,
    });
    logQueueDebug("queue.drop", {
      conversationId,
      requestId: item.requestId,
      reason: "superseded_by_newer_request",
      supersedingRequestId,
      droppedQueuedRequests: staleItems.length,
    });
    item.reject(
      new RequestCancelledError(
        createSupersededError(conversationId, supersedingRequestId),
      ),
    );
  }
}

function supersedeActiveRequest(
  conversationId: string,
  supersedingRequestId: string,
): void {
  const active = activeRequests.get(conversationId);
  if (!active || active.requestId === supersedingRequestId) return;

  const error = createSupersededError(conversationId, supersedingRequestId);
  log("request.cancel", {
    conversationId,
    requestId: active.requestId,
    reason: "superseded_by_newer_request",
    supersedingRequestId,
  });
  logQueueDebug("request.cancel", {
    conversationId,
    requestId: active.requestId,
    supersedingRequestId,
    reason: "superseded_by_newer_request",
    startedAt: active.startedAt,
    stream: active.stream,
  });

  if (active.cancel) {
    active.cancel(error);
  } else {
    active.pendingCancel = error;
  }
}

function registerActiveRequest(
  conversationId: string,
  requestId: string,
  stream: boolean,
): {
  setCancel: (cancel: (error: ClaudeProxyError) => void) => void;
  clear: () => void;
} {
  const entry: ActiveRequestEntry = {
    requestId,
    startedAt: Date.now(),
    stream,
  };
  activeRequests.set(conversationId, entry);

  return {
    setCancel(cancel: (error: ClaudeProxyError) => void): void {
      entry.cancel = cancel;
      if (entry.pendingCancel) {
        const pending = entry.pendingCancel;
        entry.pendingCancel = undefined;
        cancel(pending);
      }
    },
    clear(): void {
      const current = activeRequests.get(conversationId);
      if (current === entry) {
        activeRequests.delete(conversationId);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleChatCompletions(
  req: Request,
  res: Response,
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as Record<string, unknown>;
  const stream = body.stream === true;
  const requestedModel = body.model ? String(body.model) : undefined;

  if (
    !body.messages ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0
  ) {
    res.status(400).json({
      error: {
        message: "messages is required and must be a non-empty array",
        type: "invalid_request_error",
        code: "invalid_messages",
      },
    });
    return;
  }

  if (requestedModel && !isValidModel(requestedModel)) {
    res.status(400).json({
      error: {
        message: `Model '${requestedModel}' is not supported. Use GET /v1/models for available models.`,
        type: "invalid_request_error",
        code: "model_not_found",
      },
    });
    return;
  }

  const availability = await modelAvailability.getSnapshot();
  if (availability.available.length === 0) {
    sendJsonError(res, {
      status: 503,
      type: "server_error",
      code: "no_models_available",
      message:
        availability.unavailable[0]?.error.message ||
        "No Claude models are currently accessible via Claude CLI.",
    });
    return;
  }

  const resolvedModel =
    await modelAvailability.resolveRequestedModel(requestedModel);
  if (!resolvedModel) {
    sendJsonError(res, {
      status: 503,
      type: "server_error",
      code: "model_unavailable",
      message: requestedModel
        ? `Model '${requestedModel}' is not currently available to this Claude CLI account. Use GET /v1/models to see accessible models.`
        : "No default Claude model is currently available.",
    });
    return;
  }

  const conversationId = (body.user as string) || requestId;
  if (runtimeConfig.sameConversationPolicy === "latest-wins") {
    clearQueuedRequests(conversationId, requestId);
    supersedeActiveRequest(conversationId, requestId);
  }

  const startTime = Date.now();
  const queueEntry = conversationQueues.get(conversationId);
  const queueDepth = queueEntry ? queueEntry.queue.length : 0;

  const MAX_QUEUE_DEPTH = 5;
  if (queueDepth >= MAX_QUEUE_DEPTH) {
    log("queue.blocked", { conversationId, depth: queueDepth });
    logQueueDebug("queue.blocked", {
      conversationId,
      requestId,
      depth: queueDepth,
      policy: runtimeConfig.sameConversationPolicy,
    });
    res.status(429).json({
      error: {
        message: `Too many queued requests for this conversation (${queueDepth}). Please wait for current requests to complete.`,
        type: "rate_limit_error",
        code: "queue_full",
      },
    });
    return;
  }

  // Compute hard timeout for queue wrapper
  const thinkingBudget = resolveThinkingBudget(
    req,
    body as Record<string, unknown>,
  );
  const tempModel = requestedModel || resolvedModel.id;
  const baseTimeout = getModelTimeout(tempModel);
  const hardTimeout = thinkingBudget ? baseTimeout * 3 : baseTimeout;

  log("request.start", {
    requestId,
    conversationId,
    model: tempModel,
    stream,
    queueDepth,
  });

  try {
    await enqueueRequest(
      conversationId,
      requestId,
      async () => {
        const activeRequest = registerActiveRequest(
          conversationId,
          requestId,
          stream,
        );
        try {
          const { sessionId, isResume } = sessionManager.getOrCreate(
            conversationId,
            resolvedModel.id,
          );

          // Phase 5d: Log session context size for token accounting
          if (isResume) {
            const contextSize =
              sessionManager.getContextSizeEstimate(conversationId);
            log("session.context", {
              conversationId,
              estimatedContextTokens: contextSize,
              isResume,
            });
          }

          conversationStore.ensureConversation(
            conversationId,
            resolvedModel.id,
            sessionId,
          );
          const messages = body.messages as Array<{
            role: string;
            content: string;
          }>;
          const lastUserMsg = messages.filter((m) => m.role === "user").pop();
          if (lastUserMsg) {
            const content =
              typeof lastUserMsg.content === "string"
                ? lastUserMsg.content
                : JSON.stringify(lastUserMsg.content);
            conversationStore.addMessage(conversationId, "user", content);
          }

          const cliInput = openaiToCli(
            body as unknown as Parameters<typeof openaiToCli>[0],
            isResume,
            resolvedModel.id,
          );
          cliInput.sessionId = sessionId;
          cliInput.isResume = isResume;
          cliInput._conversationId = conversationId;
          cliInput._startTime = startTime;
          if (thinkingBudget) {
            cliInput.thinkingBudget = thinkingBudget;
          }

          if (stream) {
            await handleStreamingResponse(
              req,
              res,
              cliInput,
              requestId,
              activeRequest.setCancel,
            );
          } else {
            await handleNonStreamingResponse(
              res,
              cliInput,
              requestId,
              activeRequest.setCancel,
            );
          }
        } finally {
          activeRequest.clear();
        }
      },
      hardTimeout,
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

// ---------------------------------------------------------------------------
// runStreamingSubprocess (Phase 2a)
// ---------------------------------------------------------------------------

interface StreamOpts {
  cliInput: CliInput;
  requestId: string;
  res: Response;
  onStall: () => void;
  registerCancel?: (cancel: (error: ClaudeProxyError) => void) => void;
  /**
   * When true, an upstream auth/401 failure will NOT be written to the HTTP
   * response — the caller is responsible for retrying. Used by the single
   * auth-retry path in handleStreamingResponse / handleNonStreamingResponse.
   */
  allowAuthRetry?: boolean;
}

/**
 * Single function that wires up all event handlers on a subprocess and
 * returns a promise that resolves when the subprocess completes.
 * Eliminates the duplicated event handler wiring from the old retry logic.
 */
function runStreamingSubprocess(opts: StreamOpts): Promise<{
  fullResponse: string;
  success: boolean;
  cancelled: boolean;
  authErrored?: boolean;
}> {
  const { cliInput, requestId, res, onStall, registerCancel, allowAuthRetry } =
    opts;

  const baseTimeout = getModelTimeout(cliInput.model);
  const hardTimeout = cliInput.thinkingBudget ? baseTimeout * 3 : baseTimeout;
  const stallTimeout = cliInput.thinkingBudget
    ? getStallTimeout(cliInput.model) * 3 // thinking blocks can take a long time before first text
    : getStallTimeout(cliInput.model);

  return new Promise<{
    fullResponse: string;
    success: boolean;
    cancelled: boolean;
    authErrored?: boolean;
  }>((resolve) => {
    const subprocess = new ClaudeSubprocess();
    const cleanup = new CleanupSet();

    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;
    let fullResponse = "";
    let clientDisconnected = false;
    let lastAssistantText = "";
    let lastAssistantError: string | undefined;
    let lastActivityAt = Date.now();
    const spawnTime = Date.now();
    let firstByteTime = 0;
    const chunkId = `chatcmpl-${requestId}`;

    const buildChunk = (
      text: string,
      model: string,
      first: boolean,
    ): string => {
      const escaped = JSON.stringify(text);
      const ts = Math.floor(Date.now() / 1000);
      if (first) {
        return `data: {"id":"${chunkId}","object":"chat.completion.chunk","created":${ts},"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":${escaped}},"finish_reason":null}]}\n\n`;
      }
      return `data: {"id":"${chunkId}","object":"chat.completion.chunk","created":${ts},"model":"${model}","choices":[{"index":0,"delta":{"content":${escaped}},"finish_reason":null}]}\n\n`;
    };

    const finish = (
      success: boolean,
      cancelled = false,
      authErrored = false,
    ): void => {
      if (isComplete) return;
      isComplete = true;
      cleanup.runAll();
      resolve({ fullResponse, success, cancelled, authErrored });
    };

    // SSE keepalive
    const keepaliveId = setInterval(() => {
      if (!isComplete && !clientDisconnected && !res.writableEnded) {
        res.write(":keepalive\n\n");
      }
    }, SSE_KEEPALIVE_INTERVAL);
    cleanup.add(() => clearInterval(keepaliveId));

    // Hard timeout (absolute wall clock)
    // Phase 5b: Only delete session on hard timeout (permanent error), not on stall (transient)
    const hardTimeoutId = setTimeout(() => {
      if (!isComplete) {
        log("request.timeout", {
          requestId,
          conversationId: cliInput._conversationId,
          durationMs: Date.now() - (cliInput._startTime || Date.now()),
          reason: "hard_timeout",
          timeoutMs: hardTimeout,
        });
        subprocess.kill();
        if (cliInput._conversationId) {
          sessionManager.delete(cliInput._conversationId);
        }
        if (!clientDisconnected && !res.writableEnded) {
          res.write(
            `data: ${JSON.stringify({
              error: {
                message: `Request timed out after ${hardTimeout / 1000}s`,
                type: "timeout_error",
                code: null,
              },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        }
        finish(false);
      }
    }, hardTimeout);
    cleanup.add(() => clearTimeout(hardTimeoutId));

    // Stall detection (Phase 1a): check periodically if lastActivityAt has gone stale
    // Phase 5b: Do NOT delete session on stall - it's transient. Only mark as failed for retry logic.
    const stallCheckInterval = setInterval(
      () => {
        if (isComplete) return;
        const stalledFor = Date.now() - lastActivityAt;
        if (stalledFor > stallTimeout) {
          stallDetections++;
          log("subprocess.stall", {
            requestId,
            conversationId: cliInput._conversationId,
            pid: subprocess.getPid(),
            stalledMs: stalledFor,
            stallTimeoutMs: stallTimeout,
            model: cliInput.model,
          });
          subprocess.kill();
          // Phase 5b: Mark as failed for retry (don't delete - it may be recoverable)
          if (cliInput._conversationId) {
            sessionManager.markFailed(cliInput._conversationId);
          }
          if (!clientDisconnected && !res.writableEnded) {
            res.write(
              `data: ${JSON.stringify({
                error: {
                  message: `Subprocess stalled (no activity for ${Math.round(stalledFor / 1000)}s)`,
                  type: "timeout_error",
                  code: "stall_detected",
                },
              })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
          }
          onStall();
          finish(false);
        }
      },
      Math.min(stallTimeout / 2, 10000),
    );
    cleanup.add(() => clearInterval(stallCheckInterval));

    registerCancel?.((error: ClaudeProxyError) => {
      if (isComplete) return;
      log("subprocess.kill", {
        requestId,
        conversationId: cliInput._conversationId,
        pid: subprocess.getPid(),
        reason: error.code || "cancelled",
      });
      if (!res.writableEnded) {
        respondWithError(res, error, true, requestId);
      }
      subprocess.kill();
      finish(false, true);
    });

    // Client disconnect
    const onClose = (): void => {
      clientDisconnected = true;
      if (isComplete) return;
      log("subprocess.kill", {
        requestId,
        pid: subprocess.getPid(),
        reason: "client_disconnected",
      });
      subprocess.kill();
      if (fullResponse && cliInput._conversationId) {
        try {
          conversationStore.addMessage(
            cliInput._conversationId,
            "assistant",
            fullResponse + "\n\n[Response truncated — client disconnected]",
          );
        } catch (e) {
          console.error("[Routes] Store error:", e);
        }
      }
      finish(false, true);
    };
    res.on("close", onClose);
    cleanup.add(() => res.removeListener("close", onClose));

    // Event handlers
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      lastActivityAt = Date.now(); // Reset stall timer
      const text = event.event?.delta?.text || "";
      fullResponse += text;
      if (clientDisconnected) return;
      if (text && !res.writableEnded) {
        if (isFirst && !firstByteTime) {
          firstByteTime = Date.now();
          const ttfb = firstByteTime - (cliInput._startTime || firstByteTime);
          const spawnDelta = spawnTime - (cliInput._startTime || spawnTime);
          const tokenDelta = firstByteTime - spawnTime;
          log("request.start", {
            requestId,
            ttfbMs: ttfb,
            spawnMs: spawnDelta,
            firstTokenMs: tokenDelta,
          });
        }
        res.write(buildChunk(text, lastModel, isFirst));
        isFirst = false;
      }
    });

    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      lastActivityAt = Date.now();
      lastModel = message.message.model;
      lastAssistantText = extractTextContent(message);
      lastAssistantError = message.error;
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      lastActivityAt = Date.now();

      const cliError = extractClaudeErrorFromResult(
        result,
        lastAssistantText,
        lastAssistantError,
      );
      if (cliError) {
        log("request.error", {
          requestId,
          conversationId: cliInput._conversationId,
          reason: cliError.message,
        });
        if (cliInput._conversationId && cliInput.isResume) {
          sessionManager.markFailed(cliInput._conversationId);
        }
        try {
          conversationStore.recordMetric("request_error", {
            conversationId: cliInput._conversationId,
            durationMs: Date.now() - (cliInput._startTime || Date.now()),
            success: false,
            error: cliError.message,
            clientDisconnected,
          });
        } catch (e) {
          console.error("[Routes] Metric error:", e);
        }

        // If this is an upstream auth/401 failure AND the caller is
        // prepared to retry (first attempt), bubble the auth error back
        // without writing to the stream. The caller will invalidate the
        // model-availability cache and re-run the subprocess once.
        const authErr = allowAuthRetry && isAuthError(cliError);
        if (!authErr && !clientDisconnected && !res.writableEnded) {
          writeStreamingError(res, cliError);
        }
        finish(false, false, authErr);
        return;
      }

      // Phase 5c: Token validation and estimate fallback
      let usageData = null;
      if (result?.usage) {
        const promptTokens = result.usage.input_tokens || 0;
        const completionTokens = result.usage.output_tokens || 0;
        const validation = validateTokens(
          promptTokens,
          completionTokens,
          fullResponse.length,
        );
        if (!validation.valid) {
          log("token.validation_failed", {
            requestId,
            reason: validation.reason,
            promptTokens,
            completionTokens,
            contentLength: fullResponse.length,
          });
          // Estimate tokens as fallback
          const estimatedCompletion = estimateTokens(fullResponse);
          usageData = {
            prompt_tokens: promptTokens || 0,
            completion_tokens: estimatedCompletion,
            total_tokens: promptTokens + estimatedCompletion,
          };
        } else {
          usageData = {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          };
        }
      } else if (fullResponse.length > 0) {
        // Phase 5c: Estimate tokens if not provided
        const estimatedCompletion = estimateTokens(fullResponse);
        usageData = {
          prompt_tokens: 0,
          completion_tokens: estimatedCompletion,
          total_tokens: estimatedCompletion,
        };
      }

      try {
        if (fullResponse && cliInput._conversationId) {
          conversationStore.addMessage(
            cliInput._conversationId,
            "assistant",
            fullResponse,
          );
        }
        conversationStore.recordMetric("request_complete", {
          conversationId: cliInput._conversationId,
          durationMs: Date.now() - (cliInput._startTime || Date.now()),
          success: true,
          clientDisconnected,
        });
      } catch (e) {
        console.error("[Routes] Store error:", e);
      }

      // Mark session success
      if (cliInput._conversationId && cliInput.isResume) {
        sessionManager.markSuccess(cliInput._conversationId);
      }

      if (!clientDisconnected && !res.writableEnded) {
        const doneChunk = createDoneChunk(requestId, lastModel);
        if (usageData) {
          doneChunk.usage = usageData;
        }
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }

      log("request.complete", {
        requestId,
        conversationId: cliInput._conversationId,
        model: lastModel,
        durationMs: Date.now() - (cliInput._startTime || Date.now()),
        responseLength: fullResponse.length,
        clientDisconnected,
      });

      finish(true);
    });

    subprocess.on("error", (error: Error) => {
      logError("request.error", error, {
        requestId,
        conversationId: cliInput._conversationId,
      });
      try {
        conversationStore.recordMetric("request_error", {
          conversationId: cliInput._conversationId,
          durationMs: Date.now() - (cliInput._startTime || Date.now()),
          success: false,
          error: error.message,
          clientDisconnected,
        });
      } catch (e) {
        console.error("[Routes] Metric error:", e);
      }

      if (!clientDisconnected && !res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
      finish(false);
    });

    subprocess.on("close", (code: number | null) => {
      if (!isComplete) {
        if (!clientDisconnected && !res.writableEnded) {
          if (code !== 0) {
            res.write(
              `data: ${JSON.stringify({
                error: {
                  message: `Process exited with code ${code}`,
                  type: "server_error",
                  code: null,
                },
              })}\n\n`,
            );
          }
          res.write("data: [DONE]\n\n");
          res.end();
        }
        finish(code === 0);
      }
    });

    // Start subprocess
    const startOpts = {
      model: cliInput.model,
      sessionId: cliInput.sessionId,
      systemPrompt: cliInput.systemPrompt,
      isResume: cliInput.isResume,
      thinkingBudget: cliInput.thinkingBudget,
    };

    subprocess.start(cliInput.prompt, startOpts).catch((err: Error) => {
      logError("request.error", err, {
        requestId,
        reason: "subprocess_start_failed",
      });
      if (!clientDisconnected && !res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: err.message, type: "server_error", code: null },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
      finish(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Streaming handler
// ---------------------------------------------------------------------------

async function handleStreamingResponse(
  req: Request,
  res: Response,
  cliInput: CliInput,
  requestId: string,
  registerCancel?: (cancel: (error: ClaudeProxyError) => void) => void,
): Promise<void> {
  startStreamingResponse(res, requestId);

  // First attempt, with a single 401-driven retry wrapping it. If the CLI
  // reports auth_required / 401, invalidate the 10-min model-availability
  // cache and re-run exactly once. The token gate serializes the re-run so
  // the CLI has a clean refresh path.
  const result = await withAuthRetry(
    (allowAuthRetry) =>
      runStreamingSubprocess({
        cliInput,
        requestId,
        res,
        registerCancel,
        allowAuthRetry,
        onStall: () => {
          if (cliInput._conversationId) {
            sessionManager.markFailed(cliInput._conversationId);
          }
        },
      }),
    () => {
      log("request.retry", {
        requestId,
        conversationId: cliInput._conversationId,
        reason: "auth_retry",
      });
      modelAvailability.invalidate();
    },
  );

  if (result.success || result.cancelled) return;

  // Retry once on failure (Phase 2a: clean retry without duplicated handlers)
  if (!res.writableEnded) {
    log("request.retry", {
      requestId,
      conversationId: cliInput._conversationId,
    });

    // If resume failed, retry without resume
    const retryCli: CliInput = { ...cliInput };
    if (retryCli.isResume && cliInput._conversationId) {
      sessionManager.markFailed(cliInput._conversationId);
      retryCli.isResume = false;
      // Get fresh session
      const { sessionId } = sessionManager.getOrCreate(
        cliInput._conversationId,
        cliInput.model,
      );
      retryCli.sessionId = sessionId;
    }

    await new Promise((r) => setTimeout(r, 1000)); // Brief backoff

    await runStreamingSubprocess({
      cliInput: retryCli,
      requestId,
      res,
      registerCancel,
      onStall: () => {
        if (cliInput._conversationId) {
          sessionManager.markFailed(cliInput._conversationId);
        }
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Non-streaming handler
// ---------------------------------------------------------------------------

async function handleNonStreamingResponse(
  res: Response,
  cliInput: CliInput,
  requestId: string,
  registerCancel?: (cancel: (error: ClaudeProxyError) => void) => void,
): Promise<void> {
  await withAuthRetry(
    (allowAuthRetry) =>
      runNonStreamingSubprocess(
        res,
        cliInput,
        requestId,
        registerCancel,
        allowAuthRetry,
      ),
    () => {
      log("request.retry", {
        requestId,
        conversationId: cliInput._conversationId,
        reason: "auth_retry",
      });
      modelAvailability.invalidate();
    },
  );
}

/**
 * Run a single non-streaming Claude CLI subprocess and write its result to
 * `res`. When `allowAuthRetry` is true, an upstream auth/401 failure is
 * reported back to the caller as `{authErrored: true}` WITHOUT writing the
 * error to the HTTP response — the caller is responsible for retrying once.
 */
async function runNonStreamingSubprocess(
  res: Response,
  cliInput: CliInput,
  requestId: string,
  registerCancel:
    | ((cancel: (error: ClaudeProxyError) => void) => void)
    | undefined,
  allowAuthRetry: boolean,
): Promise<{ authErrored: boolean }> {
  const baseTimeout = getModelTimeout(cliInput.model);
  const timeout = cliInput.thinkingBudget ? baseTimeout * 3 : baseTimeout;

  return new Promise<{ authErrored: boolean }>((resolve) => {
    let authErrored = false;
    const done = (): void => resolve({ authErrored });
    const subprocess = new ClaudeSubprocess();
    const cleanup = new CleanupSet();
    let finalResult: ClaudeCliResult | null = null;
    let lastAssistantText = "";
    let lastAssistantError: string | undefined;
    let isComplete = false;

    registerCancel?.((error: ClaudeProxyError) => {
      if (isComplete) return;
      log("subprocess.kill", {
        requestId,
        conversationId: cliInput._conversationId,
        pid: subprocess.getPid(),
        reason: error.code || "cancelled",
      });
      subprocess.kill();
      isComplete = true;
      cleanup.runAll();
      respondWithError(res, error, false, requestId);
      done();
    });

    const timeoutId = setTimeout(() => {
      if (!isComplete) {
        log("request.timeout", {
          requestId,
          conversationId: cliInput._conversationId,
          timeoutMs: timeout,
        });
        subprocess.kill();
        if (!res.headersSent) {
          res.status(504).json({
            error: {
              message: `Request timed out after ${timeout / 1000}s`,
              type: "timeout_error",
              code: null,
            },
          });
        }
        isComplete = true;
        cleanup.runAll();
        done();
      }
    }, timeout);
    cleanup.add(() => clearTimeout(timeoutId));

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      lastAssistantText = extractTextContent(message);
      lastAssistantError = message.error;
    });

    subprocess.on("error", (error: Error) => {
      isComplete = true;
      cleanup.runAll();
      logError("request.error", error, { requestId });
      if (!res.headersSent) {
        res.status(500).json({
          error: { message: error.message, type: "server_error", code: null },
        });
      }
      done();
    });

    subprocess.on("close", (code: number | null) => {
      isComplete = true;
      cleanup.runAll();
      if (finalResult) {
        const cliError = extractClaudeErrorFromResult(
          finalResult,
          lastAssistantText,
          lastAssistantError,
        );
        if (cliError) {
          log("request.error", {
            requestId,
            conversationId: cliInput._conversationId,
            reason: cliError.message,
          });
          try {
            conversationStore.recordMetric("request_error", {
              conversationId: cliInput._conversationId,
              durationMs: Date.now() - (cliInput._startTime || Date.now()),
              success: false,
              error: cliError.message,
            });
          } catch (e) {
            console.error("[Routes] Metric error:", e);
          }

          if (cliInput._conversationId && cliInput.isResume) {
            sessionManager.markFailed(cliInput._conversationId);
          }

          // 401-driven retry hand-off: when the caller still has a retry
          // budget, flag the failure instead of writing it to the response.
          const authErr = allowAuthRetry && isAuthError(cliError);
          if (authErr) {
            authErrored = true;
          } else if (!res.headersSent) {
            sendJsonError(res, cliError);
          }
          done();
          return;
        }

        try {
          if (finalResult.result && cliInput._conversationId) {
            conversationStore.addMessage(
              cliInput._conversationId,
              "assistant",
              finalResult.result,
            );
          }
          conversationStore.recordMetric("request_complete", {
            conversationId: cliInput._conversationId,
            durationMs: Date.now() - (cliInput._startTime || Date.now()),
            success: true,
          });
        } catch (e) {
          console.error("[Routes] Store error:", e);
        }

        if (cliInput._conversationId && cliInput.isResume) {
          sessionManager.markSuccess(cliInput._conversationId);
        }

        if (!res.headersSent) {
          res.json(cliResultToOpenai(finalResult, requestId));
        }
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      done();
    });

    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
        systemPrompt: cliInput.systemPrompt,
        isResume: cliInput.isResume,
        thinkingBudget: cliInput.thinkingBudget,
      })
      .catch((error: Error) => {
        cleanup.runAll();
        if (!res.headersSent) {
          res.status(500).json({
            error: { message: error.message, type: "server_error", code: null },
          });
        }
        done();
      });
  });
}

// ---------------------------------------------------------------------------
// Admin: runtime-mutable thinking budget
// ---------------------------------------------------------------------------

export function handleGetThinkingBudget(_req: Request, res: Response): void {
  res.json({
    budget: runtimeConfig.defaultThinkingBudget ?? null,
    allowedLabels: Object.keys(REASONING_EFFORT_MAP),
  });
}

export function handleSetThinkingBudget(req: Request, res: Response): void {
  const body = (req.body ?? {}) as { budget?: unknown };
  const raw = body.budget;

  if (raw === null || raw === undefined || raw === "") {
    runtimeConfig.defaultThinkingBudget = undefined;
    persistRuntimeState();
    log("admin.thinking_budget.cleared", {});
    res.json({ budget: null });
    return;
  }

  const asString = String(raw);
  const parsed = parseEffortOrTokens(asString);
  if (parsed === undefined) {
    res.status(400).json({
      error: {
        message: `Invalid budget "${asString}". Use one of: ${Object.keys(REASONING_EFFORT_MAP).join(", ")}, or a positive integer token count.`,
        type: "invalid_request_error",
        code: "invalid_budget",
      },
    });
    return;
  }

  runtimeConfig.defaultThinkingBudget = asString;
  persistRuntimeState();
  log("admin.thinking_budget.set", { budget: asString, tokens: parsed });
  res.json({ budget: asString, tokens: parsed });
}

// ---------------------------------------------------------------------------
// Models endpoint
// ---------------------------------------------------------------------------

export async function handleModels(
  _req: Request,
  res: Response,
): Promise<void> {
  const data = await modelAvailability.getPublicModelList();
  res.json({
    object: "list",
    data,
  });
}

// ---------------------------------------------------------------------------
// Enhanced health endpoint (Phase 4b)
// ---------------------------------------------------------------------------

export async function handleHealth(
  _req: Request,
  res: Response,
): Promise<void> {
  let metrics: Array<Record<string, unknown>> | null = null;
  let storeStats: {
    conversations: number;
    messages: number;
    metrics: number;
  } | null = null;
  let poolStatus: ReturnType<typeof subprocessPool.getStatus> | null = null;
  let recentErrors: Array<Record<string, unknown>> = [];
  let availability: Awaited<
    ReturnType<typeof modelAvailability.getSnapshot>
  > | null = null;
  try {
    metrics = conversationStore.getHealthMetrics(60);
    storeStats = conversationStore.getStats();
    recentErrors = conversationStore.getRecentErrors(5);
  } catch {
    /* store not initialized yet */
  }
  try {
    poolStatus = subprocessPool.getStatus();
  } catch {
    /* pool not ready */
  }
  try {
    availability = await modelAvailability.getSnapshot();
  } catch {
    /* availability probe failed */
  }

  // Queue status
  const queueStatus: Record<
    string,
    { queued: number; processing: boolean; waitMs?: number }
  > = {};
  for (const [convId, entry] of conversationQueues) {
    if (entry.queue.length > 0 || entry.processing) {
      const oldestItem = entry.queue[0];
      queueStatus[convId] = {
        queued: entry.queue.length,
        processing: entry.processing,
        waitMs: oldestItem ? Date.now() - oldestItem.enqueuedAt : undefined,
      };
    }
  }

  // Subprocess registry
  const activePids = subprocessRegistry.getActivePids();

  // Session failure stats
  const failureStats = sessionManager.getFailureStats();

  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
    sessions: {
      active: sessionManager.size,
      failureStats,
    },
    subprocesses: {
      active: activePids.length,
      pids: activePids,
    },
    config: {
      sameConversationPolicy: runtimeConfig.sameConversationPolicy,
      debugQueues: runtimeConfig.debugQueues,
      enableAdminApi: runtimeConfig.enableAdminApi,
    },
    auth: availability?.auth ?? undefined,
    models: availability
      ? {
          checkedAt: new Date(availability.checkedAt).toISOString(),
          available: availability.available.map((model) => model.id),
          unavailable: availability.unavailable.map((entry) => ({
            id: entry.definition.id,
            code: entry.error.code,
            message: entry.error.message,
          })),
        }
      : undefined,
    pool: poolStatus,
    store: storeStats,
    metrics,
    recentErrors,
    stallDetections,
    queues: Object.keys(queueStatus).length > 0 ? queueStatus : undefined,
  });
}
