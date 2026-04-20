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
import { conversationStore } from "../store/conversation.js";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import type {
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import { isAuthError, withAuthRetry } from "./auth-retry.js";

const SSE_KEEPALIVE_INTERVAL = 5000;

let stallDetections = 0;

function hasActiveReasoning(cliInput: CliInput): boolean {
  return Boolean(
    cliInput.thinkingBudget ||
      cliInput.thinkingEffort ||
      cliInput.reasoningMode === "adaptive",
  );
}

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
      } catch (error) {
        console.error("[Cleanup] Error:", error);
      }
    }
    this.fns.clear();
  }
}

export function getExecutionStats(): { stallDetections: number } {
  return { stallDetections };
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
  const hardTimeout = hasActiveReasoning(cliInput) ? baseTimeout * 3 : baseTimeout;
  const stallTimeout = hasActiveReasoning(cliInput)
    ? getStallTimeout(cliInput.model) * 3
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
    let lastModel = cliInput.model;
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

    const keepaliveId = setInterval(() => {
      if (!isComplete && !clientDisconnected && !res.writableEnded) {
        res.write(":keepalive\n\n");
      }
    }, SSE_KEEPALIVE_INTERVAL);
    cleanup.add(() => clearInterval(keepaliveId));

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
        } catch (error) {
          console.error("[Routes] Store error:", error);
        }
      }
      finish(false, true);
    };
    res.on("close", onClose);
    cleanup.add(() => res.removeListener("close", onClose));

    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
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

        const authErr = allowAuthRetry && isAuthError(cliError);
        if (!authErr && !clientDisconnected && !res.writableEnded) {
          writeStreamingError(res, cliError);
        }
        finish(false, false, authErr);
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
      } catch (error) {
        console.error("[Routes] Store error:", error);
      }

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
      } catch (metricError) {
        console.error("[Routes] Metric error:", metricError);
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

    subprocess.start(cliInput.prompt, {
      model: cliInput.model,
      sessionId: cliInput.sessionId,
      systemPrompt: cliInput.systemPrompt,
      isResume: cliInput.isResume,
      thinkingBudget: cliInput.thinkingBudget,
      thinkingEffort: cliInput.thinkingEffort,
      reasoningMode: cliInput.reasoningMode,
    }).catch((error: Error) => {
      logError("request.error", error, {
        requestId,
        reason: "subprocess_start_failed",
      });
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
  });
}

export async function handleStreamingResponse(
  res: Response,
  cliInput: CliInput,
  requestId: string,
  registerCancel?: (cancel: (error: ClaudeProxyError) => void) => void,
): Promise<void> {
  startStreamingResponse(res, requestId);

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
    { requestId, conversationId: cliInput._conversationId },
  );

  if (result.success || result.cancelled) return;

  if (!res.writableEnded) {
    log("request.retry", {
      requestId,
      conversationId: cliInput._conversationId,
    });

    const retryCli: CliInput = { ...cliInput };
    if (retryCli.isResume && cliInput._conversationId) {
      sessionManager.markFailed(cliInput._conversationId);
      retryCli.isResume = false;
      const { sessionId } = sessionManager.getOrCreate(
        cliInput._conversationId,
        cliInput.model,
      );
      retryCli.sessionId = sessionId;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

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
  const timeout = hasActiveReasoning(cliInput) ? baseTimeout * 3 : baseTimeout;

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
        } catch (error) {
          console.error("[Routes] Store error:", error);
        }

        if (cliInput._conversationId && cliInput.isResume) {
          sessionManager.markSuccess(cliInput._conversationId);
        }

        if (!res.headersSent) {
          res.json(cliResultToOpenai(finalResult, requestId, cliInput.model));
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

    subprocess.start(cliInput.prompt, {
      model: cliInput.model,
      sessionId: cliInput.sessionId,
      systemPrompt: cliInput.systemPrompt,
      isResume: cliInput.isResume,
      thinkingBudget: cliInput.thinkingBudget,
      thinkingEffort: cliInput.thinkingEffort,
      reasoningMode: cliInput.reasoningMode,
    }).catch((error: Error) => {
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

export async function handleNonStreamingResponse(
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
    { requestId, conversationId: cliInput._conversationId },
  );
}
