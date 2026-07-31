import type { ClaudeProxyError } from "./claude-cli.inspect.js";
import {
  type ExternalFallbackStreamMode,
  type OpenAICompatFallbackConfig,
  runtimeConfig,
} from "./config.js";
import type {
  ExternalChatProvider,
  ExternalModelDescriptor,
  ExternalProviderAvailability,
  ExternalProviderProbeOptions,
  PublicExternalProviderInfo,
} from "./external-provider-types.js";
import { stripModelProviderPrefix } from "./models.js";
import type { OpenAIModel } from "./types/openai.js";

interface FallbackProviderDeps {
  fetch: typeof fetch;
  now: () => number;
}

function normalizeRequestedModel(model: string): string {
  return stripModelProviderPrefix(model).trim().toLowerCase();
}

function normalizeChatContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .join("");
}

function buildChatCompletionsUrl(baseUrl: string): string {
  return new URL(
    "chat/completions",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  ).toString();
}

function buildModelsUrl(baseUrl: string): string {
  return new URL(
    "models",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  ).toString();
}

export function sanitizePublicProviderBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid provider URL]";
  }
}

function defaultModelDescriptor(
  id: string,
  provider: string,
): ExternalModelDescriptor {
  return {
    id,
    ownedBy: provider,
    timeoutMs: 180000,
    capabilities: {
      chatCompletions: true,
      streaming: true,
      reasoning: false,
      tools: false,
      vision: false,
      structuredOutputs: false,
    },
  };
}

function inferErrorType(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

function isCallerRequestFailure(status: number): boolean {
  return status === 400 ||
    status === 409 ||
    status === 413 ||
    status === 415 ||
    status === 422;
}

export function sanitizeFallbackChatRequestBody(
  body: Record<string, unknown>,
  model: string,
  overrides: {
    stream?: boolean;
  } = {},
): Record<string, unknown> {
  const forwarded: Record<string, unknown> = {
    ...body,
    model,
  };

  delete forwarded.agent;
  delete forwarded.conversation_id;
  delete forwarded.conversation_policy;
  delete forwarded.thinking;
  delete forwarded.reasoning;
  delete forwarded.reasoning_effort;
  delete forwarded.output_config;

  if (typeof overrides.stream === "boolean") {
    forwarded.stream = overrides.stream;
  }

  return forwarded;
}

export function extractAssistantContentFromChatPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const choices = "choices" in payload && Array.isArray(payload.choices)
    ? payload.choices
    : [];
  const firstChoice = choices[0];

  if (!firstChoice || typeof firstChoice !== "object") {
    return "";
  }

  if (
    "message" in firstChoice &&
    firstChoice.message &&
    typeof firstChoice.message === "object" &&
    "content" in firstChoice.message
  ) {
    return normalizeChatContent(firstChoice.message.content);
  }

  if ("text" in firstChoice) {
    return normalizeChatContent(firstChoice.text);
  }

  return "";
}

export function extractAssistantContentFromChatChunk(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const choices = "choices" in payload && Array.isArray(payload.choices)
    ? payload.choices
    : [];
  const firstChoice = choices[0];

  if (!firstChoice || typeof firstChoice !== "object") {
    return "";
  }

  if (
    "delta" in firstChoice &&
    firstChoice.delta &&
    typeof firstChoice.delta === "object" &&
    "content" in firstChoice.delta
  ) {
    return normalizeChatContent(firstChoice.delta.content);
  }

  return "";
}

export async function parseFallbackProviderError(
  response: Response,
  provider = "openai-compatible-fallback",
): Promise<ClaudeProxyError> {
  const raw = await response.text();
  let message = `${provider} returned ${response.status} ${response.statusText}`.trim();
  let type = inferErrorType(response.status);
  let code: string | null = "external_provider_error";

  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as {
        error?: { message?: unknown; type?: unknown; code?: unknown };
      };
      if (typeof parsed.error?.message === "string" && parsed.error.message) {
        message = parsed.error.message;
      } else {
        message = raw.trim();
      }
      if (typeof parsed.error?.type === "string" && parsed.error.type) {
        type = parsed.error.type;
      }
      if (
        typeof parsed.error?.code === "string" ||
        parsed.error?.code === null
      ) {
        code = parsed.error.code;
      }
    } catch {
      message = raw.trim();
    }
  }

  return {
    status: response.status || 502,
    type,
    code,
    message,
  };
}

