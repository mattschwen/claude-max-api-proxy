import fs from "node:fs";
import path from "node:path";

export type SameConversationPolicy = "latest-wins" | "queue";

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

export function parseSameConversationPolicy(
  value: string | undefined,
): SameConversationPolicy {
  const normalized = value?.trim().toLowerCase();
  return normalized === "queue" ? "queue" : "latest-wins";
}

export interface ProxyRuntimeConfig {
  sameConversationPolicy: SameConversationPolicy;
  debugQueues: boolean;
  enableAdminApi: boolean;
  defaultThinkingBudget: string | undefined;
  defaultAgent: string | undefined;
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
  };
}

export const runtimeConfig = readRuntimeConfig();
