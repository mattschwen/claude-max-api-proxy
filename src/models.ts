/**
 * Central model registry
 *
 * Single source of truth for supported models, CLI aliases, timeouts,
 * and the /v1/models endpoint. Add new models here — everything else
 * derives from this list.
 */

export type ModelFamily = "opus" | "sonnet" | "haiku";

export interface ModelDefinition {
  id: string;
  family: ModelFamily;
  alias: string;
  timeoutMs: number;
  /** Activity-based stall timeout — resets on each content_delta */
  stallTimeoutMs: number;
}

/**
 * Each entry: { id, family, alias, timeoutMs, stallTimeoutMs }
 *   id             – OpenAI-compatible model name (what clients send)
 *   family         – model family for grouping (opus, sonnet, haiku)
 *   alias          – CLI --model value
 *   timeoutMs      – absolute wall-clock timeout
 *   stallTimeoutMs – activity timeout (resets on each content_delta)
 */
const MODEL_DEFINITIONS: ModelDefinition[] = [
  // Opus — current model first (becomes canonical via CANONICAL_IDS)
  { id: "claude-opus-4-6", family: "opus",   alias: "opus",   timeoutMs: 1800000, stallTimeoutMs: 120000 },
  { id: "claude-opus-4",   family: "opus",   alias: "opus",   timeoutMs: 1800000, stallTimeoutMs: 120000 },
  { id: "claude-opus-4-5", family: "opus",   alias: "opus",   timeoutMs: 1800000, stallTimeoutMs: 120000 },
  // Sonnet — current model first
  { id: "claude-sonnet-4-6", family: "sonnet", alias: "sonnet", timeoutMs: 600000, stallTimeoutMs: 60000 },
  { id: "claude-sonnet-4",   family: "sonnet", alias: "sonnet", timeoutMs: 600000, stallTimeoutMs: 60000 },
  { id: "claude-sonnet-4-5", family: "sonnet", alias: "sonnet", timeoutMs: 600000, stallTimeoutMs: 60000 },
  // Haiku — current model first
  { id: "claude-haiku-4-5", family: "haiku", alias: "haiku", timeoutMs: 120000, stallTimeoutMs: 30000 },
  { id: "claude-haiku-4",   family: "haiku", alias: "haiku", timeoutMs: 120000, stallTimeoutMs: 30000 },
];

// Provider prefixes that clients may prepend
const PROVIDER_PREFIXES = ["maxproxy/", "claude-code-cli/"];

interface ModelLookupEntry {
  alias: string;
  timeoutMs: number;
  stallTimeoutMs: number;
}

// Build lookup map: model string -> { alias, timeoutMs, stallTimeoutMs }
const MODEL_LOOKUP = new Map<string, ModelLookupEntry>();

for (const def of MODEL_DEFINITIONS) {
  const entry: ModelLookupEntry = { alias: def.alias, timeoutMs: def.timeoutMs, stallTimeoutMs: def.stallTimeoutMs };
  MODEL_LOOKUP.set(def.id, entry);
  for (const prefix of PROVIDER_PREFIXES) {
    MODEL_LOOKUP.set(prefix + def.id, entry);
  }
}

// Bare aliases: "opus" -> opus, "sonnet" -> sonnet, "haiku" -> haiku
for (const family of ["opus", "sonnet", "haiku"] as const) {
  const def = MODEL_DEFINITIONS.find(d => d.family === family);
  if (def) {
    MODEL_LOOKUP.set(family, { alias: def.alias, timeoutMs: def.timeoutMs, stallTimeoutMs: def.stallTimeoutMs });
  }
}

/**
 * Resolve a model string to its CLI alias.
 * Returns null if the model is not recognized.
 */
export function resolveModel(model: string): string | null {
  const entry = MODEL_LOOKUP.get(model);
  if (entry) return entry.alias;

  for (const prefix of PROVIDER_PREFIXES) {
    if (model.startsWith(prefix)) {
      const stripped = model.slice(prefix.length);
      const e = MODEL_LOOKUP.get(stripped);
      if (e) return e.alias;
    }
  }

  return null;
}

/**
 * Get timeout for a model string.
 * Falls back to 180s for unknown models.
 */
export function getModelTimeout(model: string): number {
  const entry = MODEL_LOOKUP.get(model);
  if (entry) return entry.timeoutMs;

  const lower = (model || "").toLowerCase();
  if (lower.includes("opus"))   return 1800000;
  if (lower.includes("haiku"))  return 120000;
  if (lower.includes("sonnet")) return 600000;

  return 180000;
}

/**
 * Get stall (activity) timeout for a model string.
 * Falls back to 60s for unknown models.
 */
export function getStallTimeout(model: string): number {
  const entry = MODEL_LOOKUP.get(model);
  if (entry) return entry.stallTimeoutMs;

  const lower = (model || "").toLowerCase();
  if (lower.includes("opus"))   return 120000;
  if (lower.includes("haiku"))  return 30000;
  if (lower.includes("sonnet")) return 60000;

  return 60000;
}

/**
 * Check if a model string is recognized.
 */
export function isValidModel(model: string): boolean {
  return resolveModel(model) !== null;
}

// Canonical ID per family — the "current" model name to return in responses.
const CANONICAL_IDS: Partial<Record<ModelFamily, string>> = {};
for (const def of MODEL_DEFINITIONS) {
  if (!CANONICAL_IDS[def.family]) {
    CANONICAL_IDS[def.family] = def.id;
  }
}

/**
 * Normalize a CLI-reported model name to a canonical OpenAI-compatible ID.
 */
export function normalizeModelName(model: string): string {
  if (!model) return CANONICAL_IDS.sonnet!;
  const lower = model.toLowerCase();
  if (lower.includes("opus"))   return CANONICAL_IDS.opus!;
  if (lower.includes("sonnet")) return CANONICAL_IDS.sonnet!;
  if (lower.includes("haiku"))  return CANONICAL_IDS.haiku!;
  return model;
}

/**
 * Get the OpenAI-compatible /v1/models response data.
 */
export function getModelList(): Array<{ id: string; object: string; owned_by: string; created: number }> {
  return MODEL_DEFINITIONS.map(def => ({
    id: def.id,
    object: "model" as const,
    owned_by: "anthropic",
    created: Math.floor(Date.now() / 1000),
  }));
}
