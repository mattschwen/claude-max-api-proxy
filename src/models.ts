/**
 * Central model registry.
 *
 * The Claude CLI owns the exact versioned model IDs (for example
 * `claude-sonnet-<resolved-by-cli>`). This module only owns stable family metadata:
 * aliases, timeout policy, and provider-prefix normalization. Runtime model
 * probing resolves the current exact IDs dynamically.
 */

export type KnownModelFamily = "opus" | "sonnet" | "haiku" | "fable";
export type ModelFamily = KnownModelFamily | (string & {});
export type SpecialModelAlias = "default";

export interface ClaudeModelDescriptor {
  family: KnownModelFamily;
  aliases: readonly string[];
  patterns: readonly RegExp[];
  timeoutMs: number;
  stallTimeoutMs: number;
  defaultPriority: number;
  adaptiveReasoningMinVersion?: {
    major: number;
    minor: number;
  };
}

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

const CLAUDE_MODEL_DESCRIPTORS: readonly ClaudeModelDescriptor[] = [
  {
    family: "sonnet",
    aliases: ["sonnet"],
    patterns: [/(?:^|[/:._-])sonnet(?:$|[/:._-])/i],
    timeoutMs: 600000,
    stallTimeoutMs: 90000,
    defaultPriority: 0,
    adaptiveReasoningMinVersion: { major: 4, minor: 6 },
  },
  {
    family: "opus",
    aliases: ["opus", "best"],
    patterns: [/(?:^|[/:._-])opus(?:$|[/:._-])/i],
    timeoutMs: 1800000,
    stallTimeoutMs: 120000,
    defaultPriority: 1,
    adaptiveReasoningMinVersion: { major: 4, minor: 6 },
  },
  {
    // `fable` is a CLI-resolved alias for the latest Fable model
    // (e.g. `claude-fable-5`), mirroring how `opus`/`sonnet`/`haiku` work.
    // The Claude CLI owns the exact versioned ID; we only carry the alias
    // and a flagship-tier timeout policy here.
    family: "fable",
    aliases: ["fable"],
    patterns: [/(?:^|[/:._-])fable(?:$|[/:._-])/i],
    timeoutMs: 1800000,
    stallTimeoutMs: 120000,
    defaultPriority: 2,
    adaptiveReasoningMinVersion: { major: 5, minor: 0 },
  },
  {
    family: "haiku",
    aliases: ["haiku"],
    patterns: [/(?:^|[/:._-])haiku(?:$|[/:._-])/i],
    timeoutMs: 120000,
    stallTimeoutMs: 45000,
    defaultPriority: 3,
  },
];

const UNKNOWN_MODEL_TIMEOUT_MS = 180000;
const UNKNOWN_MODEL_STALL_TIMEOUT_MS = 90000;

const MODEL_DEFINITIONS: ModelDefinition[] = [
  {
    id: "default",
    family: "default",
    alias: "default",
    timeoutMs: UNKNOWN_MODEL_TIMEOUT_MS,
    stallTimeoutMs: UNKNOWN_MODEL_STALL_TIMEOUT_MS,
  },
  ...CLAUDE_MODEL_DESCRIPTORS.map((descriptor) => ({
    id: descriptor.aliases[0],
    family: descriptor.family,
    alias: descriptor.aliases[0],
    timeoutMs: descriptor.timeoutMs,
    stallTimeoutMs: descriptor.stallTimeoutMs,
  })),
];

// Provider prefixes that clients may prepend
export const PROVIDER_PREFIXES = [
  "maxproxy/",
  "claude-code-cli/",
  "claude-max-api-proxy/",
];

const SPECIAL_MODEL_ALIASES = new Set<SpecialModelAlias>(["default"]);
const EXTENDED_CONTEXT_SUFFIX = /\[1m\]$/i;

function stripClaudeModelVariantSuffix(model: string): string {
  return model.replace(EXTENDED_CONTEXT_SUFFIX, "");
}

export function isExtendedContextModel(model: string): boolean {
  return EXTENDED_CONTEXT_SUFFIX.test(
    stripModelProviderPrefix(model).trim(),
  );
}

