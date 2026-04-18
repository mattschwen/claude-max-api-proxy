import { supportsAdaptiveReasoningCli, supportsXHighEffort } from "./claude-cli.inspect.js";
import { supportsAdaptiveReasoningModel } from "./models.js";

export const REASONING_EFFORT_MAP = {
  off: 0,
  low: 5000,
  medium: 10000,
  high: 32000,
  xhigh: 48000,
  max: 64000,
} as const;

export type ReasoningEffort = Exclude<keyof typeof REASONING_EFFORT_MAP, "off">;
export type ReasoningMode = "off" | "fixed" | "adaptive";
type EffortOrOff = keyof typeof REASONING_EFFORT_MAP;

export interface ResolvedReasoningConfig {
  active: boolean;
  mode: ReasoningMode;
  effort?: ReasoningEffort;
  budgetTokens?: number;
  source?: string;
  adaptiveModel: boolean;
  cliSupportsAdaptive: boolean;
  requiresCliUpgrade: boolean;
}

interface RawReasoningInput {
  mode?: ReasoningMode;
  effort?: EffortOrOff;
  budgetTokens?: number;
  source: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

export function parseEffortLabel(raw: unknown): EffortOrOff | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized in REASONING_EFFORT_MAP) {
    return normalized as EffortOrOff;
  }
  return undefined;
}

export function parseEffortOrTokens(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower in REASONING_EFFORT_MAP) {
    return REASONING_EFFORT_MAP[lower as EffortOrOff];
  }
  const parsed = parseInt(trimmed, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return undefined;
}

export function thinkingBudgetToEffort(
  budget: number,
  xhighSupported = supportsXHighEffort(),
): ReasoningEffort | undefined {
  if (!Number.isFinite(budget) || budget <= 0) return undefined;
  if (budget > 48000) return "max";
  if (budget > 32000) return xhighSupported ? "xhigh" : "max";
  if (budget > 10000) return "high";
  if (budget > 5000) return "medium";
  return "low";
}

function parseReasoningObject(value: unknown): RawReasoningInput | null {
  if (!isRecord(value)) return null;
  const rawMode = value.mode;
  const mode =
    rawMode === "off" || rawMode === "fixed" || rawMode === "adaptive"
      ? rawMode
      : undefined;
  const effort = parseEffortLabel(value.effort);
  const budgetTokens =
    parsePositiveNumber(value.budget_tokens) ??
    parsePositiveNumber(value.max_budget_tokens);

  if (!mode && !effort && budgetTokens === undefined) {
    return null;
  }

  return {
    mode,
    effort,
    budgetTokens,
    source: "reasoning",
  };
}

function parseThinkingObject(value: unknown): RawReasoningInput | null {
  if (!isRecord(value)) return null;
  const rawType = typeof value.type === "string" ? value.type.toLowerCase() : "";
  const mode =
    rawType === "adaptive"
      ? "adaptive"
      : rawType === "enabled"
        ? "fixed"
        : rawType === "off"
          ? "off"
          : undefined;
  const effort =
    parseEffortLabel(value.effort) ||
    parseEffortLabel(isRecord(value.output_config) ? value.output_config.effort : undefined);
  const budgetTokens = parsePositiveNumber(value.budget_tokens);

  if (!mode && !effort && budgetTokens === undefined) {
    return null;
  }

  return {
    mode,
    effort,
    budgetTokens,
    source: "thinking",
  };
}

function parseOutputConfig(value: unknown): RawReasoningInput | null {
  if (!isRecord(value)) return null;
  const effort = parseEffortLabel(value.effort);
  if (!effort) return null;
  return {
    effort,
    source: "output_config",
  };
}

function parseBudgetSource(raw: unknown, source: string): RawReasoningInput | null {
  if (typeof raw !== "string") return null;
  const parsed = parseEffortOrTokens(raw);
  if (parsed === undefined) return null;
  if (parsed === 0) {
    return { mode: "off", source };
  }
  const effort = parseEffortLabel(raw);
  return {
    budgetTokens: parsed,
    effort: effort && effort !== "off" ? effort : undefined,
    source,
  };
}

function selectRawReasoningInput(
  body: Record<string, unknown>,
  headerBudget?: string,
  runtimeDefault?: string,
): RawReasoningInput | null {
  return (
    parseReasoningObject(body.reasoning) ||
    parseThinkingObject(body.thinking) ||
    parseOutputConfig(body.output_config) ||
    parseBudgetSource(body.reasoning_effort, "reasoning_effort") ||
    parseBudgetSource(headerBudget, "x-thinking-budget") ||
    parseBudgetSource(runtimeDefault, "default")
  );
}

export function resolveReasoningConfig(options: {
  body: Record<string, unknown>;
  headerBudget?: string;
  runtimeDefault?: string;
  resolvedModel: string;
  cliVersion?: string;
}): ResolvedReasoningConfig {
  const adaptiveModel = supportsAdaptiveReasoningModel(options.resolvedModel);
  const cliSupportsAdaptive = supportsAdaptiveReasoningCli(options.cliVersion);
  const raw = selectRawReasoningInput(
    options.body,
    options.headerBudget,
    options.runtimeDefault,
  );

  if (!raw || raw.mode === "off" || raw.effort === "off") {
    return {
      active: false,
      mode: "off",
      adaptiveModel,
      cliSupportsAdaptive,
      requiresCliUpgrade: false,
      source: raw?.source,
    };
  }

  if (adaptiveModel) {
    const effort = raw.effort || thinkingBudgetToEffort(raw.budgetTokens || 0);
    return {
      active: true,
      mode: "adaptive",
      effort,
      source: raw.source,
      adaptiveModel,
      cliSupportsAdaptive,
      requiresCliUpgrade: !cliSupportsAdaptive,
    };
  }

  const budgetTokens =
    raw.budgetTokens ??
    (raw.effort ? REASONING_EFFORT_MAP[raw.effort] : undefined);

  return {
    active: typeof budgetTokens === "number" && budgetTokens > 0,
    mode: "fixed",
    effort: raw.effort,
    budgetTokens,
    source: raw.source,
    adaptiveModel,
    cliSupportsAdaptive,
    requiresCliUpgrade: false,
  };
}
