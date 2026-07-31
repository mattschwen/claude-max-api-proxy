import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExternalModelCapabilities,
  ExternalModelDescriptor,
} from "./external-provider-types.js";
import {
  isCollisionProneExternalModelId,
  stripModelProviderPrefix,
} from "./models.js";

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
  apiKey?: string;
  model: string;
  models?: ExternalModelDescriptor[];
  streamMode: ExternalFallbackStreamMode;
  headers?: Record<string, string>;
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

const DEFAULT_EXTERNAL_MODEL_CAPABILITIES: ExternalModelCapabilities = {
  chatCompletions: true,
  streaming: true,
  reasoning: false,
  tools: false,
  vision: false,
  structuredOutputs: false,
};

function parsePositiveNumber(value: unknown, defaultValue: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function assertSafeExternalProviderBaseUrl(
  baseUrl: string,
  provider: string,
): void {
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error(`External provider '${provider}' has an invalid baseUrl`);
  }
  if (
    parsedBaseUrl.protocol !== "http:" &&
    parsedBaseUrl.protocol !== "https:"
  ) {
    throw new Error(
      `External provider '${provider}' baseUrl must use http or https`,
    );
  }
  if (parsedBaseUrl.username || parsedBaseUrl.password) {
    throw new Error(
      `External provider '${provider}' baseUrl must not contain credentials. Use apiKey, apiKeyEnv, or headers instead.`,
    );
  }
}

function parseExternalModelDescriptor(
  value: unknown,
  provider: string,
  defaultTimeoutMs: number,
): ExternalModelDescriptor | null {
  const raw = typeof value === "string"
    ? { id: value }
    : value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  const id = parseNonEmptyString(
    raw && typeof raw.id === "string" ? raw.id : undefined,
  );
  if (!raw || !id) return null;

  const capabilitiesRaw =
    raw.capabilities &&
      typeof raw.capabilities === "object" &&
      !Array.isArray(raw.capabilities)
      ? raw.capabilities as Record<string, unknown>
      : {};
  const readCapability = (
    key: keyof ExternalModelCapabilities,
    fallback: boolean,
  ): boolean => {
    const candidate = capabilitiesRaw[key];
    return typeof candidate === "boolean" ? candidate : fallback;
  };

  return {
    id,
    upstreamId: parseNonEmptyString(
      typeof raw.upstreamId === "string" ? raw.upstreamId : undefined,
    ),
    ownedBy: parseNonEmptyString(
      typeof raw.ownedBy === "string" ? raw.ownedBy : undefined,
    ) || provider,
    timeoutMs: parsePositiveNumber(raw.timeoutMs, defaultTimeoutMs),
    capabilities: {
      chatCompletions: readCapability("chatCompletions", true),
      streaming: readCapability("streaming", true),
      reasoning: readCapability("reasoning", false),
      tools: readCapability("tools", false),
      vision: readCapability("vision", false),
      structuredOutputs: readCapability("structuredOutputs", false),
      contextWindow: parsePositiveNumber(
        capabilitiesRaw.contextWindow,
        0,
      ) || undefined,
      maxOutputTokens: parsePositiveNumber(
        capabilitiesRaw.maxOutputTokens,
        0,
      ) || undefined,
    },
  };
}

function assertSafeExternalModelIds(
  configs: OpenAICompatFallbackConfig[],
): void {
  const seen = new Map<string, string>();
  for (const config of configs) {
    const models = config.models?.length
      ? config.models
      : [{
          id: config.model,
          ownedBy: config.provider,
          timeoutMs: 180000,
          capabilities: DEFAULT_EXTERNAL_MODEL_CAPABILITIES,
        }];
    for (const model of models) {
      if (isCollisionProneExternalModelId(model.id)) {
        throw new Error(
          `External model '${model.id}' from provider '${config.provider}' collides with a Claude alias or model ID. Use a provider-qualified ID such as '${config.provider}/${model.id}'.`,
        );
      }
      const routingKey = stripModelProviderPrefix(model.id).trim().toLowerCase();
      const existing = seen.get(routingKey);
      if (existing) {
        throw new Error(
          `External model '${model.id}' is configured by both '${existing}' and '${config.provider}'. Model routing IDs must be unique.`,
        );
      }
      seen.set(routingKey, config.provider);
    }
  }
}

/**
 * Parse multiple named OpenAI-compatible providers. The JSON form intentionally
 * replaces (rather than merges with) legacy single-provider env vars so a
 * leftover GEMINI_API_KEY cannot create an accidental duplicate route.
 */
