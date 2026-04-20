import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SameConversationPolicy = "latest-wins" | "queue";

export const GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
export const DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-2.5-flash";
export const DEFAULT_GEMINI_CLI_MODEL = "gemini-2.5-pro";
export const ZAI_OPENAI_BASE_URL = "https://api.z.ai/api/paas/v4";
export const ZAI_CODING_OPENAI_BASE_URL =
  "https://api.z.ai/api/coding/paas/v4";
export const DEFAULT_ZAI_FALLBACK_MODEL = "glm-4.7-flash";
export type ExternalFallbackStreamMode = "synthetic" | "passthrough";

export interface OpenAICompatFallbackConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  streamMode: ExternalFallbackStreamMode;
}

export interface GeminiCliFallbackConfig {
  provider: "gemini-cli";
  command: string;
  model: string;
  extraModels: string[];
  workdir: string;
  streamMode: ExternalFallbackStreamMode;
}

function parseNonEmptyString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isGeminiBaseUrl(baseUrl: string | undefined): boolean {
  return typeof baseUrl === "string" &&
    /generativelanguage\.googleapis\.com/i.test(baseUrl);
}

function isZaiBaseUrl(baseUrl: string | undefined): boolean {
  return typeof baseUrl === "string" &&
    /api\.z\.ai\/api\/(?:coding\/)?paas\/v4/i.test(baseUrl);
}

function normalizeProvider(value: string | undefined): string | undefined {
  const normalized = parseNonEmptyString(value)?.toLowerCase();
  return normalized || undefined;
}

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value == null || value.trim() === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parsePositiveInt(
  value: string | undefined,
  defaultValue: number,
): number {
  if (value == null || value.trim() === "") return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseCsvList(value: string | undefined): string[] {
  if (value == null || value.trim() === "") return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of value.split(",")) {
    const normalized = raw.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    items.push(normalized);
  }
  return items;
}

function parseExternalFallbackStreamMode(
  value: string | undefined,
  defaultValue: ExternalFallbackStreamMode = "synthetic",
): ExternalFallbackStreamMode {
  const normalized = parseNonEmptyString(value)?.toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (
    normalized === "passthrough" ||
    normalized === "upstream" ||
    normalized === "native"
  ) {
    return "passthrough";
  }

  if (
    normalized === "synthetic" ||
    normalized === "buffered" ||
    normalized === "proxy"
  ) {
    return "synthetic";
  }

  return defaultValue;
}

export function parseExternalFallbackConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenAICompatFallbackConfig | null {
  const explicitProvider = normalizeProvider(env.OPENAI_COMPAT_FALLBACK_PROVIDER);
  const explicitBaseUrl = parseNonEmptyString(
    env.OPENAI_COMPAT_FALLBACK_BASE_URL,
  );
  const explicitApiKey = parseNonEmptyString(
    env.OPENAI_COMPAT_FALLBACK_API_KEY,
  );
  const explicitModel = parseNonEmptyString(env.OPENAI_COMPAT_FALLBACK_MODEL);
  const explicitStreamMode = parseNonEmptyString(
    env.OPENAI_COMPAT_FALLBACK_STREAM_MODE,
  );
  const zaiApiKey =
    parseNonEmptyString(env.ZAI_API_KEY) ||
    parseNonEmptyString(env.BIGMODEL_API_KEY);
  const zaiModel = parseNonEmptyString(env.ZAI_MODEL);
  const zaiBaseUrl = parseNonEmptyString(env.ZAI_BASE_URL);
  const zaiCodingPlan = parseBoolean(env.ZAI_CODING_PLAN, false);
  const geminiApiKey =
    parseNonEmptyString(env.GEMINI_API_KEY) ||
    parseNonEmptyString(env.GOOGLE_API_KEY);
  let provider = explicitProvider;
  let apiKey = explicitApiKey;
  let baseUrl = explicitBaseUrl;
  let model = explicitModel;

  if (!provider) {
    if (explicitBaseUrl) {
      if (isZaiBaseUrl(explicitBaseUrl)) {
        provider = "zai";
      } else if (isGeminiBaseUrl(explicitBaseUrl)) {
        provider = "google";
      }
    } else if (zaiApiKey || zaiBaseUrl || zaiModel || zaiCodingPlan) {
      provider = "zai";
    } else if (geminiApiKey) {
      provider = "google";
    }
  }

  if (provider === "zai") {
    apiKey ||= zaiApiKey;
    baseUrl ||= zaiBaseUrl ||
      (zaiCodingPlan ? ZAI_CODING_OPENAI_BASE_URL : ZAI_OPENAI_BASE_URL);
    model ||= zaiModel || DEFAULT_ZAI_FALLBACK_MODEL;
  } else if (provider === "google") {
    apiKey ||= geminiApiKey;
    baseUrl ||= GEMINI_OPENAI_BASE_URL;
    model ||= DEFAULT_GEMINI_FALLBACK_MODEL;
  } else {
    apiKey ||= zaiApiKey || geminiApiKey;
    if (!baseUrl) {
      if (zaiApiKey || zaiBaseUrl || zaiModel || zaiCodingPlan) {
        baseUrl = zaiBaseUrl ||
          (zaiCodingPlan ? ZAI_CODING_OPENAI_BASE_URL : ZAI_OPENAI_BASE_URL);
        provider = "zai";
      } else if (geminiApiKey) {
        baseUrl = GEMINI_OPENAI_BASE_URL;
        provider = "google";
      }
    }
    if (!model) {
      if (provider === "zai" || isZaiBaseUrl(baseUrl)) {
        model = zaiModel || DEFAULT_ZAI_FALLBACK_MODEL;
        provider ||= "zai";
      } else if (provider === "google" || isGeminiBaseUrl(baseUrl)) {
        model = DEFAULT_GEMINI_FALLBACK_MODEL;
        provider ||= "google";
      }
    }
  }

  if (!provider && isZaiBaseUrl(baseUrl)) {
    provider = "zai";
  }
  if (!provider && isGeminiBaseUrl(baseUrl)) {
    provider = "google";
  }

  if (!baseUrl || !apiKey || !model) {
    return null;
  }

  return {
    provider: provider || "openai-compatible-fallback",
    baseUrl,
    apiKey,
    model,
    streamMode: parseExternalFallbackStreamMode(
      explicitStreamMode,
      "synthetic",
    ),
  };
}

