import type { ModelDefinition } from "./models.js";

export interface HostModelDefinition {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

function formatModelFamily(family: string): string {
  const words = family
    .trim()
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1));
  return words.join(" ") || "Model";
}

export function buildHostModelDefinition(
  model: ModelDefinition,
): HostModelDefinition {
  return {
    id: model.id,
    name: `Claude ${formatModelFamily(model.family)}`,
    api: "openai-completions",
    // These definitions are produced only from successful Claude CLI probes.
    // Adaptive-vs-fixed reasoning is a separate capability; both accept the
    // proxy's normalized reasoning inputs.
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}
