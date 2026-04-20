/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for local AI tools and SDKs.
 *
 * CONCURRENCY MODEL: Queue-and-Serialize per conversation.
 * - Each conversation gets a FIFO queue
 * - Requests for the same conversation are processed according to the configured policy
 * - Different conversations run fully in parallel
 * - Requests end in completion, timeout, or explicit cancellation
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
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { sessionManager } from "../session/manager.js";
import { conversationStore } from "../store/conversation.js";
import { getModelTimeout, isValidModel, supportsAdaptiveReasoningModel } from "../models.js";
import { log, logError } from "../logger.js";
import { modelAvailability } from "../model-availability.js";
import { type ClaudeProxyError } from "../claude-cli.inspect.js";
import { runtimeConfig, persistRuntimeState } from "../config.js";
import {
  chatToResponsesResponse,
  responsesToChatRequest,
} from "../adapter/responses.js";
import {
  applyAgentProfile,
  getBuiltinAgent,
  listBuiltinAgents,
} from "../agents.js";
import type { OpenAIChatRequest, OpenAIChatResponse } from "../types/openai.js";
import type { OpenAIResponsesRequest } from "../types/responses.js";
import {
  REASONING_EFFORT_MAP,
  parseEffortOrTokens,
  resolveReasoningConfig,
} from "../reasoning.js";
import { proxyMetrics } from "../observability/metrics.js";
import { responseConversationStore } from "./response-conversations.js";
import {
  buildCapabilitiesSummary,
  collectOperationalSnapshot,
} from "./runtime-snapshot.js";
import {
  getExecutionStats,
  handleNonStreamingResponse,
  handleStreamingResponse,
  respondWithError,
  sendJsonError,
} from "./chat-execution.js";
import { buildQueueSnapshot } from "./queue-snapshot.js";
import {
  conversationRequestQueue,
  MAX_QUEUE_DEPTH,
  RequestCancelledError,
} from "./request-queue.js";
export { isAuthError, withAuthRetry } from "./auth-retry.js";

