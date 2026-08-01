import type { Response } from "express";
import type { CliInput } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
  estimateTokens,
  extractTextContent,
  validateTokens,
} from "../adapter/cli-to-openai.js";
import {
  extractClaudeErrorFromResult,
  type ClaudeProxyError,
} from "../claude-cli.inspect.js";
import { log, logError } from "../logger.js";
import { modelAvailability } from "../model-availability.js";
import { getModelTimeout, getStallTimeout } from "../models.js";
import { sessionManager } from "../session/manager.js";
import {
  conversationStore,
  type TurnStatus,
} from "../store/conversation.js";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import type {
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import { isAuthError, withAuthRetry } from "./auth-retry.js";

const SSE_KEEPALIVE_INTERVAL = 5000;

let stallDetections = 0;

/**
 * Write to an SSE response without racing on client disconnect. The
 * `writableEnded` check and the actual `write()` are not atomic — a socket
 * close between them throws ERR_STREAM_WRITE_AFTER_END / EPIPE. Swallow
 * those; surface anything else.
 */
export function safeWrite(res: Response, data: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    return res.write(data);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (
      code === "ERR_STREAM_WRITE_AFTER_END" ||
      code === "ERR_STREAM_DESTROYED" ||
      code === "EPIPE"
    ) {
      return false;
    }
    throw error;
  }
}

export function safeEnd(res: Response): void {
  if (res.writableEnded) return;
  try {
    res.end();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (
      code !== "ERR_STREAM_WRITE_AFTER_END" &&
      code !== "ERR_STREAM_DESTROYED" &&
      code !== "EPIPE"
    ) {
      throw error;
    }
  }
}

function hasActiveReasoning(cliInput: CliInput): boolean {
  return Boolean(
    cliInput.thinkingBudget ||
    cliInput.thinkingEffort ||
    cliInput.reasoningMode === "adaptive",
  );
}

function discardFreshSession(cliInput: CliInput): void {
  if (cliInput._conversationId && !cliInput.isResume) {
    sessionManager.discardProvisional(
      cliInput._conversationId,
      cliInput.sessionId,
    );
  }
}

/**
 * Safe cleanup collection. Each function runs at most once, wrapped in try/catch.
 */
export class CleanupSet {
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
        logError("request.error", error, { reason: "cleanup_failed" });
      }
    }
    this.fns.clear();
  }
}

export function getExecutionStats(): { stallDetections: number } {
  return { stallDetections };
}

function finishStoredTurn(
  requestId: string,
  status: Exclude<TurnStatus, "queued" | "running">,
  options: {
    output?: string;
    responseId?: string;
    sessionId?: string;
    reason?: string;
    model?: string;
    persistMessages?: boolean;
  } = {},
): boolean {
  try {
    if (!conversationStore.getTurn(requestId)) return false;
    return conversationStore.finishTurn(requestId, status, {
      ...options,
      persistInputMessage: options.persistMessages,
      persistAssistantMessage: options.persistMessages,
    });
  } catch (error) {
    console.error("[Routes] Turn state error:", error);
    return false;
  }
}

function cancellationTurnStatus(
  error: ClaudeProxyError,
): "superseded" | "cancelled" {
  return error.code === "request_superseded" ? "superseded" : "cancelled";
}

export function sendJsonError(res: Response, error: ClaudeProxyError): void {
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
  safeWrite(res, ":ok\n\n");
}

function writeStreamingError(res: Response, error: ClaudeProxyError): void {
  if (res.writableEnded) return;
  safeWrite(
    res,
    `data: ${JSON.stringify({
      error: {
        message: error.message,
        type: error.type,
        code: error.code,
      },
    })}\n\n`,
  );
  safeWrite(res, "data: [DONE]\n\n");
  safeEnd(res);
}

