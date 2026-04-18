/**
 * Token Gate: serialize `claude` CLI spawns around the OAuth refresh window.
 *
 * Background
 * ----------
 * The Claude CLI's OAuth refresh_token is rotated on every refresh: as soon as
 * a new pair is issued, the previous refresh_token becomes invalid. When
 * several `claude` subprocesses start concurrently and the access_token is
 * close to its TTL, each child may try to refresh independently. The first
 * POST wins; the others send a now-invalidated refresh_token and either
 * overwrite `.credentials.json` with a stale response, or the access_token
 * they just received gets superseded by the winner's write. The net result is
 * a "zombie" credential file that looks valid locally (fresh `expiresAt`) but
 * is already revoked server-side.
 *
 * Design
 * ------
 * - Exposes `runGated(fn)` that runs `fn()` through a promise-chained mutex
 *   ONLY when `now` falls inside `[expiresAt - 30min, expiresAt + 5min]`.
 * - Outside that window we take the fast path (no serialization overhead).
 * - Credentials file is re-read on every call so refreshes performed by the
 *   CLI are visible immediately.
 * - Missing / malformed credentials file → fast path (fail-open to avoid
 *   deadlocking the proxy if the file is briefly absent).
 */
import fs from "node:fs";
import path from "node:path";

const REFRESH_LEAD_MS = 30 * 60 * 1000; // 30 minutes before expiry
const REFRESH_TAIL_MS = 5 * 60 * 1000; // 5 minutes after expiry (grace)

interface ClaudeCredentials {
  claudeAiOauth?: {
    expiresAt?: number;
  };
}

export interface TokenGateOptions {
  credentialsPath?: string;
  leadMs?: number;
  tailMs?: number;
  now?: () => number;
}

export class TokenGate {
  private mutex: Promise<void> = Promise.resolve();
  private readonly credentialsPath: string;
  private readonly leadMs: number;
  private readonly tailMs: number;
  private readonly now: () => number;

  constructor(options: TokenGateOptions = {}) {
    this.credentialsPath =
      options.credentialsPath ??
      path.join(process.env.HOME || "/tmp", ".claude", ".credentials.json");
    this.leadMs = options.leadMs ?? REFRESH_LEAD_MS;
    this.tailMs = options.tailMs ?? REFRESH_TAIL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Read the OAuth expiresAt timestamp from the credentials file.
   * Returns `null` if the file is missing, unreadable, or malformed.
   */
  private readExpiresAt(): number | null {
    try {
      const raw = fs.readFileSync(this.credentialsPath, "utf8");
      const parsed = JSON.parse(raw) as ClaudeCredentials;
      const expiresAt = parsed?.claudeAiOauth?.expiresAt;
      return typeof expiresAt === "number" && Number.isFinite(expiresAt)
        ? expiresAt
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether `now` falls inside the refresh window. Exposed for tests.
   */
  isInRefreshWindow(): boolean {
    const expiresAt = this.readExpiresAt();
    if (expiresAt === null) return false;
    const now = this.now();
    return now >= expiresAt - this.leadMs && now <= expiresAt + this.tailMs;
  }

  /**
   * Run `fn` with token-refresh serialization applied only when necessary.
   *
   * Inside the refresh window: queue behind the previous gated call via a
   * promise-chained mutex so only one `claude` subprocess can drive a
   * refresh at a time. The mutex is held for the ENTIRE lifetime of `fn`
   * (including any streaming subprocess) so a refresh that starts at spawn
   * time can finish before the next subprocess begins.
   *
   * Outside the window: fast-path — invoke `fn` directly.
   */
  async runGated<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.isInRefreshWindow()) {
      return fn();
    }

    const prev = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }
}

export const tokenGate = new TokenGate();
