import {
  probeModelAvailability,
  verifyClaude,
  verifyAuth,
  type ClaudeAuthStatus,
  type ClaudeProxyError,
  supportsAdaptiveReasoningCli,
  supportsXHighEffort,
} from "./claude-cli.inspect.js";
import type { ClaudeCliInit } from "./types/claude-cli.js";
import {
  createModelDefinition,
  getModelDefinitions,
  getModelList,
  resolveModelFamily,
  stripModelProviderPrefix,
  type ModelDefinition,
  type ModelFamily,
} from "./models.js";
import { runtimeConfig } from "./config.js";
import { log } from "./logger.js";

const PROBE_TTL_MS = 10 * 60 * 1000;
// When verifyAuth fails, normally the PROBE_TTL_MS cache would hold the
// "no models available" state for 10 minutes even though a fresh token
// refresh might succeed. To avoid sticking requests behind that cache, we
// force a refresh attempt at most once every AUTH_RETRY_COOLDOWN_MS when an
// auth failure has been observed.
const AUTH_RETRY_COOLDOWN_MS = 60 * 1000;
const DEFAULT_FAMILY_ORDER: ModelFamily[] = ["sonnet", "opus", "haiku"];

// Self-exit threshold: once this many consecutive verifyAuth failures have
// occurred, the proxy can no longer recover without outside help (credential
// file is zombie or the account is locked). Exit so Docker's
// `restart: unless-stopped` kicks us back up; the CLI re-reads creds on boot
// and the subprocess pool re-warms, which is enough to escape most stuck
// states without manual `make restart`.
const AUTH_SELF_EXIT_THRESHOLD = 5;
const AUTH_SELF_EXIT_DELAY_MS = 250;

export interface ModelAvailabilitySnapshot {
  checkedAt: number;
  auth: ClaudeAuthStatus | null;
  cli: {
    version?: string;
    supportsXHighEffort: boolean;
    supportsAdaptiveReasoning: boolean;
    permissionMode?: string;
    tools: string[];
    mcpServers: unknown[];
    slashCommands: unknown[];
    skills: unknown[];
    plugins: unknown[];
  } | null;
  available: ModelDefinition[];
  unavailable: Array<{
    definition: ModelDefinition;
    error: ClaudeProxyError;
  }>;
}

function pickDefaultModel(
  available: ModelDefinition[],
): ModelDefinition | null {
  for (const family of DEFAULT_FAMILY_ORDER) {
    const match = available.find((definition) => definition.family === family);
    if (match) return match;
  }
  return available[0] ?? null;
}

function normalizeProbeAlias(alias: string): string {
  return stripModelProviderPrefix(alias).trim().toLowerCase();
}

function getUniqueAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const alias of aliases) {
    const normalized = normalizeProbeAlias(alias);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function createResolvedDefinition(
  alias: string,
  resolvedModel?: string,
): ModelDefinition | null {
  const family = resolveModelFamily(resolvedModel || alias);
  if (!family) return null;
  const definition = createModelDefinition(family, resolvedModel || alias);
  return {
    ...definition,
    alias,
  };
}

function dedupeAvailableDefinitions(
  definitions: ModelDefinition[],
): ModelDefinition[] {
  const seen = new Set<string>();
  return definitions.filter((definition) => {
    if (seen.has(definition.id)) return false;
    seen.add(definition.id);
    return true;
  });
}

interface ModelAvailabilityDeps {
  verifyClaude: typeof verifyClaude;
  verifyAuth: typeof verifyAuth;
  probeModelAvailability: typeof probeModelAvailability;
  getModelDefinitions: typeof getModelDefinitions;
  getFallbackAliases: () => string[];
  exitProcess: (code: number) => void;
}

const defaultDeps: ModelAvailabilityDeps = {
  verifyClaude,
  verifyAuth,
  probeModelAvailability,
  getModelDefinitions,
  getFallbackAliases: () => runtimeConfig.modelFallbacks,
  exitProcess: (code) => {
    process.exit(code);
  },
};

export class ModelAvailabilityManager {
  private snapshot: ModelAvailabilitySnapshot | null = null;
  private refreshPromise: Promise<ModelAvailabilitySnapshot> | null = null;
  private lastAuthRetryAt = 0;
  private consecutiveAuthFailures = 0;
  private selfExitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ModelAvailabilityDeps = defaultDeps) {}

  getCachedSnapshot(): ModelAvailabilitySnapshot | null {
    return this.snapshot;
  }

  /**
   * Count of consecutive `refresh()` calls that came back with an auth
   * failure. Resets to 0 on the first successful `verifyAuth`. Exposed so
   * `/health` can fail when the credential file looks zombie.
   */
  getConsecutiveAuthFailures(): number {
    return this.consecutiveAuthFailures;
  }

  invalidate(): void {
    this.snapshot = null;
  }

  private getFallbackAliases(): string[] {
    return getUniqueAliases(this.deps.getFallbackAliases());
  }

  private resolveFallbackModel(
    available: ModelDefinition[],
  ): ModelDefinition | null {
    for (const fallbackAlias of this.getFallbackAliases()) {
      if (fallbackAlias === "default") {
        return (
          available.find((definition) => definition.alias === "default") ??
          pickDefaultModel(available)
        );
      }

      const exact = available.find(
        (definition) =>
          definition.alias === fallbackAlias || definition.id === fallbackAlias,
      );
      if (exact) return exact;

      const family = resolveModelFamily(fallbackAlias);
      if (!family) continue;
      const byFamily = available.find((definition) => definition.family === family);
      if (byFamily) return byFamily;
    }
    return null;
  }

  private scheduleSelfExit(): void {
    if (this.selfExitTimer) return;
    this.selfExitTimer = setTimeout(() => {
      this.selfExitTimer = null;
      this.deps.exitProcess(1);
    }, AUTH_SELF_EXIT_DELAY_MS);
    if (typeof this.selfExitTimer.unref === "function") {
      this.selfExitTimer.unref();
    }
  }

  private clearSelfExit(): void {
    if (!this.selfExitTimer) return;
    clearTimeout(this.selfExitTimer);
    this.selfExitTimer = null;
  }

  /**
   * When the last snapshot shows the CLI as unauthenticated, the generic
   * PROBE_TTL_MS (10 min) cache keeps returning "no models" even after a
   * successful token refresh. Bypass the cache at most once per
   * AUTH_RETRY_COOLDOWN_MS so a healed token is picked up quickly without
   * hammering verifyAuth on every request.
   */
  private shouldForceAuthRetry(): boolean {
    if (!this.snapshot) return false;
    if (this.snapshot.auth?.loggedIn) return false;
    return Date.now() - this.lastAuthRetryAt >= AUTH_RETRY_COOLDOWN_MS;
  }

  async getSnapshot(force = false): Promise<ModelAvailabilitySnapshot> {
    const isFresh =
      this.snapshot && Date.now() - this.snapshot.checkedAt < PROBE_TTL_MS;
    const authRetry = this.shouldForceAuthRetry();
    if (authRetry) {
      this.lastAuthRetryAt = Date.now();
    }
    if (!force && !authRetry && isFresh) {
      return this.snapshot!;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refresh();
    try {
      this.snapshot = await this.refreshPromise;
      return this.snapshot;
    } finally {
      this.refreshPromise = null;
    }
  }

  async getPublicModelList(): Promise<
    Array<{ id: string; object: string; owned_by: string; created: number }>
  > {
    const snapshot = await this.getSnapshot();
    return getModelList(snapshot.available);
  }

  async resolveRequestedModel(
    requestedModel?: string,
  ): Promise<ModelDefinition | null> {
    const snapshot = await this.getSnapshot();
    if (snapshot.available.length === 0) {
      return null;
    }

    if (!requestedModel) {
      return pickDefaultModel(snapshot.available);
    }

    const normalized = normalizeProbeAlias(requestedModel);

    if (normalized === "default") {
      return (
        snapshot.available.find((definition) => definition.alias === "default") ??
        pickDefaultModel(snapshot.available)
      );
    }

    const exact = snapshot.available.find(
      (definition) => definition.id === normalized,
    );
    if (exact) return exact;

    const family = resolveModelFamily(normalized);
    if (!family) {
      return this.resolveFallbackModel(snapshot.available);
    }

    return (
      snapshot.available.find((definition) => definition.family === family) ??
      this.resolveFallbackModel(snapshot.available)
    );
  }

  private buildCliSnapshot(
    version: string | undefined,
    init?: ClaudeCliInit,
  ): ModelAvailabilitySnapshot["cli"] {
    return {
      version,
      supportsXHighEffort: supportsXHighEffort(version),
      supportsAdaptiveReasoning: supportsAdaptiveReasoningCli(version),
      permissionMode: init?.permissionMode,
      tools: Array.isArray(init?.tools) ? init.tools : [],
      mcpServers: Array.isArray(init?.mcp_servers) ? init.mcp_servers : [],
      slashCommands: Array.isArray(init?.slash_commands)
        ? init.slash_commands
        : [],
      skills: Array.isArray(init?.skills) ? init.skills : [],
      plugins: Array.isArray(init?.plugins) ? init.plugins : [],
    };
  }

  private async refresh(): Promise<ModelAvailabilitySnapshot> {
    const [cliResult, authResult] = await Promise.all([
      this.deps.verifyClaude(),
      this.deps.verifyAuth(),
    ]);
    const definitions = this.deps.getModelDefinitions();

    if (!authResult.ok) {
      this.consecutiveAuthFailures += 1;
      if (this.consecutiveAuthFailures >= AUTH_SELF_EXIT_THRESHOLD) {
        log("auth.failure", {
          phase: "self_exit",
          consecutiveAuthFailures: this.consecutiveAuthFailures,
          message:
            "verifyAuth failed consecutively; exiting so the container restarts and re-reads credentials",
        });
        // Small delay so the log has a chance to flush before the process dies.
        this.scheduleSelfExit();
      }
      return {
        checkedAt: Date.now(),
        auth: authResult.status ?? null,
        cli: this.buildCliSnapshot(cliResult.version),
        available: [],
        unavailable: definitions.map((definition) => ({
          definition,
          error: {
            status: 401,
            type: "authentication_error",
            code: "auth_required",
            message: authResult.error || "Claude CLI is not authenticated",
          },
        })),
      };
    }

    this.consecutiveAuthFailures = 0;
    this.clearSelfExit();

    const primaryProbes = await Promise.all(
      definitions.map(async (definition) => ({
        definition,
        result: await this.deps.probeModelAvailability(definition.alias),
      })),
    );

    const fallbackAliases = this.getFallbackAliases().filter((alias) =>
      !definitions.some((definition) => definition.alias === alias)
    );
    const fallbackProbes = await Promise.all(
      fallbackAliases.map(async (alias) => ({
        alias,
        result: await this.deps.probeModelAvailability(alias),
      })),
    );

    let available: ModelDefinition[] = [];
    const unavailable: ModelAvailabilitySnapshot["unavailable"] = [];
    let cliInit: ClaudeCliInit | undefined;

    for (const probe of primaryProbes) {
      const resolvedDefinition = createModelDefinition(
        probe.definition.family,
        probe.result.resolvedModel || probe.definition.alias,
      );
      cliInit ||= probe.result.init;

      if (probe.result.ok) {
        available.push(resolvedDefinition);
      } else {
        unavailable.push({
          definition: resolvedDefinition,
          error: probe.result.error || {
            status: 502,
            type: "server_error",
            code: "claude_cli_error",
            message: `Claude CLI could not use model '${resolvedDefinition.id}'`,
          },
        });
      }
    }

    for (const probe of fallbackProbes) {
      const resolvedDefinition = createResolvedDefinition(
        probe.alias,
        probe.result.resolvedModel,
      );
      cliInit ||= probe.result.init;

      if (!resolvedDefinition) {
        continue;
      }

      if (probe.result.ok) {
        available.push(resolvedDefinition);
      } else {
        unavailable.push({
          definition: resolvedDefinition,
          error: probe.result.error || {
            status: 502,
            type: "server_error",
            code: "claude_cli_error",
            message: `Claude CLI could not use model '${resolvedDefinition.alias}'`,
          },
        });
      }
    }

    available = dedupeAvailableDefinitions(available);

    return {
      checkedAt: Date.now(),
      auth: authResult.status ?? null,
      cli: this.buildCliSnapshot(cliResult.version, cliInit),
      available,
      unavailable,
    };
  }
}

export const modelAvailability = new ModelAvailabilityManager();
