import { runtimeConfig } from "../config.js";
import type { LogEntry } from "../logger.js";
import {
  proxyMetrics,
  type RuntimeMetricsSnapshot,
} from "../observability/metrics.js";
import {
  sessionManager,
  type SessionMapping,
} from "../session/manager.js";
import {
  subprocessRegistry,
  type ActiveSubprocessSnapshot,
} from "../subprocess/manager.js";
import {
  conversationStore,
  type ConversationMessageRecord,
  type RecentConversationSummary,
} from "../store/conversation.js";
import {
  type ActiveRequestSnapshot,
  conversationRequestQueue,
} from "./request-queue.js";
import { buildQueueSnapshot } from "./queue-snapshot.js";
import { responseConversationStore } from "./response-conversations.js";
import {
  buildCapabilitiesSummary,
  collectOperationalSnapshot,
} from "./runtime-snapshot.js";
import { getExecutionStats } from "./chat-execution.js";
import { opsLogBuffer } from "./ops-log-buffer.js";
import { getPublicExternalProviderInfos } from "../external-providers.js";
import type { PublicExternalProviderInfo } from "../external-provider-types.js";

export interface OpsSnapshotOptions {
  logLimit?: number;
  conversationLimit?: number;
  now?: number;
}

export interface OpsConversationSummary {
  conversationId: string;
  createdAtMs: number;
  updatedAtMs: number;
  ageMs: number;
  idleMs: number;
  model: string | null;
  sessionId: string | null;
  messageCount: number;
  lastRole: string | null;
  lastMessageAtMs: number | null;
  lastMessagePreview: string | null;
  status: "active" | "queued" | "idle";
  activeDurationMs: number | null;
  queueWaitMs: number | null;
}

export interface OpsSessionSummary {
  conversationId: string;
  sessionId: string;
  sessionIdShort: string;
  model: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  ageMs: number;
  idleMs: number;
  taskCount: number;
  resumeFailures: number;
  contextTokens: number;
}

export interface OpsQueueConversation {
  conversationId: string;
  queued: number;
  processing: boolean;
  waitMs: number | null;
  active: boolean;
  activeRequestId: string | null;
  activeDurationMs: number | null;
  stream: boolean | null;
}

export interface OpsAvailabilitySnapshot {
  checkedAtMs: number | null;
  auth: unknown | null;
  cli: unknown | null;
  available: Array<{ id: string; family: string }>;
  unavailable: Array<{
    id: string;
    family: string;
    code: string | null;
    message: string;
  }>;
  capabilities: {
    responses: boolean;
    adaptiveReasoningModels: string[];
    cli: unknown | null;
  };
}

export interface OpsConversationDetailSnapshot {
  conversationId: string;
  conversation: Record<string, unknown> | undefined;
  messages: ConversationMessageRecord[];
  activeRequest: ActiveRequestSnapshot | null;
  queue: OpsQueueConversation | null;
  session: OpsSessionSummary | null;
}

export interface OpsDashboardSnapshot {
  generatedAt: string;
  status: "ok" | "unhealthy";
  unhealthyReason?: string;
  config: {
    sameConversationPolicy: string;
    maxConcurrentRequests: number;
    debugQueues: boolean;
    enableAdminApi: boolean;
    defaultAgent: string | null;
    externalProviders: PublicExternalProviderInfo[];
  };
  runtime: RuntimeMetricsSnapshot;
  queue: {
    queuedRequests: number;
    queuedConversations: number;
    oldestQueueWaitMs: number;
    maxConcurrentRequests: number;
    utilizationRatio: number;
    activeRequests: ActiveRequestSnapshot[];
    conversations: OpsQueueConversation[];
  };
  sessions: OpsSessionSummary[];
  subprocesses: ActiveSubprocessSnapshot[];
  recentConversations: OpsConversationSummary[];
  recentLogs: LogEntry[];
  availability: OpsAvailabilitySnapshot;
  pool: RuntimeMetricsSnapshot["pool"];
  store: RuntimeMetricsSnapshot["store"];
  recentErrors: Array<Record<string, unknown>>;
  healthMetrics: Array<Record<string, unknown>> | null;
  failureStats: RuntimeMetricsSnapshot["sessionFailureStats"];
  consecutiveAuthFailures: number;
  stallDetections: number;
  responseConversationEntries: number;
  metricSnapshot: ReturnType<typeof proxyMetrics.getJsonSnapshot>;
}

