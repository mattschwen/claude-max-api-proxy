/**
 * Subprocess Warm-up Pool
 *
 * Pre-spawns Claude CLI processes so requests don't pay cold-start cost.
 */
import { spawn } from "child_process";
import { getCleanClaudeEnv, prepareClaudeSpawn } from "../claude-cli.inspect.js";
import { log, logError } from "../logger.js";
import { createEscalatedStop } from "./stop-with-escalation.js";

const POOL_SIZE = 5;
const WARMUP_INTERVAL_MS = 30 * 1000;
const WARM_DEEP_TIMEOUT_MS = 10_000;
const WARM_DEEP_KILL_GRACE_MS = 5_000;
const WARM_DEEP_FORCE_RELEASE_MS = 1_000;
// Only log warm success when the duration spikes past this threshold. The
// per-cycle happy-path success fires every 30s and has zero diagnostic
// value — it buried structured events in `docker logs`.
const WARM_SLOW_THRESHOLD_MS = 2000;
const IS_NODE_TEST = process.execArgv.some((arg) => arg.startsWith("--test"));

class SubprocessPool {
  private warmedAt = 0;
  private warming = false;

  async warm(): Promise<void> {
    if (this.warming) return;
    this.warming = true;
    const isInitial = this.warmedAt === 0;
    const start = Date.now();
    try {
      const promises: Promise<void>[] = [];
      for (let i = 0; i < POOL_SIZE; i++) {
        promises.push(this.spawnQuick());
      }
      await Promise.allSettled(promises);
      if (isInitial) {
        await this.warmDeep();
      }
      this.warmedAt = Date.now();
      const durationMs = Date.now() - start;
      if (isInitial || durationMs >= WARM_SLOW_THRESHOLD_MS) {
        log("pool.warmed", {
          poolSize: POOL_SIZE,
          deepWarm: isInitial,
          durationMs,
        });
      }
    } catch (err) {
      logError("pool.warm_failed", err, { poolSize: POOL_SIZE });
    } finally {
      this.warming = false;
    }
  }

  private spawnQuick(): Promise<void> {
    return new Promise<void>((resolve) => {
      const proc = spawn("claude", ["--version"], {
        stdio: "pipe",
        env: getCleanClaudeEnv(),
      });
      proc.on("close", () => resolve());
      proc.on("error", () => resolve());
      setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        resolve();
      }, 5000);
    });
  }

  private async warmDeep(): Promise<void> {
    // Deep warm touches the request path, so run the refresh preflight first
    // when the OAuth token is close to expiry. After that, the actual warm
    // subprocess runs normally without serializing the whole system.
    await prepareClaudeSpawn();
    return new Promise<void>((resolve) => {
      try {
        const proc = spawn(
          "claude",
          [
            "--print",
            "--output-format",
            "stream-json",
            "--model",
            "haiku",
            "hi",
          ],
          { stdio: "pipe", env: getCleanClaudeEnv() },
        );
        const stopper = createEscalatedStop(
          proc,
          resolve,
          WARM_DEEP_KILL_GRACE_MS,
          WARM_DEEP_FORCE_RELEASE_MS,
        );
        const timeoutId = setTimeout(
          stopper.requestStop,
          WARM_DEEP_TIMEOUT_MS,
        );
        const clearTimeouts = (): void => clearTimeout(timeoutId);
        proc.once("close", clearTimeouts);
        proc.once("error", () => {
          clearTimeouts();
          stopper.settle();
        });
        proc.stdout?.on("data", stopper.requestStop);
      } catch {
        resolve();
      }
    });
  }

  isWarm(): boolean {
    return Date.now() - this.warmedAt < WARMUP_INTERVAL_MS;
  }

  getStatus(): {
    warmedAt: string | null;
    isWarm: boolean;
    poolSize: number;
    warming: boolean;
  } {
    return {
      warmedAt: this.warmedAt ? new Date(this.warmedAt).toISOString() : null,
      isWarm: this.isWarm(),
      poolSize: POOL_SIZE,
      warming: this.warming,
    };
  }
}

export const subprocessPool = new SubprocessPool();

if (!IS_NODE_TEST) {
  subprocessPool
    .warm()
    .catch((err) => logError("pool.warm_failed", err, { phase: "initial" }));

  const poolWarmTimer = setInterval(() => {
    if (!subprocessPool.isWarm()) {
      subprocessPool
        .warm()
        .catch((err) => logError("pool.warm_failed", err, { phase: "interval" }));
    }
  }, WARMUP_INTERVAL_MS);

  if (typeof poolWarmTimer.unref === "function") {
    poolWarmTimer.unref();
  }
}