function getModelConfig(family: ModelFamily): ModelDefinition {
  const definition = MODEL_DEFINITIONS.find((entry) => entry.family === family);
  return definition ?? {
    id: family,
    family,
    alias: family,
    timeoutMs: UNKNOWN_MODEL_TIMEOUT_MS,
    stallTimeoutMs: UNKNOWN_MODEL_STALL_TIMEOUT_MS,
  };
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

export function isSpecialModelAlias(model: string): boolean {
  const normalized = stripModelProviderPrefix(model).toLowerCase();
  return SPECIAL_MODEL_ALIASES.has(normalized as SpecialModelAlias);
}

/**
 * Resolve a model string to its CLI alias.
 * Returns null if the model is not recognized.
 */
export function resolveModel(model: string): string | null {
  const normalized = stripModelProviderPrefix(model).trim().toLowerCase();
  if (isExtendedContextModel(normalized)) {
    return normalized;
  }
  const definition = getModelConfigForName(model);
  return definition?.alias ?? null;
}

/**
 * Resolve a request model string to its model family.
 */
export function resolveModelFamily(model: string): ModelFamily | null {
  const normalized = stripClaudeModelVariantSuffix(
    stripModelProviderPrefix(model).toLowerCase(),
  );
  if (!normalized) return null;

  for (const descriptor of CLAUDE_MODEL_DESCRIPTORS) {
    if (descriptor.aliases.includes(normalized)) {
      return descriptor.family;
    }
    if (descriptor.patterns.some((pattern) => pattern.test(normalized))) {
      return descriptor.family;
    }
  }

  const futureClaudeMatch = normalized.match(
    /(?:^|[/:._-])claude-([a-z][a-z0-9-]*?)-\d+(?:-\d+)?(?:$|[/:._-])/i,
  );
  if (futureClaudeMatch) {
    return futureClaudeMatch[1];
  }

  const unversionedClaudeMatch = normalized.match(
    /(?:^|[/:._-])claude-([a-z][a-z0-9]*)(?:$|[/:._-])/i,
  );
  if (unversionedClaudeMatch) {
    return unversionedClaudeMatch[1];
  }

  return null;
}

export function createModelDefinition(
  family: ModelFamily,
  modelId?: string,
  alias?: string,
): ModelDefinition {
  const definition = getModelConfig(family);
  return {
    ...definition,
    id: normalizeModelName(modelId ?? definition.alias, family),
    alias: alias ?? definition.alias,
  };
}

/**
 * Convert a successful CLI probe into a routable definition. Unlike the
 * built-in family lookup, this deliberately preserves future Claude model IDs
 * that this version of the proxy has never seen before.
 */
export function createModelDefinitionFromProbe(
  alias: string,
  resolvedModel?: string,
): ModelDefinition | null {
  const normalizedAlias = stripModelProviderPrefix(alias).trim().toLowerCase();
  const normalizedModel = stripModelProviderPrefix(
    resolvedModel || normalizedAlias,
  ).trim();
  if (!normalizedAlias || !normalizedModel) return null;

  const family =
    resolveModelFamily(normalizedModel) ??
    resolveModelFamily(normalizedAlias) ??
    (normalizedModel.toLowerCase().startsWith("claude-")
      ? normalizedModel
          .slice("claude-".length)
          .split(/[-/:._]/)
          .filter(Boolean)[0] || "unknown"
      : "unknown");

  return createModelDefinition(family, normalizedModel, normalizedAlias);
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
  const normalized = stripModelProviderPrefix(model).toLowerCase();
  if (isExtendedContextModel(normalized)) {
    const family = resolveModelFamily(normalized);
    return family === "sonnet" || family === "opus";
  }
  return (
    isSpecialModelAlias(normalized) ||
    getModelConfigForName(normalized) !== null ||
    /^claude-[a-z0-9][a-z0-9._-]*$/i.test(normalized)
  );
}

export function isClaudeModelRequest(
  model: string | null | undefined,
): boolean {
  if (model == null) {
    return true;
  }

  const normalized = stripModelProviderPrefix(model).trim();
  if (!normalized) {
    return true;
  }

  return isSpecialModelAlias(normalized) || resolveModelFamily(normalized) !== null;
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
  const normalized = stripClaudeModelVariantSuffix(
    stripModelProviderPrefix(model).toLowerCase(),
  );
  const match = normalized.match(
    /(?:^|[/:._-])claude-([a-z][a-z0-9-]*?)-(\d+)(?:-(\d+))?(?:$|[/:._-])/i,
  ) ?? normalized.match(
    /(?:^|[/:._-])([a-z][a-z0-9-]*?)-(\d+)(?:-(\d+))?(?:$|[/:._-])/i,
  );
  if (!match) return null;
  return {
    family: resolveModelFamily(normalized) ?? match[1],
    major: Number(match[2]),
    minor: match[3] === undefined ? 0 : Number(match[3]),
  };
}

export function supportsAdaptiveReasoningModel(model: string): boolean {
  const parsed = parseClaudeModelVersion(model);
  if (!parsed) return false;
  const descriptor = CLAUDE_MODEL_DESCRIPTORS.find(
    (entry) => entry.family === parsed.family,
  );
  const minimum = descriptor?.adaptiveReasoningMinVersion;
  if (!minimum) return false;
  if (parsed.major !== minimum.major) return parsed.major > minimum.major;
  return parsed.minor >= minimum.minor;
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

export function getClaudeModelDescriptors(): ClaudeModelDescriptor[] {
  return CLAUDE_MODEL_DESCRIPTORS.map((descriptor) => ({
    ...descriptor,
    aliases: [...descriptor.aliases],
    patterns: [...descriptor.patterns],
    adaptiveReasoningMinVersion: descriptor.adaptiveReasoningMinVersion
      ? { ...descriptor.adaptiveReasoningMinVersion }
      : undefined,
  }));
}

export function getAcceptedClaudeModelSelectors(): string[] {
  return [
    "default",
    ...CLAUDE_MODEL_DESCRIPTORS.flatMap((descriptor) => descriptor.aliases),
    "sonnet[1m]",
    "opus[1m]",
  ];
}

export function getDefaultModelFamilyOrder(): ModelFamily[] {
  return [...CLAUDE_MODEL_DESCRIPTORS]
    .sort((left, right) => left.defaultPriority - right.defaultPriority)
    .map((descriptor) => descriptor.family);
}

/**
 * Bare Claude aliases/IDs must not be claimed by an external provider because
 * external routing currently runs before Claude resolution. Provider-qualified
 * IDs (for example `openrouter/anthropic/claude-sonnet-4`) remain safe.
 */
export function isCollisionProneExternalModelId(model: string): boolean {
  const raw = (model || "").trim();
  if (!raw) return true;
  const normalized = stripModelProviderPrefix(raw).toLowerCase();
  const hasExternalNamespace =
    normalized.includes("/") &&
    !PROVIDER_PREFIXES.some((prefix) => raw.toLowerCase().startsWith(prefix));
  if (hasExternalNamespace) return false;
  return isSpecialModelAlias(normalized) || isValidModel(normalized);
}