export class OpenAICompatFallbackProvider implements ExternalChatProvider {
  private availability: ExternalProviderAvailability;

  constructor(
    private readonly config: OpenAICompatFallbackConfig | null =
      runtimeConfig.externalFallback,
    private readonly deps: FallbackProviderDeps = {
      fetch: globalThis.fetch.bind(globalThis),
      now: Date.now,
    },
  ) {
    this.availability = this.config
      ? {
          configured: true,
          state: "unknown",
          availableModels: [],
          unavailableModels: [],
        }
      : {
          configured: false,
          state: "unconfigured",
          availableModels: [],
          unavailableModels: [],
        };
  }

  private getConfiguredModels(): ExternalModelDescriptor[] {
    if (!this.config) return [];
    return this.config.models?.length
      ? this.config.models.map((model) => ({
          ...model,
          capabilities: { ...model.capabilities },
        }))
      : [defaultModelDescriptor(this.config.model, this.config.provider)];
  }

  private getSupportedModelMap(): Map<string, ExternalModelDescriptor> {
    return new Map(
      this.getConfiguredModels().map((model) => [
        normalizeRequestedModel(model.id),
        model,
      ]),
    );
  }

  private updateAvailability(
    patch: Omit<ExternalProviderAvailability, "configured">,
  ): ExternalProviderAvailability {
    this.availability = {
      configured: this.config !== null,
      ...patch,
    };
    return this.getAvailability();
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.config?.headers ?? {}),
    };
    if (
      this.config?.apiKey &&
      !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")
    ) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  getDefaultModel(): string | null {
    return this.config?.model ?? null;
  }

  resolveModel(model?: string): string | null {
    if (!this.config) {
      return null;
    }

    if (!model) {
      return this.config.model;
    }

    return this.getSupportedModelMap().get(normalizeRequestedModel(model))?.id ??
      null;
  }

  getPublicInfo(): PublicExternalProviderInfo | null {
    if (!this.config) {
      return null;
    }

    return {
      provider: this.config.provider,
      transport: "openai-compatible",
      baseUrl: sanitizePublicProviderBaseUrl(this.config.baseUrl),
      model: this.config.model,
      extraModels: this.getConfiguredModels()
        .map((model) => model.id)
        .filter((model) => model !== this.config?.model),
      streamMode: this.config.streamMode,
    };
  }

  usesSyntheticStreaming(): boolean {
    return this.config?.streamMode !== "passthrough";
  }

  supportsModel(model: string | undefined): boolean {
    if (!this.config || !model) {
      return false;
    }

    return this.getSupportedModelMap().has(normalizeRequestedModel(model));
  }

  getPublicModelList(): OpenAIModel[] {
    if (!this.config) {
      return [];
    }

    return this.getConfiguredModels().map((model) => ({
        id: model.id,
        object: "model",
        owned_by: model.ownedBy,
        created: Math.floor(this.deps.now() / 1000),
      }));
  }

  getModelDescriptors(): ExternalModelDescriptor[] {
    return this.getConfiguredModels();
  }

  getModelDescriptor(model: string | undefined): ExternalModelDescriptor | null {
    if (!model) return null;
    return this.getSupportedModelMap().get(normalizeRequestedModel(model)) ?? null;
  }

  getAvailability(): ExternalProviderAvailability {
    return {
      ...this.availability,
      availableModels: [...this.availability.availableModels],
      unavailableModels: [...this.availability.unavailableModels],
    };
  }

  async probeAvailability(
    options: ExternalProviderProbeOptions = {},
  ): Promise<ExternalProviderAvailability> {
    if (!this.config) return this.getAvailability();
    const configuredModels = this.getConfiguredModels().map((model) => model.id);
    try {
      const response = await this.deps.fetch(buildModelsUrl(this.config.baseUrl), {
        method: "GET",
        headers: this.buildHeaders(),
        signal: options.signal,
      });
      if (!response.ok) {
        const error = await parseFallbackProviderError(
          response,
          this.config.provider,
        );
        return this.updateAvailability({
          state: "unavailable",
          checkedAt: this.deps.now(),
          availableModels: [],
          unavailableModels: configuredModels,
          error: error.message,
        });
      }

      const payload = await response.json().catch(() => null) as {
        data?: Array<{ id?: unknown }>;
      } | null;
      const upstreamIds = new Set(
        Array.isArray(payload?.data)
          ? payload!.data
              .map((entry) =>
                typeof entry?.id === "string"
                  ? normalizeRequestedModel(entry.id)
                  : ""
              )
              .filter(Boolean)
          : [],
      );
      const hasCatalog = Array.isArray(payload?.data);
      const availableModels = hasCatalog
        ? this.getConfiguredModels()
            .filter((model) =>
              upstreamIds.has(
                normalizeRequestedModel(model.upstreamId ?? model.id),
              )
            )
            .map((model) => model.id)
        : configuredModels;
      const unavailableModels = configuredModels.filter(
        (model) => !availableModels.includes(model),
      );
      return this.updateAvailability({
        state: availableModels.length > 0 ? "available" : "unavailable",
        checkedAt: this.deps.now(),
        availableModels,
        unavailableModels,
        error: availableModels.length > 0
          ? undefined
          : "Provider model catalog did not include any configured model",
      });
    } catch (error) {
      return this.updateAvailability({
        state: "unavailable",
        checkedAt: this.deps.now(),
        availableModels: [],
        unavailableModels: configuredModels,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async requestChatCompletion(
    body: Record<string, unknown>,
    model: string,
    options: {
      signal?: AbortSignal;
      stream?: boolean;
    } = {},
  ): Promise<Response> {
    if (!this.config) {
      throw new Error("No external fallback provider is configured");
    }

    try {
      const descriptor = this.getModelDescriptor(model);
      const upstreamModel = descriptor?.upstreamId ?? model;
      const response = await this.deps.fetch(
        buildChatCompletionsUrl(this.config.baseUrl),
        {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify(
            sanitizeFallbackChatRequestBody(body, upstreamModel, {
              stream: options.stream,
            }),
          ),
          signal: options.signal,
        },
      );
      if (response.ok) {
        const previous = this.getAvailability();
        this.updateAvailability({
          state: "available",
          checkedAt: this.deps.now(),
          availableModels: [...new Set([
            ...previous.availableModels,
            model,
          ])],
          unavailableModels: previous.unavailableModels.filter(
            (candidate) => candidate !== model,
          ),
        });
      } else if (!isCallerRequestFailure(response.status)) {
        const previous = this.getAvailability();
        const availableModels = previous.availableModels.filter(
          (candidate) => candidate !== model,
        );
        this.updateAvailability({
          state: availableModels.length > 0 ? "available" : "unavailable",
          checkedAt: this.deps.now(),
          availableModels,
          unavailableModels: [...new Set([
            ...previous.unavailableModels,
            model,
          ])],
          error: `${this.config.provider} returned HTTP ${response.status}`,
        });
      }
      return response;
    } catch (error) {
      const previous = this.getAvailability();
      const availableModels = previous.availableModels.filter(
        (candidate) => candidate !== model,
      );
      this.updateAvailability({
        state: availableModels.length > 0 ? "available" : "unavailable",
        checkedAt: this.deps.now(),
        availableModels,
        unavailableModels: [...new Set([
          ...previous.unavailableModels,
          model,
        ])],
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export const externalFallbackProvider = new OpenAICompatFallbackProvider();
