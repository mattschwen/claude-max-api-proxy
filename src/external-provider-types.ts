import type { ExternalFallbackStreamMode } from "./config.js";
import type { OpenAIModel } from "./types/openai.js";

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
  requestChatCompletion(
    body: Record<string, unknown>,
    model: string,
    options?: {
      signal?: AbortSignal;
      stream?: boolean;
    },
  ): Promise<Response>;
}