// ---------------------------------------------------------------------------
// Responses API compatibility
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleChatCompletions(
  req: Request,
  res: Response,
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const requestedAgentId =
    typeof req.params?.agentId === "string" ? req.params.agentId : undefined;
  const rawBody = (req.body ?? {}) as OpenAIChatRequest & Record<string, unknown>;
  if (
    !rawBody.messages ||
    !Array.isArray(rawBody.messages) ||
    rawBody.messages.length === 0
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

  const bodyAgentId =
    typeof rawBody.agent === "string" && rawBody.agent.trim()
      ? rawBody.agent.trim()
      : undefined;
  const unknownAgentId =
    (requestedAgentId && !getBuiltinAgent(requestedAgentId)
      ? requestedAgentId
      : undefined) ||
    (bodyAgentId && !getBuiltinAgent(bodyAgentId) ? bodyAgentId : undefined) ||
    (runtimeConfig.defaultAgent && !getBuiltinAgent(runtimeConfig.defaultAgent)
      ? runtimeConfig.defaultAgent
      : undefined);
  if (unknownAgentId) {
    res.status(400).json({
      error: {
        message: `Unknown agent '${unknownAgentId}'. Use GET /v1/agents to see the built-in agent catalog.`,
        type: "invalid_request_error",
        code: "agent_not_found",
      },
    });
    return;
  }

  const { request: effectiveRequest, agent } = applyAgentProfile(rawBody, {
    explicitAgentId: requestedAgentId,
    defaultAgentId: runtimeConfig.defaultAgent,
  });
  const body = effectiveRequest as OpenAIChatRequest & Record<string, unknown>;
  const stream = body.stream === true;
  const requestedModel = body.model ? String(body.model) : undefined;

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

  const reasoning = resolveReasoningConfig({
    body,
    headerBudget: req.header("x-thinking-budget") || undefined,
    runtimeDefault: runtimeConfig.defaultThinkingBudget,
    resolvedModel: resolvedModel.id,
    cliVersion: availability.cli?.version,
  });
  if (reasoning.requiresCliUpgrade) {
    sendJsonError(res, {
      status: 400,
      type: "invalid_request_error",
      code: "adaptive_reasoning_requires_cli_upgrade",
      message: `Model '${resolvedModel.id}' expects adaptive reasoning, but the installed Claude CLI (${availability.cli?.version || "unknown"}) is too old. Upgrade Claude Code CLI to 2.1.111 or newer.`,
    });
    return;
  }

  const conversationId = (body.user as string) || requestId;
  if (runtimeConfig.sameConversationPolicy === "latest-wins") {
    conversationRequestQueue.applyLatestWins(conversationId, requestId);
  }

  const startTime = Date.now();
  const queueDepth = conversationRequestQueue.getQueueDepth(conversationId);

  if (queueDepth >= MAX_QUEUE_DEPTH) {
    conversationRequestQueue.logBlockedRequest(
      conversationId,
      requestId,
      queueDepth,
    );
    res.status(429).json({
      error: {
        message: `Too many queued requests for this conversation (${queueDepth}). Please wait for current requests to complete.`,
        type: "rate_limit_error",
        code: "queue_full",
      },
    });
    return;
  }

  const tempModel = requestedModel || resolvedModel.id;
  const baseTimeout = getModelTimeout(tempModel);
  const hardTimeout = reasoning.active ? baseTimeout * 3 : baseTimeout;

  log("request.start", {
    requestId,
    conversationId,
    model: tempModel,
    stream,
    agent: agent?.id,
    queueDepth,
    reasoningMode: reasoning.mode,
    reasoningSource: reasoning.source,
    reasoningEffort: reasoning.effort,
    reasoningBudget: reasoning.budgetTokens,
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
          cliInput.reasoningMode = reasoning.mode;
          if (reasoning.effort) {
            cliInput.thinkingEffort = reasoning.effort;
          }
          if (reasoning.budgetTokens) {
            cliInput.thinkingBudget = reasoning.budgetTokens;
          }

          if (stream) {
            await handleStreamingResponse(
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

function buildCapabilitiesPayload(
  availability: Awaited<ReturnType<typeof modelAvailability.getSnapshot>> | null,
): Record<string, unknown> {
  const agents = listBuiltinAgents();
  const availableModels = availability?.available.map((model) => model.id) || [];
  const adaptiveModels = availableModels.filter((model) =>
    supportsAdaptiveReasoningModel(model),
  );
  const fixedBudgetModels = availableModels.filter(
    (model) => !supportsAdaptiveReasoningModel(model),
  );

  return {
    object: "capabilities",
    provider: "claude-max-api-proxy",
    endpoints: {
      health: "/health",
      models: "/v1/models",
      chatCompletions: "/v1/chat/completions",
      responses: "/v1/responses",
      capabilities: "/v1/capabilities",
    },
    compatibility: {
      chatCompletions: true,
      responses: true,
      streamingChatCompletions: true,
      streamingResponses: false,
      tools: false,
      structuredOutputs: false,
      mcpServer: false,
    },
    agents: {
      default: runtimeConfig.defaultAgent ?? null,
      available: agents,
      routes: {
        list: "/v1/agents",
        details: "/v1/agents/:agentId",
        chatCompletions: "/v1/agents/:agentId/chat/completions",
        responses: "/v1/agents/:agentId/responses",
      },
    },
    reasoning: {
      supportedInputs: [
        "thinking",
        "reasoning",
        "reasoning_effort",
        "output_config.effort",
        "X-Thinking-Budget",
      ],
      allowedLabels: Object.keys(REASONING_EFFORT_MAP),
      defaultBudget: runtimeConfig.defaultThinkingBudget ?? null,
      adaptiveModels,
      fixedBudgetModels,
    },
    models: {
      available: availableModels,
    },
    cli: availability?.cli ?? null,
  };
}

export async function handleCapabilities(
  _req: Request,
  res: Response,
): Promise<void> {
  let availability: Awaited<ReturnType<typeof modelAvailability.getSnapshot>> | null =
    null;
  try {
    availability = await modelAvailability.getSnapshot();
  } catch {
    /* surface whatever static capability data we still have */
  }
  res.json(buildCapabilitiesPayload(availability));
}

export function handleAgents(_req: Request, res: Response): void {
  res.json({
    object: "list",
    data: listBuiltinAgents(),
    default: runtimeConfig.defaultAgent ?? null,
  });
}

export function handleAgentDetails(req: Request, res: Response): void {
  const agentId = typeof req.params?.agentId === "string" ? req.params.agentId : "";
  const agent = getBuiltinAgent(agentId);
  if (!agent) {
    res.status(404).json({
      error: {
        message: `Unknown agent '${agentId}'`,
        type: "invalid_request_error",
        code: "agent_not_found",
      },
    });
    return;
  }
  res.json(agent);
}

export async function handleResponses(
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as OpenAIResponsesRequest;
  if (body.stream) {
    res.status(400).json({
      error: {
        message:
          "POST /v1/responses currently supports non-streaming responses only. Use POST /v1/chat/completions with stream=true for streaming.",
        type: "invalid_request_error",
        code: "stream_not_supported",
      },
    });
    return;
  }

  const previousConversationId = responseConversationStore.get(
    body.previous_response_id,
  );
  if (body.previous_response_id && !previousConversationId) {
    res.status(400).json({
      error: {
        message: `Unknown previous_response_id '${body.previous_response_id}'. Reuse a response id returned by this proxy.`,
        type: "invalid_request_error",
        code: "invalid_previous_response_id",
      },
    });
    return;
  }

  const responseSeed = uuidv4().replace(/-/g, "").slice(0, 24);
  const conversationId =
    previousConversationId || body.user || `respconv_${responseSeed}`;
  const chatRequest = responsesToChatRequest(body, conversationId);
  if (
    !Array.isArray(chatRequest.messages) ||
    chatRequest.messages.length === 0 ||
    chatRequest.messages.every((message) => {
      if (typeof message.content === "string") {
        return !message.content.trim();
      }
      return false;
    })
  ) {
    res.status(400).json({
      error: {
        message: "input is required and must contain at least one text item",
        type: "invalid_request_error",
        code: "invalid_input",
      },
    });
    return;
  }

  const wrappedReq = Object.assign(Object.create(req), {
    body: chatRequest,
  }) as Request;
  const originalJson = res.json.bind(res);
  res.json = ((payload: unknown) => {
    if (payload && typeof payload === "object" && "error" in payload) {
      return originalJson(payload);
    }
    const responseId = `resp_${responseSeed}`;
    responseConversationStore.remember(responseId, conversationId);
    return originalJson(
      chatToResponsesResponse(payload as OpenAIChatResponse, {
        responseId,
        previousResponseId: body.previous_response_id,
      }),
    );
  }) as typeof res.json;

  await handleChatCompletions(wrappedReq, res);
}

// ---------------------------------------------------------------------------
// Enhanced health endpoint (Phase 4b)
// ---------------------------------------------------------------------------

export async function handleHealth(
  _req: Request,
  res: Response,
): Promise<void> {
  const snapshot = await collectOperationalSnapshot();
  const queueSnapshot = buildQueueSnapshot(
    conversationRequestQueue.getQueueEntries(),
  );
  const executionStats = getExecutionStats();

  if (snapshot.authUnhealthy) {
    res.status(503);
  }

  res.json({
    status: snapshot.authUnhealthy ? "unhealthy" : "ok",
    unhealthyReason: snapshot.authUnhealthy
      ? `verifyAuth failed ${snapshot.consecutiveAuthFailures} consecutive times`
      : undefined,
    provider: "claude-max-api-proxy",
    timestamp: new Date().toISOString(),
    consecutiveAuthFailures: snapshot.consecutiveAuthFailures,
    sessions: {
      active: sessionManager.size,
      failureStats: snapshot.failureStats,
    },
    subprocesses: {
      active: snapshot.activePids.length,
      pids: snapshot.activePids,
    },
    config: {
      sameConversationPolicy: runtimeConfig.sameConversationPolicy,
      debugQueues: runtimeConfig.debugQueues,
      enableAdminApi: runtimeConfig.enableAdminApi,
      defaultAgent: runtimeConfig.defaultAgent ?? null,
    },
    auth: snapshot.availability?.auth ?? undefined,
    models: snapshot.availability
      ? {
          checkedAt: new Date(snapshot.availability.checkedAt).toISOString(),
          available: snapshot.availability.available.map((model) => model.id),
          unavailable: snapshot.availability.unavailable.map((entry) => ({
            id: entry.definition.id,
            code: entry.error.code,
            message: entry.error.message,
          })),
        }
      : undefined,
    capabilities: snapshot.availability
      ? buildCapabilitiesSummary(snapshot.availability)
      : buildCapabilitiesPayload(null),
    pool: snapshot.poolStatus,
    store: snapshot.storeStats,
    metrics: snapshot.healthMetrics,
    recentErrors: snapshot.recentErrors,
    stallDetections: executionStats.stallDetections,
    queues:
      Object.keys(queueSnapshot.queueStatus).length > 0
        ? queueSnapshot.queueStatus
        : undefined,
  });
}

export async function handleMetrics(
  req: Request,
  res: Response,
): Promise<void> {
  const snapshot = await collectOperationalSnapshot();
  const queueSnapshot = buildQueueSnapshot(
    conversationRequestQueue.getQueueEntries(),
  );

  const runtime = {
    activeRequests: conversationRequestQueue.getActiveRequestCount(),
    queuedRequests: queueSnapshot.queuedRequests,
    queuedConversations: queueSnapshot.queuedConversations,
    oldestQueueWaitMs: queueSnapshot.oldestQueueWaitMs,
    responseConversationEntries: responseConversationStore.size,
    activeSubprocesses: snapshot.activePids.length,
    activeSessions: sessionManager.size,
    sessionFailureStats: snapshot.failureStats,
    store: snapshot.storeStats,
    pool: snapshot.poolStatus,
    modelAvailability: snapshot.availability
      ? {
          available: snapshot.availability.available.length,
          unavailable: snapshot.availability.unavailable.length,
          consecutiveAuthFailures: snapshot.consecutiveAuthFailures,
          lastCheckedAt: new Date(snapshot.availability.checkedAt).toISOString(),
        }
      : {
          available: 0,
          unavailable: 0,
          consecutiveAuthFailures: snapshot.consecutiveAuthFailures,
        },
  };

  if (req.query.format === "json") {
    res.json(proxyMetrics.getJsonSnapshot(runtime));
    return;
  }

  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(proxyMetrics.renderPrometheus(runtime));
}
