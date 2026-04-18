/**
 * Central model registry.
 *
 * The Claude CLI owns the exact versioned model IDs (for example
 * `claude-sonnet-<resolved-by-cli>`). This module only owns stable family metadata:
 * aliases, timeout policy, and provider-prefix normalization. Runtime model
 * probing resolves the current exact IDs dynamically.
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

export interface ParsedClaudeModelVersion {
  family: ModelFamily;
  major: number;
  minor: number;
}

const MODEL_DEFINITIONS: ModelDefinition[] = [
  {
    id: "sonnet",
    family: "sonnet",
    alias: "sonnet",
    timeoutMs: 600000,
    stallTimeoutMs: 90000,
  },
  {
    id: "opus",
    family: "opus",
    alias: "opus",
    timeoutMs: 1800000,
    stallTimeoutMs: 120000,
  },
  {
    id: "haiku",
    family: "haiku",
    alias: "haiku",
    timeoutMs: 120000,
    stallTimeoutMs: 45000,
  },
];

// Provider prefixes that clients may prepend
export const PROVIDER_PREFIXES = [
  "maxproxy/",
  "claude-code-cli/",
  "claude-max-api-proxy/",
];

const FAMILY_PATTERNS: Record<ModelFamily, RegExp> = {
  opus: /(?:^|[/:._-])opus(?:$|[/:._-])/i,
  sonnet: /(?:^|[/:._-])sonnet(?:$|[/:._-])/i,
  haiku: /(?:^|[/:._-])haiku(?:$|[/:._-])/i,
};

function getModelConfig(family: ModelFamily): ModelDefinition {
  const definition = MODEL_DEFINITIONS.find((entry) => entry.family === family);
  if (!definition) {
    throw new Error(`Unknown model family: ${family}`);
  }
  return definition;
}

function getModelConfigForName(model: string): ModelDefinition | null {
  const family = resolveModelFamily(model);
  return family ? getModelConfig(family) : null;
}

export function stripModelProviderPrefix(model: string): string {
  let stripped = (model || "").trim();
  let changed = true;

  while (changed && stripped) {
    changed = false;
    for (const prefix of PROVIDER_PREFIXES) {
      if (stripped.startsWith(prefix)) {
        stripped = stripped.slice(prefix.length).trim();
        changed = true;
      }
    }
  }

  return stripped;
}

/**
 * Resolve a model string to its CLI alias.
 * Returns null if the model is not recognized.
 */
export function resolveModel(model: string): string | null {
  const definition = getModelConfigForName(model);
  return definition?.alias ?? null;
}

/**
 * Resolve a request model string to its model family.
 */
export function resolveModelFamily(model: string): ModelFamily | null {
  const normalized = stripModelProviderPrefix(model).toLowerCase();
  if (!normalized) return null;

  const exact = MODEL_DEFINITIONS.find((definition) => definition.alias === normalized);
  if (exact) {
    return exact.family;
  }

  for (const definition of MODEL_DEFINITIONS) {
    if (FAMILY_PATTERNS[definition.family].test(normalized)) {
      return definition.family;
    }
  }

  return null;
}

export function createModelDefinition(
  family: ModelFamily,
  modelId?: string,
): ModelDefinition {
  const definition = getModelConfig(family);
  return {
    ...definition,
    id: normalizeModelName(modelId ?? definition.alias, family),
  };
}

/**
 * Get timeout for a model string.
 * Falls back to 180s for unknown models.
 */
export function getModelTimeout(model: string): number {
  const definition = getModelConfigForName(model);
  return definition?.timeoutMs ?? 180000;
}

/**
 * Get stall (activity) timeout for a model string.
 * Falls back to 60s for unknown models.
 */
export function getStallTimeout(model: string): number {
  const definition = getModelConfigForName(model);
  return definition?.stallTimeoutMs ?? 90000;
}

/**
 * Check if a model string is recognized.
 */
export function isValidModel(model: string): boolean {
  return getModelConfigForName(model) !== null;
}

/**
 * Normalize a CLI-reported model name for OpenAI responses:
 * - strip proxy/provider prefixes
 * - preserve the exact resolved model ID when present
 * - fall back to the family alias when the caller provided no model name
 */
export function normalizeModelName(
  model: string,
  fallbackFamily: ModelFamily = "sonnet",
): string {
  const normalized = stripModelProviderPrefix(model);
  return normalized || getCanonicalModelId(fallbackFamily);
}

export function parseClaudeModelVersion(
  model: string,
): ParsedClaudeModelVersion | null {
  const normalized = stripModelProviderPrefix(model).toLowerCase();
  const match = normalized.match(/(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (!match) return null;
  return {
    family: match[1] as ModelFamily,
    major: Number(match[2]),
    minor: Number(match[3]),
  };
}

export function supportsAdaptiveReasoningModel(model: string): boolean {
  const parsed = parseClaudeModelVersion(model);
  if (!parsed) return false;
  if (parsed.family !== "opus" && parsed.family !== "sonnet") {
    return false;
  }
  if (parsed.major > 4) return true;
  return parsed.major === 4 && parsed.minor >= 6;
}

/**
 * Get the OpenAI-compatible /v1/models response data.
 */
export function getModelList(
  definitions: ModelDefinition[] = MODEL_DEFINITIONS,
): Array<{ id: string; object: string; owned_by: string; created: number }> {
  return definitions.map((def) => ({
    id: def.id,
    object: "model" as const,
    owned_by: "anthropic",
    created: Math.floor(Date.now() / 1000),
  }));
}

export function getModelDefinitions(): ModelDefinition[] {
  return MODEL_DEFINITIONS.map((definition) => ({ ...definition }));
}

export function getCanonicalModelId(family: ModelFamily): string {
  return getModelConfig(family).alias;
}