function truncatePreview(value: string | null, maxChars = 180): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}…`;
}

function buildSessionSummary(
  session: SessionMapping,
  now: number,
): OpsSessionSummary {
  return {
    conversationId: session.clawdbotId,
    sessionId: session.claudeSessionId,
    sessionIdShort: session.claudeSessionId.slice(0, 8),
    model: session.model,
    createdAtMs: session.createdAt,
    lastUsedAtMs: session.lastUsedAt,
    ageMs: Math.max(0, now - session.createdAt),
    idleMs: Math.max(0, now - session.lastUsedAt),
    taskCount: session.taskCount ?? 0,
    resumeFailures: session.resumeFailures ?? 0,
    contextTokens: sessionManager.getContextSizeEstimate(session.clawdbotId),
  };
}

export function buildRuntimeMetricsSnapshot(params: {
  activeRequests: ActiveRequestSnapshot[];
  queue: ReturnType<typeof buildQueueSnapshot>;
  operational: Awaited<ReturnType<typeof collectOperationalSnapshot>>;
}): RuntimeMetricsSnapshot {
  const { activeRequests, queue, operational } = params;
  return {
    activeRequests: activeRequests.length,
    queuedRequests: queue.queuedRequests,
    queuedConversations: queue.queuedConversations,
    oldestQueueWaitMs: queue.oldestQueueWaitMs,
    responseConversationEntries: responseConversationStore.size,
    activeSubprocesses: operational.activePids.length,
    activeSessions: sessionManager.size,
    sessionFailureStats: operational.failureStats,
    store: operational.storeStats,
    pool: operational.poolStatus,
    modelAvailability: operational.availability
      ? {
          available: operational.availability.available.length,
          unavailable: operational.availability.unavailable.length,
          consecutiveAuthFailures: operational.consecutiveAuthFailures,
          lastCheckedAt: new Date(
            operational.availability.checkedAt,
          ).toISOString(),
        }
      : {
          available: 0,
          unavailable: 0,
          consecutiveAuthFailures: operational.consecutiveAuthFailures,
        },
  };
}

function buildAvailabilitySnapshot(
  operational: Awaited<ReturnType<typeof collectOperationalSnapshot>>,
): OpsAvailabilitySnapshot {
  if (!operational.availability) {
    return {
      checkedAtMs: null,
      auth: null,
      cli: null,
      available: [],
      unavailable: [],
      capabilities: {
        responses: true,
        adaptiveReasoningModels: [],
        cli: null,
      },
    };
  }

  return {
    checkedAtMs: operational.availability.checkedAt,
    auth: operational.availability.auth ?? null,
    cli: operational.availability.cli ?? null,
    available: operational.availability.available.map((model) => ({
      id: model.id,
      family: model.family,
    })),
    unavailable: operational.availability.unavailable.map((entry) => ({
      id: entry.definition.id,
      family: entry.definition.family,
      code: entry.error.code,
      message: entry.error.message,
    })),
    capabilities: buildCapabilitiesSummary(operational.availability),
  };
}

export async function collectOpsDashboardSnapshot(
  options: OpsSnapshotOptions = {},
): Promise<OpsDashboardSnapshot> {
  const now = options.now ?? Date.now();
  const operational = await collectOperationalSnapshot();
  const activeRequests = conversationRequestQueue.getActiveRequests(now);
  const queueSnapshot = buildQueueSnapshot(
    conversationRequestQueue.getQueueEntries(),
    now,
  );
  const runtime = buildRuntimeMetricsSnapshot({
    activeRequests,
    queue: queueSnapshot,
    operational,
  });
  const activeByConversation = new Map(
    activeRequests.map((entry) => [entry.conversationId, entry]),
  );
  const queueConversations = Object.entries(queueSnapshot.queueStatus)
    .map(([conversationId, entry]) => {
      const active = activeByConversation.get(conversationId);
      return {
        conversationId,
        queued: entry.queued,
        processing: entry.processing,
        waitMs: entry.waitMs ?? null,
        active: Boolean(active),
        activeRequestId: active?.requestId ?? null,
        activeDurationMs: active?.durationMs ?? null,
        stream: active?.stream ?? null,
      };
    })
    .sort((left, right) => {
      if (left.active !== right.active) {
        return left.active ? -1 : 1;
      }
      const leftWait = left.waitMs ?? -1;
      const rightWait = right.waitMs ?? -1;
      return rightWait - leftWait;
    });

  let recentConversationsRaw: RecentConversationSummary[] = [];
  try {
    recentConversationsRaw = conversationStore.getRecentConversations(
      options.conversationLimit ?? 18,
    );
  } catch {
    recentConversationsRaw = [];
  }

  const recentConversations = recentConversationsRaw.map((conversation) => {
    const active = activeByConversation.get(conversation.id);
    const queue = queueSnapshot.queueStatus[conversation.id];
    return {
      conversationId: conversation.id,
      createdAtMs: conversation.created_at,
      updatedAtMs: conversation.updated_at,
      ageMs: Math.max(0, now - conversation.created_at),
      idleMs: Math.max(0, now - conversation.updated_at),
      model: conversation.model,
      sessionId: conversation.session_id,
      messageCount: conversation.message_count,
      lastRole: conversation.last_role,
      lastMessageAtMs: conversation.last_message_at,
      lastMessagePreview: truncatePreview(conversation.last_content),
      status: active ? "active" : queue ? "queued" : "idle",
      activeDurationMs: active?.durationMs ?? null,
      queueWaitMs: queue?.waitMs ?? null,
    } satisfies OpsConversationSummary;
  });

  const sessions = sessionManager
    .getAll()
    .map((session) => buildSessionSummary(session, now))
    .sort((left, right) => left.lastUsedAtMs - right.lastUsedAtMs)
    .reverse();

  return {
    generatedAt: new Date(now).toISOString(),
    status: operational.authUnhealthy ? "unhealthy" : "ok",
    unhealthyReason: operational.authUnhealthy
      ? `verifyAuth failed ${operational.consecutiveAuthFailures} consecutive times`
      : undefined,
    config: {
      sameConversationPolicy: runtimeConfig.sameConversationPolicy,
      maxConcurrentRequests: runtimeConfig.maxConcurrentRequests,
      debugQueues: runtimeConfig.debugQueues,
      enableAdminApi: runtimeConfig.enableAdminApi,
      defaultAgent: runtimeConfig.defaultAgent ?? null,
      externalProviders: getPublicExternalProviderInfos(),
    },
    runtime,
    queue: {
      queuedRequests: queueSnapshot.queuedRequests,
      queuedConversations: queueSnapshot.queuedConversations,
      oldestQueueWaitMs: queueSnapshot.oldestQueueWaitMs,
      maxConcurrentRequests: conversationRequestQueue.getMaxConcurrent(),
      utilizationRatio:
        conversationRequestQueue.getMaxConcurrent() > 0
          ? activeRequests.length / conversationRequestQueue.getMaxConcurrent()
          : 0,
      activeRequests,
      conversations: queueConversations,
    },
    sessions,
    subprocesses: subprocessRegistry.getActiveSnapshots(now),
    recentConversations,
    recentLogs: opsLogBuffer.getEntries(options.logLimit ?? 160),
    availability: buildAvailabilitySnapshot(operational),
    pool: operational.poolStatus,
    store: operational.storeStats,
    recentErrors: operational.recentErrors,
    healthMetrics: operational.healthMetrics,
    failureStats: operational.failureStats,
    consecutiveAuthFailures: operational.consecutiveAuthFailures,
    stallDetections: getExecutionStats().stallDetections,
    responseConversationEntries: responseConversationStore.size,
    metricSnapshot: proxyMetrics.getJsonSnapshot(runtime),
  };
}

export function collectOpsConversationSnapshot(
  conversationId: string,
  limit = 18,
  now = Date.now(),
): OpsConversationDetailSnapshot {
  const activeRequest =
    conversationRequestQueue
      .getActiveRequests(now)
      .find((entry) => entry.conversationId === conversationId) ?? null;
  const queueSnapshot = buildQueueSnapshot(
    conversationRequestQueue.getQueueEntries(),
    now,
  );
  const queueState = queueSnapshot.queueStatus[conversationId];
  const session =
    sessionManager.get(conversationId) ?
      buildSessionSummary(sessionManager.get(conversationId)!, now)
    : null;

  return {
    conversationId,
    conversation: conversationStore.getConversation(conversationId),
    messages: conversationStore.getRecentMessages(conversationId, limit),
    activeRequest,
    queue: queueState
      ? {
          conversationId,
          queued: queueState.queued,
          processing: queueState.processing,
          waitMs: queueState.waitMs ?? null,
          active: Boolean(activeRequest),
          activeRequestId: activeRequest?.requestId ?? null,
          activeDurationMs: activeRequest?.durationMs ?? null,
          stream: activeRequest?.stream ?? null,
        }
      : null,
    session,
  };
}
