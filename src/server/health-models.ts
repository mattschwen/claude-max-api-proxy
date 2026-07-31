import type { ExternalProviderAvailability } from "../external-provider-types.js";
import type { ModelAvailabilitySnapshot } from "../model-availability.js";
import type { QueueStatusEntry } from "./queue-snapshot.js";

export interface HealthUnavailableModel {
  id: string;
  provider: string;
  code: string | null;
  message: string;
}

export interface HealthModelSummary {
  checkedAt: string | null;
  advertised: string[];
  available: string[];
  configured: string[];
  unavailable: HealthUnavailableModel[];
}

export interface ExternalProviderAvailabilityEntry {
  provider: string;
  availability: ExternalProviderAvailability;
}

export type PublicModelAvailabilityState =
  | "available"
  | "configured"
  | "unavailable";

export type PublicHealthQueueStatus = Record<
  string,
  Pick<QueueStatusEntry, "queued" | "processing" | "waitMs">
>;

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))];
}

/**
 * Provider-level state is not enough to describe a model. A successful request
 * to one model can make the provider available while its configured siblings
 * remain unprobed, so only the per-model lists may promote or reject a model.
 */
export function resolveExternalModelAvailability(
  modelId: string,
  availability: ExternalProviderAvailability,
): PublicModelAvailabilityState {
  if (availability.availableModels.includes(modelId)) {
    return "available";
  }
  if (availability.unavailableModels.includes(modelId)) {
    return "unavailable";
  }
  return "configured";
}

/**
 * Merge Claude's runtime probe with external-provider probe state.
 *
 * External models remain advertised while a provider is unprobed or degraded,
 * matching `/v1/models`. The separate state arrays prevent "configured" from
 * being mistaken for "confirmed available" by readiness checks.
 */
export function buildHealthModelSummary(
  claude: ModelAvailabilitySnapshot | null,
  externalModels: string[],
  externalProviders: ExternalProviderAvailabilityEntry[],
): HealthModelSummary {
  const externalAvailable = unique(
    externalProviders.flatMap(
      ({ availability }) => availability.availableModels,
    ),
  );
  const externalUnavailable = unique(
    externalProviders.flatMap(
      ({ availability }) => availability.unavailableModels,
    ),
  );
  const knownExternal = new Set([
    ...externalAvailable,
    ...externalUnavailable,
  ]);
  const configured = unique(
    externalModels.filter((model) => !knownExternal.has(model)),
  );
  const checkedAtValues = [
    claude?.checkedAt,
    ...externalProviders.map(({ availability }) => availability.checkedAt),
  ].filter((value): value is number => typeof value === "number");

  return {
    checkedAt:
      checkedAtValues.length > 0
        ? new Date(Math.max(...checkedAtValues)).toISOString()
        : null,
    advertised: unique([
      ...(claude?.available.map((model) => model.id) ?? []),
      ...externalModels,
    ]),
    available: unique([
      ...(claude?.available.map((model) => model.id) ?? []),
      ...externalAvailable,
    ]),
    configured,
    unavailable: [
      ...(claude?.unavailable.map((entry) => ({
        id: entry.definition.id,
        provider: "claude-cli",
        code: entry.error.code,
        message: entry.error.message,
      })) ?? []),
      ...externalProviders.flatMap(({ provider, availability }) =>
        availability.unavailableModels.map((id) => ({
          id,
          provider,
          code: "external_provider_unavailable",
          message: availability.error || "External provider probe failed",
        })),
      ),
    ],
  };
}

/**
 * `/health` is intentionally public, so it must not expose the opaque request
 * IDs that authorize cancellation. The richer local Ops snapshot keeps them.
 */
export function buildPublicHealthQueueStatus(
  queueStatus: Record<string, QueueStatusEntry>,
): PublicHealthQueueStatus {
  return Object.fromEntries(
    Object.entries(queueStatus).map(([conversationId, status]) => [
      conversationId,
      {
        queued: status.queued,
        processing: status.processing,
        waitMs: status.waitMs,
      },
    ]),
  );
}
