import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess, subprocessRegistry } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, createDoneChunk, estimateTokens, validateTokens } from "../adapter/cli-to-openai.js";
import { sessionManager } from "../session/manager.js";
import { conversationStore } from "../store/conversation.js";
import { subprocessPool } from "../subprocess/pool.js";
import { getModelTimeout, getStallTimeout, isValidModel, getModelList } from "../models.js";
import { log, logError } from "../logger.js";
const conversationQueues = new Map();
/**
 * Enqueue a request for a conversation and process sequentially.
 * Phase 3a: Wraps handler with an absolute queue timeout.
 * Phase 5a: Scale timeout buffer based on queue depth to prevent stacking timeouts
 */
function enqueueRequest(conversationId, handler, hardTimeoutMs) {
    return new Promise((resolve, reject) => {
        let entry = conversationQueues.get(conversationId);
        if (!entry) {
            entry = { queue: [], processing: false };
            conversationQueues.set(conversationId, entry);
        }
        // Phase 5a: Scale buffer based on queue position - 60s per item in queue
        const queuePosition = entry.queue.length;
        const queueBufferMs = Math.max(60000, queuePosition * 60000);
        const queueTimeoutMs = hardTimeoutMs + queueBufferMs;
        const item = {
            handler: () => {
                // Wrap handler in a race with the queue timeout
                return new Promise((handlerResolve, handlerReject) => {
                    const queueTimer = setTimeout(() => {
                        log("queue.timeout", { conversationId, timeoutMs: queueTimeoutMs });
                        handlerReject(new Error(`Queue timeout after ${queueTimeoutMs / 1000}s`));
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
        if (!entry.processing) {
            processQueue(conversationId);
        }
    });
}
/**
 * Process the next item in a conversation's queue.
 * Phase 3a: Uses finally to guarantee queue always advances.
 */
async function processQueue(conversationId) {
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
    const item = entry.queue.shift();
    try {
        const result = await item.handler();
        item.resolve(result);
    }
    catch (err) {
        item.reject(err);
    }
    finally {
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
    fns = new Set();
    ran = false;
    add(fn) {
        if (!this.ran) {
            this.fns.add(fn);
        }
    }
    runAll() {
        if (this.ran)
            return;
        this.ran = true;
        for (const fn of this.fns) {
            try {
                fn();
            }
            catch (e) {
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
const DISCONNECT_GRACE_MS = 60000;
// ---------------------------------------------------------------------------
// Stall detection stats (Phase 4b)
// ---------------------------------------------------------------------------
let stallDetections = 0;
// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export async function handleChatCompletions(req, res) {
    const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
    const body = req.body;
    const stream = body.stream === true;
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        res.status(400).json({
            error: {
                message: "messages is required and must be a non-empty array",
                type: "invalid_request_error",
                code: "invalid_messages",
            },
        });
        return;
    }
    if (body.model && !isValidModel(body.model)) {
        res.status(400).json({
            error: {
                message: `Model '${body.model}' is not supported. Use GET /v1/models for available models.`,
                type: "invalid_request_error",
                code: "model_not_found",
            },
        });
        return;
    }
    const startTime = Date.now();
    const conversationId = body.user || requestId;
    const queueEntry = conversationQueues.get(conversationId);
    const queueDepth = queueEntry ? queueEntry.queue.length : 0;
    const MAX_QUEUE_DEPTH = 5;
    if (queueDepth >= MAX_QUEUE_DEPTH) {
        log("queue.blocked", { conversationId, depth: queueDepth });
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
    const thinking = body.thinking;
    const tempModel = body.model ? String(body.model) : "sonnet";
    const baseTimeout = getModelTimeout(tempModel);
    const hardTimeout = (thinking?.type === "enabled" && thinking.budget_tokens) ? baseTimeout * 3 : baseTimeout;
    log("request.start", { requestId, conversationId, model: tempModel, stream, queueDepth });
    try {
        await enqueueRequest(conversationId, async () => {
            const { sessionId, isResume } = sessionManager.getOrCreate(conversationId, body.model);
            // Phase 5d: Log session context size for token accounting
            if (isResume) {
                const contextSize = sessionManager.getContextSizeEstimate(conversationId);
                log("session.context", { conversationId, estimatedContextTokens: contextSize, isResume });
            }
            conversationStore.ensureConversation(conversationId, body.model, sessionId);
            const messages = body.messages;
            const lastUserMsg = messages.filter(m => m.role === "user").pop();
            if (lastUserMsg) {
                const content = typeof lastUserMsg.content === "string"
                    ? lastUserMsg.content
                    : JSON.stringify(lastUserMsg.content);
                conversationStore.addMessage(conversationId, "user", content);
            }
            const cliInput = openaiToCli(body, isResume);
            cliInput.sessionId = sessionId;
            cliInput.isResume = isResume;
            cliInput._conversationId = conversationId;
            cliInput._startTime = startTime;
            if (thinking?.type === "enabled" && thinking.budget_tokens) {
                cliInput.thinkingBudget = thinking.budget_tokens;
            }
            if (stream) {
                await handleStreamingResponse(req, res, cliInput, requestId);
            }
            else {
                await handleNonStreamingResponse(res, cliInput, requestId);
            }
        }, hardTimeout);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logError("request.error", error, { requestId, conversationId });
        if (!res.headersSent) {
            res.status(500).json({
                error: { message, type: "server_error", code: null },
            });
        }
    }
}
/**
 * Single function that wires up all event handlers on a subprocess and
 * returns a promise that resolves when the subprocess completes.
 * Eliminates the duplicated event handler wiring from the old retry logic.
 */
function runStreamingSubprocess(opts) {
    const { cliInput, requestId, res, onStall } = opts;
    const baseTimeout = getModelTimeout(cliInput.model);
    const hardTimeout = cliInput.thinkingBudget ? baseTimeout * 3 : baseTimeout;
    const stallTimeout = cliInput.thinkingBudget
        ? getStallTimeout(cliInput.model) * 3 // thinking blocks can take a long time before first text
        : getStallTimeout(cliInput.model);
    return new Promise((resolve) => {
        const subprocess = new ClaudeSubprocess();
        const cleanup = new CleanupSet();
        let isFirst = true;
        let lastModel = "claude-sonnet-4";
        let isComplete = false;
        let fullResponse = "";
        let clientDisconnected = false;
        let lastActivityAt = Date.now();
        const spawnTime = Date.now();
        let firstByteTime = 0;
        const chunkId = `chatcmpl-${requestId}`;
        const buildChunk = (text, model, first) => {
            const escaped = JSON.stringify(text);
            const ts = Math.floor(Date.now() / 1000);
            if (first) {
                return `data: {"id":"${chunkId}","object":"chat.completion.chunk","created":${ts},"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":${escaped}},"finish_reason":null}]}\n\n`;
            }
            return `data: {"id":"${chunkId}","object":"chat.completion.chunk","created":${ts},"model":"${model}","choices":[{"index":0,"delta":{"content":${escaped}},"finish_reason":null}]}\n\n`;
        };
        const finish = (success) => {
            if (isComplete)
                return;
            isComplete = true;
            cleanup.runAll();
            resolve({ fullResponse, success });
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
                    res.write(`data: ${JSON.stringify({
                        error: { message: `Request timed out after ${hardTimeout / 1000}s`, type: "timeout_error", code: null },
                    })}\n\n`);
                    res.write("data: [DONE]\n\n");
                    res.end();
                }
                finish(false);
            }
        }, hardTimeout);
        cleanup.add(() => clearTimeout(hardTimeoutId));
        // Stall detection (Phase 1a): check periodically if lastActivityAt has gone stale
        // Phase 5b: Do NOT delete session on stall - it's transient. Only mark as failed for retry logic.
        const stallCheckInterval = setInterval(() => {
            if (isComplete)
                return;
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
                    res.write(`data: ${JSON.stringify({
                        error: { message: `Subprocess stalled (no activity for ${Math.round(stalledFor / 1000)}s)`, type: "timeout_error", code: "stall_detected" },
                    })}\n\n`);
                    res.write("data: [DONE]\n\n");
                    res.end();
                }
                onStall();
                finish(false);
            }
        }, Math.min(stallTimeout / 2, 10000));
        cleanup.add(() => clearInterval(stallCheckInterval));
        // Client disconnect with grace period
        const onClose = () => {
            clientDisconnected = true;
            if (isComplete)
                return;
            const disconnectTimeout = setTimeout(() => {
                if (!isComplete) {
                    log("subprocess.kill", {
                        requestId,
                        pid: subprocess.getPid(),
                        reason: "client_disconnect_grace_expired",
                    });
                    subprocess.kill();
                    if (fullResponse && cliInput._conversationId) {
                        try {
                            conversationStore.addMessage(cliInput._conversationId, "assistant", fullResponse + "\n\n[Response truncated — client disconnected]");
                        }
                        catch (e) {
                            console.error("[Routes] Store error:", e);
                        }
                    }
                    finish(false);
                }
            }, DISCONNECT_GRACE_MS);
            cleanup.add(() => clearTimeout(disconnectTimeout));
        };
        res.on("close", onClose);
        cleanup.add(() => res.removeListener("close", onClose));
        // Event handlers
        subprocess.on("content_delta", (event) => {
            lastActivityAt = Date.now(); // Reset stall timer
            const text = event.event?.delta?.text || "";
            fullResponse += text;
            if (clientDisconnected)
                return;
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
        subprocess.on("assistant", (message) => {
            lastActivityAt = Date.now();
            lastModel = message.message.model;
        });
        subprocess.on("result", (result) => {
            lastActivityAt = Date.now();
            // Phase 5c: Token validation and estimate fallback
            let usageData = null;
            if (result?.usage) {
                const promptTokens = result.usage.input_tokens || 0;
                const completionTokens = result.usage.output_tokens || 0;
                const validation = validateTokens(promptTokens, completionTokens, fullResponse.length);
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
                }
                else {
                    usageData = {
                        prompt_tokens: promptTokens,
                        completion_tokens: completionTokens,
                        total_tokens: promptTokens + completionTokens,
                    };
                }
            }
            else if (fullResponse.length > 0) {
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
                    conversationStore.addMessage(cliInput._conversationId, "assistant", fullResponse);
                }
                conversationStore.recordMetric("request_complete", {
                    conversationId: cliInput._conversationId,
                    durationMs: Date.now() - (cliInput._startTime || Date.now()),
                    success: true,
                    clientDisconnected,
                });
            }
            catch (e) {
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
        subprocess.on("error", (error) => {
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
            }
            catch (e) {
                console.error("[Routes] Metric error:", e);
            }
            if (!clientDisconnected && !res.writableEnded) {
                res.write(`data: ${JSON.stringify({
                    error: { message: error.message, type: "server_error", code: null },
                })}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
            finish(false);
        });
        subprocess.on("close", (code) => {
            if (!isComplete) {
                if (!clientDisconnected && !res.writableEnded) {
                    if (code !== 0) {
                        res.write(`data: ${JSON.stringify({
                            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
                        })}\n\n`);
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
        subprocess.start(cliInput.prompt, startOpts).catch((err) => {
            logError("request.error", err, { requestId, reason: "subprocess_start_failed" });
            if (!clientDisconnected && !res.writableEnded) {
                res.write(`data: ${JSON.stringify({
                    error: { message: err.message, type: "server_error", code: null },
                })}\n\n`);
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
async function handleStreamingResponse(req, res, cliInput, requestId) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(":ok\n\n");
    // First attempt
    const result = await runStreamingSubprocess({
        cliInput,
        requestId,
        res,
        onStall: () => {
            if (cliInput._conversationId) {
                sessionManager.markFailed(cliInput._conversationId);
            }
        },
    });
    if (result.success)
        return;
    // Retry once on failure (Phase 2a: clean retry without duplicated handlers)
    if (!res.writableEnded) {
        log("request.retry", { requestId, conversationId: cliInput._conversationId });
        // If resume failed, retry without resume
        const retryCli = { ...cliInput };
        if (retryCli.isResume && cliInput._conversationId) {
            sessionManager.markFailed(cliInput._conversationId);
            retryCli.isResume = false;
            // Get fresh session
            const { sessionId } = sessionManager.getOrCreate(cliInput._conversationId, cliInput.model);
            retryCli.sessionId = sessionId;
        }
        await new Promise(r => setTimeout(r, 1000)); // Brief backoff
        await runStreamingSubprocess({
            cliInput: retryCli,
            requestId,
            res,
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
async function handleNonStreamingResponse(res, cliInput, requestId) {
    const baseTimeout = getModelTimeout(cliInput.model);
    const timeout = cliInput.thinkingBudget ? baseTimeout * 3 : baseTimeout;
    return new Promise((resolve) => {
        const subprocess = new ClaudeSubprocess();
        const cleanup = new CleanupSet();
        let finalResult = null;
        let isComplete = false;
        const timeoutId = setTimeout(() => {
            if (!isComplete) {
                log("request.timeout", { requestId, conversationId: cliInput._conversationId, timeoutMs: timeout });
                subprocess.kill();
                if (!res.headersSent) {
                    res.status(504).json({
                        error: { message: `Request timed out after ${timeout / 1000}s`, type: "timeout_error", code: null },
                    });
                }
                isComplete = true;
                cleanup.runAll();
                resolve();
            }
        }, timeout);
        cleanup.add(() => clearTimeout(timeoutId));
        subprocess.on("result", (result) => {
            finalResult = result;
        });
        subprocess.on("error", (error) => {
            isComplete = true;
            cleanup.runAll();
            logError("request.error", error, { requestId });
            if (!res.headersSent) {
                res.status(500).json({
                    error: { message: error.message, type: "server_error", code: null },
                });
            }
            resolve();
        });
        subprocess.on("close", (code) => {
            isComplete = true;
            cleanup.runAll();
            if (finalResult) {
                try {
                    if (finalResult.result && cliInput._conversationId) {
                        conversationStore.addMessage(cliInput._conversationId, "assistant", finalResult.result);
                    }
                    conversationStore.recordMetric("request_complete", {
                        conversationId: cliInput._conversationId,
                        durationMs: Date.now() - (cliInput._startTime || Date.now()),
                        success: true,
                    });
                }
                catch (e) {
                    console.error("[Routes] Store error:", e);
                }
                if (cliInput._conversationId && cliInput.isResume) {
                    sessionManager.markSuccess(cliInput._conversationId);
                }
                if (!res.headersSent) {
                    res.json(cliResultToOpenai(finalResult, requestId));
                }
            }
            else if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        message: `Claude CLI exited with code ${code} without response`,
                        type: "server_error",
                        code: null,
                    },
                });
            }
            resolve();
        });
        subprocess.start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
            systemPrompt: cliInput.systemPrompt,
            isResume: cliInput.isResume,
            thinkingBudget: cliInput.thinkingBudget,
        }).catch((error) => {
            cleanup.runAll();
            if (!res.headersSent) {
                res.status(500).json({
                    error: { message: error.message, type: "server_error", code: null },
                });
            }
            resolve();
        });
    });
}
// ---------------------------------------------------------------------------
// Models endpoint
// ---------------------------------------------------------------------------
export function handleModels(_req, res) {
    res.json({
        object: "list",
        data: getModelList(),
    });
}
// ---------------------------------------------------------------------------
// Enhanced health endpoint (Phase 4b)
// ---------------------------------------------------------------------------
export function handleHealth(_req, res) {
    let metrics = null;
    let storeStats = null;
    let poolStatus = null;
    let recentErrors = [];
    try {
        metrics = conversationStore.getHealthMetrics(60);
        storeStats = conversationStore.getStats();
        recentErrors = conversationStore.getRecentErrors(5);
    }
    catch { /* store not initialized yet */ }
    try {
        poolStatus = subprocessPool.getStatus();
    }
    catch { /* pool not ready */ }
    // Queue status
    const queueStatus = {};
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
        pool: poolStatus,
        store: storeStats,
        metrics,
        recentErrors,
        stallDetections,
        queues: Object.keys(queueStatus).length > 0 ? queueStatus : undefined,
    });
}
//# sourceMappingURL=routes.js.map