export function respondWithError(
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

interface CancellationRelay {
  bind: (cancel: (error: ClaudeProxyError) => void) => void;
  isCancelled: () => boolean;
}

/**
 * Keep cancellation sticky across auth/replay attempts. Without this relay,
 * the active-request entry can still point at an already-finished attempt
 * during the gap before the retry installs its own callback.
 */
function createCancellationRelay(
  registerCancel?: (cancel: (error: ClaudeProxyError) => void) => void,
): CancellationRelay {
  let cancellation: ClaudeProxyError | undefined;
  let delegate: ((error: ClaudeProxyError) => void) | undefined;
  registerCancel?.((error) => {
    cancellation = error;
    delegate?.(error);
  });
  return {
    bind(cancel): void {
      delegate = cancel;
      if (cancellation) {
        cancel(cancellation);
      }
    },
    isCancelled: () => Boolean(cancellation),
  };
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
  thinkingBlockReplay?: boolean;
}> {
  const { cliInput, requestId, res, onStall, registerCancel, allowAuthRetry } =
    opts;

  const baseTimeout = getModelTimeout(cliInput.model);
  const hardTimeout = hasActiveReasoning(cliInput)
    ? baseTimeout * 3
    : baseTimeout;
  const stallTimeout = hasActiveReasoning(cliInput)
    ? getStallTimeout(cliInput.model) * 3
    : getStallTimeout(cliInput.model);

  return new Promise<{
    fullResponse: string;
    success: boolean;
    cancelled: boolean;
    authErrored?: boolean;
    thinkingBlockReplay?: boolean;
  }>((resolve) => {
    const subprocess = new ClaudeSubprocess();
    const cleanup = new CleanupSet();
    cleanup.add(() => subprocess.kill());

    let isFirst = true;
    let lastModel = cliInput.model;
    let isComplete = false;
    let isSettled = false;
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
      thinkingBlockReplay = false,
    ): void => {
      if (isSettled) return;
      isSettled = true;
      isComplete = true;
      cleanup.runAll();
      resolve({
        fullResponse,
        success,
        cancelled,
        authErrored,
        thinkingBlockReplay,
      });
    };

    const finishAfterExit = (
      success: boolean,
      cancelled = false,
      authErrored = false,
      thinkingBlockReplay = false,
    ): void => {
      if (isComplete || isSettled) return;
      isComplete = true;
      cleanup.runAll();
      void subprocess
        .waitForExit()
        .finally(() =>
          finish(success, cancelled, authErrored, thinkingBlockReplay),
        );
    };

    const keepaliveId = setInterval(() => {
      if (!isComplete && !clientDisconnected) {
        safeWrite(res, ":keepalive\n\n");
      }
    }, SSE_KEEPALIVE_INTERVAL);
    cleanup.add(() => clearInterval(keepaliveId));

    const hardTimeoutId = setTimeout(() => {
      if (!isComplete) {
        isComplete = true;
        cleanup.runAll();
        log("request.timeout", {
          requestId,
          conversationId: cliInput._conversationId,
          durationMs: Date.now() - (cliInput._startTime || Date.now()),
          reason: "hard_timeout",
          timeoutMs: hardTimeout,
        });
        if (cliInput._conversationId && !cliInput.forkSession) {
          sessionManager.delete(cliInput._conversationId);
        }
        finishStoredTurn(requestId, "timed_out", {
          output: fullResponse || undefined,
          reason: "hard_timeout",
          model: lastModel,
        });
        if (!clientDisconnected) {
          safeWrite(
            res,
            `data: ${JSON.stringify({
              error: {
                message: `Request timed out after ${hardTimeout / 1000}s`,
                type: "timeout_error",
                code: null,
              },
            })}\n\n`,
          );
          safeWrite(res, "data: [DONE]\n\n");
          safeEnd(res);
        }
        void subprocess.stop().finally(() => finish(false));
      }
    }, hardTimeout);
    cleanup.add(() => clearTimeout(hardTimeoutId));

    const stallCheckInterval = setInterval(
      () => {
        if (isComplete) return;
        const stalledFor = Date.now() - lastActivityAt;
        if (stalledFor > stallTimeout) {
          isComplete = true;
          cleanup.runAll();
          stallDetections++;
          log("subprocess.stall", {
            requestId,
            conversationId: cliInput._conversationId,
            pid: subprocess.getPid(),
            stalledMs: stalledFor,
            stallTimeoutMs: stallTimeout,
            model: cliInput.model,
          });
          if (!clientDisconnected) {
            safeWrite(
              res,
              `data: ${JSON.stringify({
                error: {
                  message: `Subprocess stalled (no activity for ${Math.round(stalledFor / 1000)}s)`,
                  type: "timeout_error",
                  code: "stall_detected",
                },
              })}\n\n`,
            );
            safeWrite(res, "data: [DONE]\n\n");
            safeEnd(res);
          }
          onStall();
          finishStoredTurn(requestId, "failed", {
            output: fullResponse || undefined,
            reason: "stall_detected",
            model: lastModel,
          });
          void subprocess.stop().finally(() => finish(false));
        }
      },
      Math.max(5000, Math.min(stallTimeout / 2, 10000)),
    );
    cleanup.add(() => clearInterval(stallCheckInterval));

    registerCancel?.((error: ClaudeProxyError) => {
      if (isComplete) return;
      isComplete = true;
      cleanup.runAll();
      log("subprocess.kill", {
        requestId,
        conversationId: cliInput._conversationId,
        pid: subprocess.getPid(),
        reason: error.code || "cancelled",
      });
      if (!res.writableEnded) {
        respondWithError(res, error, true, requestId);
      }
      if (cliInput._conversationId && !cliInput.forkSession) {
        sessionManager.delete(cliInput._conversationId);
      }
      finishStoredTurn(requestId, cancellationTurnStatus(error), {
        output: fullResponse || undefined,
        reason: error.message,
        model: lastModel,
      });
      void subprocess.stop().finally(() => finish(false, true));
    });

    const onClose = (): void => {
      clientDisconnected = true;
      if (isComplete) return;
      isComplete = true;
      cleanup.runAll();
      log("subprocess.kill", {
        requestId,
        pid: subprocess.getPid(),
        reason: "client_disconnected",
      });
      // Forked attempts leave the committed parent untouched, so cancellation
      // discards only the child. A non-forked first turn has no safe checkpoint
      // and must still be invalidated.
      if (cliInput._conversationId && !cliInput.forkSession) {
        sessionManager.delete(cliInput._conversationId);
      }
      finishStoredTurn(requestId, "cancelled", {
        output: fullResponse || undefined,
        reason: "client_disconnected",
        model: lastModel,
      });
      void subprocess.stop().finally(() => finish(false, true));
    };
    res.on("close", onClose);
    cleanup.add(() => res.removeListener("close", onClose));

    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      if (isComplete) return;
      lastActivityAt = Date.now();
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
        if (safeWrite(res, buildChunk(text, lastModel, isFirst))) {
          isFirst = false;
        }
      }
    });

    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      if (isComplete) return;
      lastActivityAt = Date.now();
      lastModel = message.message.model;
      lastAssistantText = extractTextContent(message);
      lastAssistantError = message.error;
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      if (isComplete) return;
      lastActivityAt = Date.now();

      const cliError = extractClaudeErrorFromResult(
        result,
        lastAssistantText,
        lastAssistantError,
      );
      if (cliError) {
        log("cli.error", {
          requestId,
          conversationId: cliInput._conversationId,
          classifiedStatus: cliError.status,
          classifiedCode: cliError.code,
          rawResult: (result?.result || "").slice(0, 500),
          assistantError: lastAssistantError,
        });
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
        } catch (error) {
          console.error("[Routes] Metric error:", error);
        }

        // Thinking-block replay 400: the resumed session transcript contains a
        // thinking block that the upstream API refuses to reprocess. Delete the
        // poisoned session and signal the caller to retry once with a fresh
        // (non-resume) session. Don't write the error or end the response — the
        // fallback retry path in handleStreamingResponse owns the recovery.
        const thinkingReplay =
          cliError.code === "thinking_block_replay" &&
          cliInput.isResume === true &&
          Boolean(cliInput._conversationId);
        if (thinkingReplay && cliInput._conversationId) {
          log("request.retry", {
            requestId,
            conversationId: cliInput._conversationId,
            reason: "thinking_block_replay_recover",
          });
          sessionManager.delete(cliInput._conversationId);
          finishAfterExit(false, false, false, true);
          return;
        }

        const authErr = allowAuthRetry && isAuthError(cliError);
        discardFreshSession(cliInput);
        if (!authErr) {
          finishStoredTurn(requestId, "failed", {
            output: fullResponse || undefined,
            reason: cliError.code || cliError.message,
            model: lastModel,
          });
        }
        finishAfterExit(false, false, authErr);
        if (!authErr && !clientDisconnected && !res.writableEnded) {
          writeStreamingError(res, cliError);
        }
        return;
      }

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
        const estimatedCompletion = estimateTokens(fullResponse);
        usageData = {
          prompt_tokens: 0,
          completion_tokens: estimatedCompletion,
          total_tokens: estimatedCompletion,
        };
      }

      try {
        conversationStore.recordMetric("request_complete", {
          conversationId: cliInput._conversationId,
          durationMs: Date.now() - (cliInput._startTime || Date.now()),
          success: true,
          clientDisconnected,
        });
      } catch (error) {
        console.error("[Routes] Store error:", error);
      }

      if (cliInput._conversationId && cliInput.isResume) {
        sessionManager.markSuccess(cliInput._conversationId);
      }

      finishStoredTurn(requestId, "completed", {
        output: fullResponse,
        sessionId: result.session_id,
        model: lastModel,
        persistMessages: true,
      });
      if (cliInput._conversationId && result.session_id) {
        sessionManager.commitSession(
          cliInput._conversationId,
          result.session_id,
          lastModel,
        );
      }
      finishAfterExit(true);

      if (!clientDisconnected) {
        const doneChunk = createDoneChunk(requestId, lastModel);
        if (usageData) {
          doneChunk.usage = usageData;
        }
        safeWrite(res, `data: ${JSON.stringify(doneChunk)}\n\n`);
        safeWrite(res, "data: [DONE]\n\n");
        safeEnd(res);
      }

      log("request.complete", {
        requestId,
        conversationId: cliInput._conversationId,
        model: lastModel,
        durationMs: Date.now() - (cliInput._startTime || Date.now()),
        responseLength: fullResponse.length,
        clientDisconnected,
      });

    });

    subprocess.on("error", (error: Error) => {
      if (isComplete) return;
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
      } catch (metricError) {
        console.error("[Routes] Metric error:", metricError);
      }

      discardFreshSession(cliInput);
      finishStoredTurn(requestId, "failed", {
        output: fullResponse || undefined,
        reason: error.message,
        model: lastModel,
      });
      finishAfterExit(false);
      if (!clientDisconnected) {
        safeWrite(
          res,
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`,
        );
        safeWrite(res, "data: [DONE]\n\n");
        safeEnd(res);
      }
    });

    subprocess.on("close", (code: number | null) => {
      if (!isComplete) {
        isComplete = true;
        cleanup.runAll();
        discardFreshSession(cliInput);
        if (!clientDisconnected) {
          safeWrite(
            res,
            `data: ${JSON.stringify({
              error: {
                message: `Claude CLI exited with code ${code} without a result`,
                type: "server_error",
                code: "missing_cli_result",
              },
            })}\n\n`,
          );
          safeWrite(res, "data: [DONE]\n\n");
          safeEnd(res);
        }
        finishStoredTurn(requestId, "failed", {
          output: fullResponse || undefined,
          reason: `process_exit_${code}_without_result`,
          model: lastModel,
        });
        finish(false);
      }
    });

    if (!isComplete) {
      subprocess
        .start(cliInput.prompt, {
          model: cliInput.model,
          sessionId: cliInput.sessionId,
          systemPrompt: cliInput.systemPrompt,
          isResume: cliInput.isResume,
          forkSession: cliInput.forkSession,
          thinkingBudget: cliInput.thinkingBudget,
          thinkingEffort: cliInput.thinkingEffort,
          reasoningMode: cliInput.reasoningMode,
        })
        // .catch() is chained synchronously on start()'s promise, so a sync
        // throw or immediate rejection can never escape as an unhandled
        // rejection. finish() runs cleanup, which kills the subprocess if it
        // spawned before the failure, so it can't be orphaned.
        .catch((error: Error) => {
          if (isComplete) return;
          logError("request.error", error, {
            requestId,
            reason: "subprocess_start_failed",
          });
          discardFreshSession(cliInput);
          finishStoredTurn(requestId, "failed", {
            output: fullResponse || undefined,
            reason: error.message,
            model: lastModel,
          });
          finishAfterExit(false);
          if (!clientDisconnected) {
            safeWrite(
              res,
              `data: ${JSON.stringify({
                error: {
                  message: error.message,
                  type: "server_error",
                  code: null,
                },
              })}\n\n`,
            );
            safeWrite(res, "data: [DONE]\n\n");
            safeEnd(res);
          }
        });
    }
  });
}

export async function handleStreamingResponse(
  res: Response,
  cliInput: CliInput,
  requestId: string,
  registerCancel?: (cancel: (error: ClaudeProxyError) => void) => void,
): Promise<void> {
  startStreamingResponse(res, requestId);
  const cancellation = createCancellationRelay(registerCancel);

  const result = await withAuthRetry(
    (allowAuthRetry) =>
      runStreamingSubprocess({
        cliInput,
        requestId,
        res,
        registerCancel: cancellation.bind,
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
    { requestId, conversationId: cliInput._conversationId },
  );

  if (result.success || result.cancelled) return;

  if (!res.writableEnded && !cancellation.isCancelled()) {
    log("request.retry", {
      requestId,
      conversationId: cliInput._conversationId,
      reason: result.thinkingBlockReplay ? "thinking_block_replay" : undefined,
    });

    const retryCli: CliInput = { ...cliInput };
    if (retryCli.isResume && cliInput._conversationId) {
      sessionManager.markFailed(cliInput._conversationId);
      retryCli.isResume = false;
      retryCli.forkSession = false;
      retryCli.prompt = cliInput._freshPrompt ?? retryCli.prompt;
      retryCli.systemPrompt = cliInput._freshSystemPrompt;
      const { sessionId } = sessionManager.getOrCreate(
        cliInput._conversationId,
        cliInput.model,
      );
      retryCli.sessionId = sessionId;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (cancellation.isCancelled() || res.writableEnded) return;

    await runStreamingSubprocess({
      cliInput: retryCli,
      requestId,
      res,
      registerCancel: cancellation.bind,
      onStall: () => {
        if (cliInput._conversationId) {
          sessionManager.markFailed(cliInput._conversationId);
        }
      },
    });
  }
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
): Promise<{
  authErrored: boolean;
  thinkingBlockReplay: boolean;
  cancelled: boolean;
}> {
  const baseTimeout = getModelTimeout(cliInput.model);
  const timeout = hasActiveReasoning(cliInput) ? baseTimeout * 3 : baseTimeout;

  return new Promise<{
    authErrored: boolean;
    thinkingBlockReplay: boolean;
    cancelled: boolean;
  }>((resolve) => {
    let authErrored = false;
    let thinkingBlockReplay = false;
    let cancelled = false;
    let isSettled = false;
    const done = (): void => {
      if (isSettled) return;
      isSettled = true;
      resolve({ authErrored, thinkingBlockReplay, cancelled });
    };
    const subprocess = new ClaudeSubprocess();
    const cleanup = new CleanupSet();
    cleanup.add(() => subprocess.kill());
    let finalResult: ClaudeCliResult | null = null;
    let lastAssistantModel: string | undefined;
    let lastAssistantText = "";
    let lastAssistantError: string | undefined;
    let isComplete = false;

    registerCancel?.((error: ClaudeProxyError) => {
      if (isComplete) return;
      isComplete = true;
      cancelled = true;
      cleanup.runAll();
      log("subprocess.kill", {
        requestId,
        conversationId: cliInput._conversationId,
        pid: subprocess.getPid(),
        reason: error.code || "cancelled",
      });
      if (cliInput._conversationId && !cliInput.forkSession) {
        sessionManager.delete(cliInput._conversationId);
      }
      respondWithError(res, error, false, requestId);
      finishStoredTurn(requestId, cancellationTurnStatus(error), {
        reason: error.message,
        model: lastAssistantModel || cliInput.model,
      });
      void subprocess.stop().finally(done);
    });

    const onClientClose = (): void => {
      if (isComplete) return;
      isComplete = true;
      cancelled = true;
      cleanup.runAll();
      log("subprocess.kill", {
        requestId,
        conversationId: cliInput._conversationId,
        pid: subprocess.getPid(),
        reason: "client_disconnected",
      });
      if (cliInput._conversationId && !cliInput.forkSession) {
        sessionManager.delete(cliInput._conversationId);
      }
      finishStoredTurn(requestId, "cancelled", {
        reason: "client_disconnected",
        model: lastAssistantModel || cliInput.model,
      });
      void subprocess.stop().finally(done);
    };
    res.on("close", onClientClose);
    cleanup.add(() => res.removeListener("close", onClientClose));

    const timeoutId = setTimeout(() => {
      if (!isComplete) {
        isComplete = true;
        cleanup.runAll();
        log("request.timeout", {
          requestId,
          conversationId: cliInput._conversationId,
          timeoutMs: timeout,
        });
        if (cliInput._conversationId && !cliInput.forkSession) {
          sessionManager.delete(cliInput._conversationId);
        }
        finishStoredTurn(requestId, "timed_out", {
          reason: "hard_timeout",
          model: lastAssistantModel || cliInput.model,
        });
        if (!res.headersSent) {
          res.status(504).json({
            error: {
              message: `Request timed out after ${timeout / 1000}s`,
              type: "timeout_error",
              code: null,
            },
          });
        }
        void subprocess.stop().finally(done);
      }
    }, timeout);
    cleanup.add(() => clearTimeout(timeoutId));

    subprocess.on("result", (result: ClaudeCliResult) => {
      if (isComplete) return;
      finalResult = result;
    });

    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      if (isComplete) return;
      lastAssistantModel = message.message.model;
      lastAssistantText = extractTextContent(message);
      lastAssistantError = message.error;
    });

    subprocess.on("error", (error: Error) => {
      if (isComplete) return;
      isComplete = true;
      cleanup.runAll();
      logError("request.error", error, { requestId });
      if (!res.headersSent) {
        res.status(500).json({
          error: { message: error.message, type: "server_error", code: null },
        });
      }
      discardFreshSession(cliInput);
      finishStoredTurn(requestId, "failed", {
        reason: error.message,
        model: lastAssistantModel || cliInput.model,
      });
      void subprocess.stop().finally(done);
    });

    subprocess.on("close", (code: number | null) => {
      if (isComplete) return;
      isComplete = true;
      cleanup.runAll();
      if (finalResult) {
        const cliError = extractClaudeErrorFromResult(
          finalResult,
          lastAssistantText,
          lastAssistantError,
        );
        if (cliError) {
          log("cli.error", {
            requestId,
            conversationId: cliInput._conversationId,
            classifiedStatus: cliError.status,
            classifiedCode: cliError.code,
            rawResult: (finalResult?.result || "").slice(0, 500),
            assistantError: lastAssistantError,
          });
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
          } catch (error) {
            console.error("[Routes] Metric error:", error);
          }

          if (cliInput._conversationId && cliInput.isResume) {
            sessionManager.markFailed(cliInput._conversationId);
          }
          discardFreshSession(cliInput);

          const recoverableThinkingReplay =
            cliError.code === "thinking_block_replay" &&
            cliInput.isResume === true &&
            Boolean(cliInput._conversationId);
          if (recoverableThinkingReplay && cliInput._conversationId) {
            sessionManager.delete(cliInput._conversationId);
            thinkingBlockReplay = true;
            done();
            return;
          }

          const authErr = allowAuthRetry && isAuthError(cliError);
          if (authErr) {
            authErrored = true;
          } else if (!res.headersSent) {
            sendJsonError(res, cliError);
          }
          if (!authErr) {
            finishStoredTurn(requestId, "failed", {
              output: finalResult.result || undefined,
              sessionId: finalResult.session_id,
              reason: cliError.code || cliError.message,
              model: lastAssistantModel || cliInput.model,
            });
          }
          done();
          return;
        }

        try {
          conversationStore.recordMetric("request_complete", {
            conversationId: cliInput._conversationId,
            durationMs: Date.now() - (cliInput._startTime || Date.now()),
            success: true,
          });
        } catch (error) {
          console.error("[Routes] Store error:", error);
        }

        if (cliInput._conversationId && cliInput.isResume) {
          sessionManager.markSuccess(cliInput._conversationId);
        }
        finishStoredTurn(requestId, "completed", {
          output: finalResult.result,
          sessionId: finalResult.session_id,
          model: lastAssistantModel || cliInput.model,
          persistMessages: true,
        });
        if (cliInput._conversationId && finalResult.session_id) {
          sessionManager.commitSession(
            cliInput._conversationId,
            finalResult.session_id,
            lastAssistantModel || cliInput.model,
          );
        }

        if (!res.headersSent) {
          res.json(
            cliResultToOpenai(
              finalResult,
              requestId,
              cliInput.model,
              lastAssistantModel,
            ),
          );
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
      if (!finalResult) {
        discardFreshSession(cliInput);
        finishStoredTurn(requestId, "failed", {
          reason: `process_exit_${code}_without_response`,
          model: lastAssistantModel || cliInput.model,
        });
      }
      done();
    });

    if (!isComplete) {
      subprocess
        .start(cliInput.prompt, {
          model: cliInput.model,
          sessionId: cliInput.sessionId,
          systemPrompt: cliInput.systemPrompt,
          isResume: cliInput.isResume,
          forkSession: cliInput.forkSession,
          thinkingBudget: cliInput.thinkingBudget,
          thinkingEffort: cliInput.thinkingEffort,
          reasoningMode: cliInput.reasoningMode,
        })
        .catch((error: Error) => {
          if (isComplete) return;
          isComplete = true;
          cleanup.runAll();
          logError("request.error", error, {
            requestId,
            reason: "subprocess_start_failed",
          });
          if (!res.headersSent) {
            res.status(500).json({
              error: {
                message: error.message,
                type: "server_error",
                code: null,
              },
            });
          }
          discardFreshSession(cliInput);
          finishStoredTurn(requestId, "failed", {
            reason: error.message,
            model: lastAssistantModel || cliInput.model,
          });
          done();
        });
    }
  });
}

export async function handleNonStreamingResponse(
  res: Response,
  cliInput: CliInput,
  requestId: string,
  registerCancel?: (cancel: (error: ClaudeProxyError) => void) => void,
): Promise<void> {
  const cancellation = createCancellationRelay(registerCancel);
  const result = await withAuthRetry(
    (allowAuthRetry) =>
      runNonStreamingSubprocess(
        res,
        cliInput,
        requestId,
        cancellation.bind,
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
    { requestId, conversationId: cliInput._conversationId },
  );

  if (
    result.cancelled ||
    cancellation.isCancelled() ||
    !result.thinkingBlockReplay ||
    res.headersSent ||
    !cliInput.isResume ||
    !cliInput._conversationId
  ) {
    return;
  }

  log("request.retry", {
    requestId,
    conversationId: cliInput._conversationId,
    reason: "thinking_block_replay",
  });

  const retryCli: CliInput = {
    ...cliInput,
    isResume: false,
    forkSession: false,
    prompt: cliInput._freshPrompt ?? cliInput.prompt,
    systemPrompt: cliInput._freshSystemPrompt,
  };
  const { sessionId } = sessionManager.getOrCreate(
    cliInput._conversationId,
    cliInput.model,
  );
  retryCli.sessionId = sessionId;

  await runNonStreamingSubprocess(
    res,
    retryCli,
    requestId,
    cancellation.bind,
    false,
  );
}
