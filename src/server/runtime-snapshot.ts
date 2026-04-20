import { hasConfiguredExternalProvider } from "../external-providers.js";
import { supportsAdaptiveReasoningModel } from "../models.js";
import { modelAvailability } from "../model-availability.js";
import { conversationStore } from "../store/conversation.js";
import { subprocessPool } from "../subprocess/pool.js";
import { subprocessRegistry } from "../subprocess/manager.js";
import { sessionManager } from "../session/manager.js";

export interface OperationalSnapshot {
  healthMetrics: Array<Record<string, unknown>> | null;
  storeStats: {
    conversations: number;
    messages: number;
    metrics: number;
  } | null;
  recentErrors: Array<Record<string, unknown>>;
  poolStatus: ReturnType<typeof subprocessPool.getStatus> | null;
  availability: Awaited<ReturnType<typeof modelAvailability.getSnapshot>> | null;
  activePids: number[];
  failureStats: ReturnType<typeof sessionManager.getFailureStats>;
  consecutiveAuthFailures: number;
  authUnhealthy: boolean;
}

export async function collectOperationalSnapshot(): Promise<OperationalSnapshot> {
  let healthMetrics: Array<Record<string, unknown>> | null = null;
  let storeStats: {
    conversations: number;
    messages: number;
    metrics: number;
  } | null = null;
  let recentErrors: Array<Record<string, unknown>> = [];
  let poolStatus: ReturnType<typeof subprocessPool.getStatus> | null = null;
  let availability: Awaited<
    ReturnType<typeof modelAvailability.getSnapshot>
  > | null = null;

  try {
    healthMetrics = conversationStore.getHealthMetrics(60);
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

  const consecutiveAuthFailures = modelAvailability.getConsecutiveAuthFailures();
  const authUnhealthy = consecutiveAuthFailures >= 3 &&
    !hasConfiguredExternalProvider();

  return {
    healthMetrics,
    storeStats,
    recentErrors,
    poolStatus,
    availability,
    activePids: subprocessRegistry.getActivePids(),
    failureStats: sessionManager.getFailureStats(),
    consecutiveAuthFailures,
    authUnhealthy,
  };
}

export function buildCapabilitiesSummary(
  availability: Awaited<ReturnType<typeof modelAvailability.getSnapshot>>,
): {
  responses: boolean;
  adaptiveReasoningModels: string[];
  cli: typeof availability.cli;
} {
  return {
    responses: true,
    adaptiveReasoningModels: availability.available
      .map((model) => model.id)
      .filter((model) => supportsAdaptiveReasoningModel(model)),
    cli: availability.cli,
  };
}
