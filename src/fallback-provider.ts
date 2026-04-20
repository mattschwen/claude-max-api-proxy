import type { ClaudeProxyError } from "./claude-cli.inspect.js";
import {
  type ExternalFallbackStreamMode,
  type OpenAICompatFallbackConfig,
  runtimeConfig,
} from "./config.js";
import type {
  ExternalChatProvider,
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

function inferErrorType(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
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
  constructor(
    private readonly config: OpenAICompatFallbackConfig | null =
      runtimeConfig.externalFallback,
    private readonly deps: FallbackProviderDeps = {
      fetch: globalThis.fetch.bind(globalThis),
      now: Date.now,
    },
  ) {}

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

    return this.supportsModel(model) ? this.config.model : null;
  }

  getPublicInfo(): PublicExternalProviderInfo | null {
    if (!this.config) {
      return null;
    }

    return {
      provider: this.config.provider,
      transport: "openai-compatible",
      baseUrl: this.config.baseUrl,
      model: this.config.model,
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

    return normalizeRequestedModel(model) ===
      normalizeRequestedModel(this.config.model);
  }

  getPublicModelList(): OpenAIModel[] {
    if (!this.config) {
      return [];
    }

    return [
      {
        id: this.config.model,
        object: "model",
        owned_by: this.config.provider,
        created: Math.floor(this.deps.now() / 1000),
      },
    ];
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

    return this.deps.fetch(buildChatCompletionsUrl(this.config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(
        sanitizeFallbackChatRequestBody(body, model, {
          stream: options.stream,
        }),
      ),
      signal: options.signal,
    });
  }
}

export const externalFallbackProvider = new OpenAICompatFallbackProvider();
