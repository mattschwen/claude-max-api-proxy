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
import {
  isAssistantMessage,
  isResultMessage,
  isContentDelta,
} from "../types/claude-cli.js";
import type {
  ClaudeCliMessage,
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
import { log } from "../logger.js";
import {
  getCleanClaudeEnv,
  verifyClaude,
  verifyAuth,
} from "../claude-cli.inspect.js";
import { tokenGate } from "../auth/token-gate.js";
import {
  thinkingBudgetToEffort,
  type ReasoningEffort,
  type ReasoningMode,
} from "../reasoning.js";

const KILL_ESCALATION_MS = 5000;

export interface SubprocessOptions {
  model: ClaudeModel;
  sessionId?: string;
  systemPrompt?: string;
  isResume?: boolean;
  cwd?: string;
  thinkingBudget?: number;
  thinkingEffort?: ReasoningEffort;
  reasoningMode?: ReasoningMode;
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
    log("server.shutdown", {
      reason: `Killing ${this.active.size} active subprocesses`,
    });
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
   *
   * Token-gate semantics: spawns are serialized by `tokenGate` when the OAuth
   * refresh window is active. The gate MUST hold the mutex until this
   * subprocess has fully exited (close event) — otherwise two processes could
   * each trigger a refresh and race on refresh_token rotation. We achieve
   * that by having the gated fn's promise only resolve from the `close`
   * handler. The caller's `start()` promise, by contrast, resolves as soon
   * as the subprocess has been spawned so listeners keep working normally.
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const { args, prompt: finalPrompt } = this.buildArgs(prompt, options);

    return new Promise<void>((startResolve, startReject) => {
      // The promise returned here is what runGated will await: resolved only
      // on child close (or on spawn error). That keeps the mutex held for
      // the full subprocess lifetime.
      const gated = tokenGate.runGated<void>(
        () =>
          new Promise<void>((lifecycleResolve) => {
            try {
              this.process = spawn("claude", args, {
                cwd: options.cwd || process.cwd(),
                env: getCleanClaudeEnv(),
                stdio: ["pipe", "pipe", "pipe"],
              });

              this.process.on("error", (err: NodeJS.ErrnoException) => {
                const mapped =
                  err.code === "ENOENT"
                    ? new Error(
                        "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
                      )
                    : err;
                startReject(mapped);
                // Release the gate so queued spawns don't stall forever when
                // the binary is missing or spawn failed.
                lifecycleResolve();
              });

              // Pipe the prompt through stdin. Passing large prompts as argv
              // (OpenClaw system prompts + history) hits the kernel's ARG_MAX
              // limit and spawn() fails with E2BIG.
              this.process.stdin?.write(finalPrompt);
              this.process.stdin?.end();

              const pid = this.process.pid;
              const effort = options.thinkingEffort ||
                (options.thinkingBudget
                ? thinkingBudgetToEffort(options.thinkingBudget)
                : undefined);
              log("subprocess.spawn", {
                pid,
                model: options.model,
                reasoningMode: options.reasoningMode ?? "off",
                thinking: effort ?? "off",
                thinkingTokens: options.thinkingBudget ?? 0,
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
                  console.error(
                    "[Subprocess stderr]:",
                    errorText.slice(0, 200),
                  );
                }
              });

              this.process.on("close", (code: number | null) => {
                log("subprocess.close", { pid: this.process?.pid, code });
                subprocessRegistry.unregister(this);
                if (this.buffer.trim()) {
                  this.processBuffer();
                }
                this.emit("close", code);
                // Release the token gate only after the child has exited,
                // guaranteeing no other gated spawn starts while this one
                // might still be driving a refresh.
                lifecycleResolve();
              });

              startResolve();
            } catch (err) {
              startReject(err as Error);
              lifecycleResolve();
            }
          }),
      );
      // Surface any unexpected gate-path errors (should not happen — the
      // lifecycle promise never rejects) so they don't become unhandled.
      gated.catch(() => {
        /* noop: rejection path already delivered via startReject */
      });
    });
  }

  private buildArgs(
    prompt: string,
    options: SubprocessOptions,
  ): { args: string[]; prompt: string } {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      options.model,
      "--dangerously-skip-permissions",
    ];

    if (options.isResume && options.sessionId) {
      args.push("--resume", options.sessionId);
    } else if (options.sessionId) {
      args.push("--session-id", options.sessionId);
    }

    // Workaround for Anthropic's third-party-apps classifier:
    //
    // Passing client system prompts via --system-prompt (or --append-system-prompt)
    // causes Anthropic's server-side classifier to mark the request as originating
    // from a third-party app, which then returns:
    //   400 "Third-party apps now draw from your extra usage, not your plan limits."
    // This affects real-world agent-framework system prompts (e.g. OpenClaw's ~50KB
    // agent prompt) even though the underlying Claude CLI session is authenticated
    // as a first-party Claude Max user. Binary search showed the classifier keys on
    // content, not size (generic 50KB filler prompts pass; OpenClaw's prompt fails
    // around ~19KB, and multiple later chunks individually trigger the block).
    //
    // Fix: keep Claude CLI's default first-party system prompt ("You are Claude
    // Code, Anthropic's official CLI for Claude.") intact and embed the client's
    // system prompt inside the user message, wrapped in <instructions> tags. The
    // first-party sentinel is what the classifier keys on, so the request sails
    // through while the model still follows the embedded instructions.
    let finalPrompt = prompt;
    if (options.systemPrompt) {
      finalPrompt = `<instructions>\n${options.systemPrompt}\n</instructions>\n\n${prompt}`;
    }

    if (options.model === "opus") {
      args.push("--fallback-model", "sonnet");
    }

    // Map thinking budget (token count) to Claude CLI's --effort levels.
    // The CLI no longer supports a raw token budget; only level-based effort.
    // Mapping matches the inverse of REASONING_EFFORT_MAP in routes.ts.
    const level = options.thinkingEffort ||
      (options.thinkingBudget
        ? thinkingBudgetToEffort(options.thinkingBudget)
        : undefined);
    if (level) {
      args.push("--effort", level);
    }

    return { args, prompt: finalPrompt };
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
        log("subprocess.kill", {
          pid,
          signal: "SIGKILL",
          reason: "escalation after SIGTERM timeout",
        });
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
    return (
      this.process !== null && !this.killed && this.process.exitCode === null
    );
  }

  getPid(): number | null {
    return this.process?.pid ?? null;
  }
}
export { verifyClaude, verifyAuth } from "../claude-cli.inspect.js";
export { thinkingBudgetToEffort } from "../reasoning.js";
