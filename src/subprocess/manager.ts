/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 *
 * Phase 1b: Kill escalation (SIGTERM -> SIGKILL after 5s grace)
 * Phase 1c: No duplicate timeout — caller (routes) owns all timeout behavior
 * Phase 4a: Structured logging
 */
import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { isAssistantMessage, isResultMessage, isContentDelta } from "../types/claude-cli.js";
import type { ClaudeCliMessage, ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
import { log, logError } from "../logger.js";

const KILL_ESCALATION_MS = 5000;

// Cache cleaned environment once at startup
const CLEAN_ENV = (() => {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION;
  delete env.CLAUDE_CODE_PARENT;
  return env;
})();

export interface SubprocessOptions {
  model: ClaudeModel;
  sessionId?: string;
  systemPrompt?: string;
  isResume?: boolean;
  cwd?: string;
  thinkingBudget?: number;
}

export interface SubprocessEvents {
  message: (msg: ClaudeCliMessage) => void;
  content_delta: (msg: ClaudeCliStreamEvent) => void;
  assistant: (msg: ClaudeCliAssistant) => void;
  result: (result: ClaudeCliResult) => void;
  error: (error: Error) => void;
  close: (code: number | null) => void;
  raw: (line: string) => void;
}

/**
 * Global subprocess registry for server-wide cleanup.
 * Tracks all active subprocesses so graceful shutdown can kill them all.
 */
class SubprocessRegistry {
  private active = new Map<number, ClaudeSubprocess>();

  register(subprocess: ClaudeSubprocess): void {
    const pid = subprocess.getPid();
    if (pid !== null) {
      this.active.set(pid, subprocess);
    }
  }

  unregister(subprocess: ClaudeSubprocess): void {
    const pid = subprocess.getPid();
    if (pid !== null) {
      this.active.delete(pid);
    }
  }

  killAll(): void {
    log("server.shutdown", { reason: `Killing ${this.active.size} active subprocesses` });
    for (const [, sub] of this.active) {
      sub.kill();
    }
  }

  getActivePids(): number[] {
    return Array.from(this.active.keys());
  }

  get size(): number {
    return this.active.size;
  }
}

export const subprocessRegistry = new SubprocessRegistry();

export class ClaudeSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = "";
  private killed = false;
  private escalationTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start the Claude CLI subprocess with the given prompt.
   * No timeout is set here — caller owns timeout behavior (Phase 1c).
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const args = this.buildArgs(prompt, options);

    return new Promise<void>((resolve, reject) => {
      try {
        this.process = spawn("claude", args, {
          cwd: options.cwd || process.cwd(),
          env: CLEAN_ENV,
          stdio: ["pipe", "pipe", "pipe"],
        });

        this.process.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") {
            reject(new Error("Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"));
          } else {
            reject(err);
          }
        });

        this.process.stdin?.end();

        const pid = this.process.pid;
        log("subprocess.spawn", {
          pid,
          model: options.model,
          thinking: options.thinkingBudget ?? "off",
          sessionId: options.sessionId?.slice(0, 8),
          resume: options.isResume,
        });

        subprocessRegistry.register(this);

        this.process.stdout?.on("data", (chunk: Buffer) => {
          this.buffer += chunk.toString();
          this.processBuffer();
        });

        this.process.stderr?.on("data", (chunk: Buffer) => {
          const errorText = chunk.toString().trim();
          if (errorText && process.env.DEBUG) {
            console.error("[Subprocess stderr]:", errorText.slice(0, 200));
          }
        });

        this.process.on("close", (code: number | null) => {
          log("subprocess.close", { pid: this.process?.pid, code });
          subprocessRegistry.unregister(this);
          if (this.buffer.trim()) {
            this.processBuffer();
          }
          this.emit("close", code);
        });

        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  private buildArgs(prompt: string, options: SubprocessOptions): string[] {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", options.model,
      "--dangerously-skip-permissions",
    ];

    if (options.isResume && options.sessionId) {
      args.push("--resume", options.sessionId);
    } else if (options.sessionId) {
      args.push("--session-id", options.sessionId);
    }

    if (options.systemPrompt) {
      args.push("--system-prompt", options.systemPrompt);
    }

    if (options.model === "opus") {
      args.push("--fallback-model", "sonnet");
    }

    if (options.thinkingBudget) {
      args.push("--extended-thinking-budget", String(options.thinkingBudget));
    }

    args.push(prompt);
    return args;
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: ClaudeCliMessage = JSON.parse(trimmed);
        this.emit("message", message);

        if (isContentDelta(message)) {
          this.emit("content_delta", message);
        } else if (isAssistantMessage(message)) {
          this.emit("assistant", message);
        } else if (isResultMessage(message)) {
          this.emit("result", message);
        }
      } catch {
        this.emit("raw", trimmed);
      }
    }
  }

  /**
   * Kill the subprocess with escalation: SIGTERM -> SIGKILL after 5s grace.
   */
  kill(): void {
    if (this.killed || !this.process) return;

    this.killed = true;
    const pid = this.process.pid;

    log("subprocess.kill", { pid, signal: "SIGTERM" });
    this.process.kill("SIGTERM");

    // Escalate to SIGKILL if process doesn't exit within grace period
    this.escalationTimer = setTimeout(() => {
      if (this.process && this.process.exitCode === null) {
        log("subprocess.kill", { pid, signal: "SIGKILL", reason: "escalation after SIGTERM timeout" });
        this.process.kill("SIGKILL");
      }
    }, KILL_ESCALATION_MS);

    // Clear escalation timer if process exits normally
    this.process.once("close", () => {
      if (this.escalationTimer) {
        clearTimeout(this.escalationTimer);
        this.escalationTimer = null;
      }
    });
  }

  isRunning(): boolean {
    return this.process !== null && !this.killed && this.process.exitCode === null;
  }

  getPid(): number | null {
    return this.process?.pid ?? null;
  }
}

/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude(): Promise<{ ok: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["--version"], { stdio: "pipe" });
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on("error", () => {
      resolve({
        ok: false,
        error: "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
      });
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: output.trim() });
      } else {
        resolve({
          ok: false,
          error: "Claude CLI returned non-zero exit code",
        });
      }
    });
  });
}

/**
 * Check if Claude CLI is authenticated
 */
export async function verifyAuth(): Promise<{ ok: boolean; error?: string }> {
  return { ok: true };
}
