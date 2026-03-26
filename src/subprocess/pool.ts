/**
 * Subprocess Warm-up Pool
 *
 * Pre-spawns Claude CLI processes so requests don't pay cold-start cost.
 */
import { spawn } from "child_process";

const POOL_SIZE = 5;
const WARMUP_INTERVAL_MS = 30 * 1000;

// Clean env matching manager.ts
const CLEAN_ENV = (() => {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION;
  delete env.CLAUDE_CODE_PARENT;
  return env;
})();

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
      console.log(`[SubprocessPool] Warmed ${POOL_SIZE} processes${isInitial ? " + deep warm" : ""} in ${Date.now() - start}ms`);
    } catch (err) {
      console.error("[SubprocessPool] Warm error:", err);
    } finally {
      this.warming = false;
    }
  }

  private spawnQuick(): Promise<void> {
    return new Promise<void>((resolve) => {
      const proc = spawn("claude", ["--version"], { stdio: "pipe", env: CLEAN_ENV });
      proc.on("close", () => resolve());
      proc.on("error", () => resolve());
      setTimeout(() => {
        try { proc.kill(); } catch { /* ignore */ }
        resolve();
      }, 5000);
    });
  }

  private warmDeep(): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        const proc = spawn("claude", [
          "--print", "--output-format", "stream-json",
          "--model", "haiku",
          "hi",
        ], { stdio: "pipe", env: CLEAN_ENV });
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          try { proc.kill(); } catch { /* ignore */ }
          resolve();
        };
        proc.stdout?.on("data", finish);
        proc.on("close", finish);
        proc.on("error", finish);
        setTimeout(finish, 10000);
      } catch {
        resolve();
      }
    });
  }

  isWarm(): boolean {
    return (Date.now() - this.warmedAt) < WARMUP_INTERVAL_MS;
  }

  getStatus(): { warmedAt: string | null; isWarm: boolean; poolSize: number; warming: boolean } {
    return {
      warmedAt: this.warmedAt ? new Date(this.warmedAt).toISOString() : null,
      isWarm: this.isWarm(),
      poolSize: POOL_SIZE,
      warming: this.warming,
    };
  }
}

export const subprocessPool = new SubprocessPool();

subprocessPool.warm().catch(err => console.error("[SubprocessPool] Initial warm error:", err));

setInterval(() => {
  if (!subprocessPool.isWarm()) {
    subprocessPool.warm().catch(err => console.error("[SubprocessPool] Re-warm error:", err));
  }
}, WARMUP_INTERVAL_MS);
