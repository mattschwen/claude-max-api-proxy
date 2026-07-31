import type {
  ExternalChatProvider,
  ExternalProviderAvailability,
  ExternalProviderProbeOptions,
  PublicExternalProviderInfo,
} from "./external-provider-types.js";
import { runtimeConfig, type OpenAICompatFallbackConfig } from "./config.js";
import { OpenAICompatFallbackProvider } from "./fallback-provider.js";
import { geminiCliProvider } from "./gemini-cli-provider.js";
import {
  isCollisionProneExternalModelId,
  stripModelProviderPrefix,
} from "./models.js";
import type { OpenAIModel } from "./types/openai.js";

export function buildExternalProviderRegistry(
  configs: OpenAICompatFallbackConfig[],
  cliProvider: ExternalChatProvider = geminiCliProvider,
): ExternalChatProvider[] {
  const providers: ExternalChatProvider[] = [cliProvider];
  const seen = new Map<string, string>();
  if (cliProvider.isConfigured()) {
    const cliName = cliProvider.getPublicInfo()?.provider ?? "local-cli";
    for (const descriptor of cliProvider.getModelDescriptors()) {
      if (isCollisionProneExternalModelId(descriptor.id)) {
        throw new Error(
          `External model '${descriptor.id}' from '${cliName}' collides with a Claude route`,
        );
      }
      seen.set(
        stripModelProviderPrefix(descriptor.id).trim().toLowerCase(),
        cliName,
      );
    }
  }
  for (const config of configs) {
    const provider = new OpenAICompatFallbackProvider(config);
    for (const descriptor of provider.getModelDescriptors()) {
      if (isCollisionProneExternalModelId(descriptor.id)) {
        throw new Error(
          `External model '${descriptor.id}' from '${config.provider}' collides with a Claude route`,
        );
      }
      const key = stripModelProviderPrefix(descriptor.id).trim().toLowerCase();
      const existing = seen.get(key);
      if (existing) {
        throw new Error(
          `External model '${descriptor.id}' is claimed by both '${existing}' and '${config.provider}'`,
        );
      }
      seen.set(key, config.provider);
    }
    providers.push(provider);
  }
  return providers;
}

const PROVIDERS: ExternalChatProvider[] = [
  ...buildExternalProviderRegistry(runtimeConfig.externalProviders),
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

export function getExternalProviderAvailability(): Array<{
  provider: string;
  availability: ExternalProviderAvailability;
}> {
  return getConfiguredExternalProviders().map((provider) => ({
    provider: provider.getPublicInfo()?.provider ?? "unknown",
    availability: provider.getAvailability(),
  }));
}

export async function probeConfiguredExternalProviders(
  options: ExternalProviderProbeOptions = {},
): Promise<
  Array<{
    provider: string;
    availability: ExternalProviderAvailability;
  }>
> {
  return Promise.all(
    getConfiguredExternalProviders().map(async (provider) => ({
      provider: provider.getPublicInfo()?.provider ?? "unknown",
      availability: await provider.probeAvailability(options),
    })),
  );
}