export function parseGeminiCliFallbackConfig(
  env: NodeJS.ProcessEnv = process.env,
): GeminiCliFallbackConfig | null {
  const configuredModel = parseNonEmptyString(env.GEMINI_CLI_MODEL);
  const extraModels = parseCsvList(env.GEMINI_CLI_EXTRA_MODELS);
  const enabled = parseBoolean(
    env.GEMINI_CLI_ENABLED,
    Boolean(configuredModel || extraModels.length > 0),
  );

  if (!enabled) {
    return null;
  }

  const model = configuredModel || DEFAULT_GEMINI_CLI_MODEL;
  const dedupedExtraModels = extraModels.filter((entry) => entry !== model);
  const workdir = parseNonEmptyString(env.GEMINI_CLI_WORKDIR) ||
    path.join(os.tmpdir(), "claude-max-api-proxy-gemini-cli");

  return {
    provider: "gemini-cli",
    command: parseNonEmptyString(env.GEMINI_CLI_COMMAND) || "gemini",
    model,
    extraModels: dedupedExtraModels,
    workdir,
    streamMode: parseExternalFallbackStreamMode(
      env.GEMINI_CLI_STREAM_MODE,
      "passthrough",
    ),
  };
}

export function parseSameConversationPolicy(
  value: string | undefined,
): SameConversationPolicy {
  const normalized = value?.trim().toLowerCase();
  return normalized === "queue" ? "queue" : "latest-wins";
}

function defaultMaxConcurrentRequests(): number {
  const parallelism = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(2, Math.min(8, Math.ceil(parallelism * 0.75)));
}

export interface ProxyRuntimeConfig {
  sameConversationPolicy: SameConversationPolicy;
  debugQueues: boolean;
  enableAdminApi: boolean;
  defaultThinkingBudget: string | undefined;
  defaultAgent: string | undefined;
  maxConcurrentRequests: number;
  modelFallbacks: string[];
  geminiCliFallback: GeminiCliFallbackConfig | null;
  externalFallback: OpenAICompatFallbackConfig | null;
}

// Where runtime-mutable state (the admin-endpoint thinking budget override)
// is persisted so it survives restarts. Defaults next to the SQLite DB;
// override with RUNTIME_STATE_FILE.
const DEFAULT_STATE_FILE = path.join(
  process.env.DB_PATH
    ? path.dirname(process.env.DB_PATH)
    : process.env.HOME || "/tmp",
  "runtime-state.json",
);

export const RUNTIME_STATE_FILE =
  process.env.RUNTIME_STATE_FILE || DEFAULT_STATE_FILE;

function readPersistedThinkingBudget(): string | undefined {
  try {
    const raw = fs.readFileSync(RUNTIME_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { defaultThinkingBudget?: string };
    const value = parsed.defaultThinkingBudget?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function persistRuntimeState(): void {
  try {
    const state = {
      defaultThinkingBudget: runtimeConfig.defaultThinkingBudget ?? null,
    };
    fs.mkdirSync(path.dirname(RUNTIME_STATE_FILE), { recursive: true });
    fs.writeFileSync(RUNTIME_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[config] failed to persist runtime state:", err);
  }
}

export function readRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  persistedDefault = readPersistedThinkingBudget(),
): ProxyRuntimeConfig {
  // Persisted admin overrides win over the env var default so changes made
  // via /admin/thinking-budget survive restarts.
  const envDefault = env.DEFAULT_THINKING_BUDGET?.trim() || undefined;
  return {
    sameConversationPolicy: parseSameConversationPolicy(
      env.CLAUDE_PROXY_SAME_CONVERSATION_POLICY,
    ),
    debugQueues: parseBoolean(env.CLAUDE_PROXY_DEBUG_QUEUES, false),
    enableAdminApi: parseBoolean(env.CLAUDE_PROXY_ENABLE_ADMIN_API, false),
    defaultThinkingBudget: persistedDefault ?? envDefault,
    defaultAgent: env.CLAUDE_PROXY_DEFAULT_AGENT?.trim() || undefined,
    maxConcurrentRequests: parsePositiveInt(
      env.CLAUDE_PROXY_MAX_CONCURRENT_REQUESTS,
      defaultMaxConcurrentRequests(),
    ),
    modelFallbacks: parseCsvList(env.CLAUDE_PROXY_MODEL_FALLBACKS),
    geminiCliFallback: parseGeminiCliFallbackConfig(env),
    externalFallback: parseExternalFallbackConfig(env),
  };
}

export const runtimeConfig = readRuntimeConfig();
