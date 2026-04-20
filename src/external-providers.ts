import type {
  ExternalChatProvider,
  PublicExternalProviderInfo,
} from "./external-provider-types.js";
import { externalFallbackProvider } from "./fallback-provider.js";
import { geminiCliProvider } from "./gemini-cli-provider.js";
import type { OpenAIModel } from "./types/openai.js";

const PROVIDERS: ExternalChatProvider[] = [
  geminiCliProvider,
  externalFallbackProvider,
];

export function getConfiguredExternalProviders(): ExternalChatProvider[] {
  return PROVIDERS.filter((provider) => provider.isConfigured());
}

export function hasConfiguredExternalProvider(): boolean {
  return getConfiguredExternalProviders().length > 0;
}

export function getExternalProviderForModel(
  model: string | undefined,
): ExternalChatProvider | null {
  if (!model) {
    return null;
  }

  return getConfiguredExternalProviders().find((provider) =>
    provider.supportsModel(model)
  ) || null;
}

export function getDefaultExternalProvider(): ExternalChatProvider | null {
  return getConfiguredExternalProviders()[0] || null;
}

export function getPublicExternalProviderInfos(): PublicExternalProviderInfo[] {
  return getConfiguredExternalProviders()
    .map((provider) => provider.getPublicInfo())
    .filter((info): info is PublicExternalProviderInfo => info !== null);
}

export function getPublicExternalModelList(): OpenAIModel[] {
  const merged: OpenAIModel[] = [];
  const seen = new Set<string>();

  for (const provider of getConfiguredExternalProviders()) {
    for (const model of provider.getPublicModelList()) {
      if (seen.has(model.id)) {
        continue;
      }
      seen.add(model.id);
      merged.push(model);
    }
  }

  return merged;
}