export function parseExternalProviderConfigs(
  env: NodeJS.ProcessEnv = process.env,
): OpenAICompatFallbackConfig[] {
  const rawJson =
    parseNonEmptyString(env.OPENAI_COMPAT_PROVIDERS_JSON) ||
    parseNonEmptyString(env.OPENAI_COMPAT_PROVIDERS);
  if (!rawJson) {
    const legacy = parseExternalFallbackConfig(env);
    const configs = legacy ? [legacy] : [];
    assertSafeExternalModelIds(configs);
    return configs;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(
      `OPENAI_COMPAT_PROVIDERS_JSON must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const configs = entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`External provider entry ${index + 1} must be an object`);
    }
    const raw = entry as Record<string, unknown>;
    const provider =
      parseNonEmptyString(
        typeof raw.provider === "string" ? raw.provider : undefined,
      ) || `provider-${index + 1}`;
    const baseUrl = parseNonEmptyString(
      typeof raw.baseUrl === "string" ? raw.baseUrl : undefined,
    );
    if (!baseUrl) {
      throw new Error(`External provider '${provider}' requires baseUrl`);
    }
    assertSafeExternalProviderBaseUrl(baseUrl, provider);

    const timeoutMs = parsePositiveNumber(raw.timeoutMs, 180000);
    const rawModels = Array.isArray(raw.models)
      ? raw.models
      : typeof raw.model === "string"
        ? [raw.model]
        : [];
    const models = rawModels
      .map((model) =>
        parseExternalModelDescriptor(model, provider, timeoutMs)
      )
      .filter((model): model is ExternalModelDescriptor => model !== null);
    if (models.length === 0) {
      throw new Error(
        `External provider '${provider}' requires at least one model`,
      );
    }

    const apiKeyEnv = parseNonEmptyString(
      typeof raw.apiKeyEnv === "string" ? raw.apiKeyEnv : undefined,
    );
    const apiKeyFromEnv = apiKeyEnv
      ? parseNonEmptyString(env[apiKeyEnv])
      : undefined;
    if (apiKeyEnv && !apiKeyFromEnv) {
      throw new Error(
        `External provider '${provider}' references unset apiKeyEnv '${apiKeyEnv}'`,
      );
    }
    const apiKey =
      parseNonEmptyString(
        typeof raw.apiKey === "string" ? raw.apiKey : undefined,
      ) ||
      apiKeyFromEnv;
    const headers =
      raw.headers &&
        typeof raw.headers === "object" &&
        !Array.isArray(raw.headers)
        ? Object.fromEntries(
            Object.entries(raw.headers as Record<string, unknown>)
              .filter((entry): entry is [string, string] =>
                typeof entry[1] === "string"
              ),
          )
        : undefined;

    return {
      provider,
      baseUrl,
      apiKey,
      model: models[0].id,
      models,
      streamMode: parseExternalFallbackStreamMode(
        typeof raw.streamMode === "string" ? raw.streamMode : undefined,
        "synthetic",
      ),
      headers,
    } satisfies OpenAICompatFallbackConfig;
  });

  assertSafeExternalModelIds(configs);
  return configs;
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
  assertSafeExternalProviderBaseUrl(
    baseUrl,
    provider || "openai-compatible-fallback",
  );

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
  requireClaude: boolean;
  sameConversationPolicy: SameConversationPolicy;
  debugQueues: boolean;
  enableAdminApi: boolean;
  defaultThinkingBudget: string | undefined;
  defaultAgent: string | undefined;
  systemPromptFile: string | undefined;
  maxConcurrentRequests: number;
  modelFallbacks: string[];
  geminiCliFallback: GeminiCliFallbackConfig | null;
  externalFallback: OpenAICompatFallbackConfig | null;
  externalProviders: OpenAICompatFallbackConfig[];
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
  const geminiCliFallback = parseGeminiCliFallbackConfig(env);
  const externalProviders = parseExternalProviderConfigs(env);
  const hasExternalProviderJson = Boolean(
    parseNonEmptyString(env.OPENAI_COMPAT_PROVIDERS_JSON) ||
      parseNonEmptyString(env.OPENAI_COMPAT_PROVIDERS),
  );
  const externalFallback = hasExternalProviderJson
    ? null
    : externalProviders[0] ?? null;
  const hasExternalProvider =
    geminiCliFallback !== null || externalProviders.length > 0;
  return {
    requireClaude: parseBoolean(
      env.CLAUDE_PROXY_REQUIRE_CLAUDE,
      !hasExternalProvider,
    ),
    sameConversationPolicy: parseSameConversationPolicy(
      env.CLAUDE_PROXY_SAME_CONVERSATION_POLICY,
    ),
    debugQueues: parseBoolean(env.CLAUDE_PROXY_DEBUG_QUEUES, false),
    enableAdminApi: parseBoolean(env.CLAUDE_PROXY_ENABLE_ADMIN_API, false),
    defaultThinkingBudget: persistedDefault ?? envDefault,
    defaultAgent: env.CLAUDE_PROXY_DEFAULT_AGENT?.trim() || undefined,
    systemPromptFile: env.CLAUDE_PROXY_SYSTEM_PROMPT_FILE?.trim() || undefined,
    maxConcurrentRequests: parsePositiveInt(
      env.CLAUDE_PROXY_MAX_CONCURRENT_REQUESTS,
      defaultMaxConcurrentRequests(),
    ),
    modelFallbacks: parseCsvList(env.CLAUDE_PROXY_MODEL_FALLBACKS),
    geminiCliFallback,
    externalFallback,
    externalProviders,
  };
}

export const runtimeConfig = readRuntimeConfig();
