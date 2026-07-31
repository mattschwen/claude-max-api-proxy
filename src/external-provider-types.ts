import type { ExternalFallbackStreamMode } from "./config.js";
import type { OpenAIModel } from "./types/openai.js";

export interface ExternalModelCapabilities {
  chatCompletions: boolean;
  streaming: boolean;
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
  structuredOutputs: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ExternalModelDescriptor {
  id: string;
  upstreamId?: string;
  ownedBy: string;
  timeoutMs: number;
  capabilities: ExternalModelCapabilities;
}

export type ExternalProviderAvailabilityState =
  | "unconfigured"
  | "unknown"
  | "available"
  | "unavailable";

export interface ExternalProviderAvailability {
  configured: boolean;
  state: ExternalProviderAvailabilityState;
  checkedAt?: number;
  availableModels: string[];
  unavailableModels: string[];
  error?: string;
}

export interface ExternalProviderProbeOptions {
  signal?: AbortSignal;
  model?: string;
}

export interface PublicExternalProviderInfo {
  provider: string;
  transport: "openai-compatible" | "local-cli";
  model: string;
  extraModels?: string[];
  streamMode: ExternalFallbackStreamMode;
  baseUrl?: string;
  command?: string;
  workdir?: string;
}

export interface ExternalChatProvider {
  isConfigured(): boolean;
  getDefaultModel(): string | null;
  resolveModel(requestedModel?: string): string | null;
  getPublicInfo(): PublicExternalProviderInfo | null;
  usesSyntheticStreaming(): boolean;
  supportsModel(model: string | undefined): boolean;
  getPublicModelList(): OpenAIModel[];
  getModelDescriptors(): ExternalModelDescriptor[];
  getModelDescriptor(model: string | undefined): ExternalModelDescriptor | null;
  getAvailability(): ExternalProviderAvailability;
  probeAvailability(
    options?: ExternalProviderProbeOptions,
  ): Promise<ExternalProviderAvailability>;
  requestChatCompletion(
    body: Record<string, unknown>,
    model: string,
    options?: {
      signal?: AbortSignal;
      stream?: boolean;
    },
  ): Promise<Response>;
}
