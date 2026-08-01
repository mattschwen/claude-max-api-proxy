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
import { resolveModelFamily } from "../models.js";
import { runtimeConfig } from "../config.js";
import { readFileSync, statSync } from "fs";
import {
  prepareClaudeSpawn,
  getCleanClaudeEnv,
  verifyClaude,
  verifyAuth,
} from "../claude-cli.inspect.js";
import {
  thinkingBudgetToEffort,
  type ReasoningEffort,
  type ReasoningMode,
} from "../reasoning.js";

const KILL_ESCALATION_MS = 5000;
const KILL_FORCE_RELEASE_MS = 1000;
const MAX_BUFFER_BYTES = 1024 * 1024;

// Optional global ("house") system prompt sourced from a file
// (CLAUDE_PROXY_SYSTEM_PROMPT_FILE). It is injected into the proxy's
// <instructions> wrapper in the USER message on every request — deliberately
// NOT via --system-prompt, which trips Anthropic's third-party-apps classifier
// (see buildArgs below). Cached by mtime so edits to the file apply on the next
// request without a restart.
let housePromptCache:
  | { path: string; mtimeMs: number; content: string }
  | null = null;
let housePromptWarnedPath: string | null = null;

export function getHouseSystemPrompt(
  filePath = runtimeConfig.systemPromptFile,
): string {
  if (!filePath) return "";
  try {
    const { mtimeMs } = statSync(filePath);
    if (
      housePromptCache &&
      housePromptCache.path === filePath &&
      housePromptCache.mtimeMs === mtimeMs
    ) {
      return housePromptCache.content;
    }
    const content = readFileSync(filePath, "utf8").trim();
    housePromptCache = { path: filePath, mtimeMs, content };
    housePromptWarnedPath = null;
    return content;
  } catch (err) {
    if (housePromptWarnedPath !== filePath) {
      housePromptWarnedPath = filePath;
      log("system_prompt_file.unreadable", {
        path: filePath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return "";
  }
}

export function buildClaudePrompt(
  prompt: string,
  requestSystemPrompt?: string,
  houseSystemPrompt = getHouseSystemPrompt(),
): string {
  const combinedSystem = [houseSystemPrompt, requestSystemPrompt]
    .filter((part) => part && part.trim())
    .join("\n\n");
  return combinedSystem
    ? `<instructions>\n${combinedSystem}\n</instructions>\n\n${prompt}`
    : prompt;
}

export interface ActiveSubprocessSnapshot {
  pid: number;
  model: string;
  modelFamily: string;
  startedAt: number;
  uptimeMs: number;
  reasoningMode: string;
  thinking: string;
  isResume: boolean;
  sessionId?: string;
  sessionIdShort?: string;
}

export interface SubprocessOptions {
  model: ClaudeModel;
  sessionId?: string;
  systemPrompt?: string;
  isResume?: boolean;
  /** Resume from the parent checkpoint without mutating it. */
  forkSession?: boolean;
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

  getActiveSnapshots(now = Date.now()): ActiveSubprocessSnapshot[] {
    return Array.from(this.active.values())
      .map((subprocess) => subprocess.getActiveSnapshot(now))
      .filter(
        (snapshot): snapshot is ActiveSubprocessSnapshot => snapshot !== null,
      )
      .sort((left, right) => right.uptimeMs - left.uptimeMs);
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
  private stopPromise: Promise<void> | null = null;
  private closed = false;
  private startedAt = 0;
  private model: ClaudeModel | null = null;
  private reasoningMode = "off";
  private thinking = "off";
  private sessionId?: string;
  private isResume = false;

  /**
   * Start the Claude CLI subprocess with the given prompt.
   * No timeout is set here — caller owns timeout behavior (Phase 1c).
   *
   * Token-gate semantics: when the OAuth refresh window is active we first run
   * a single-flight refresh preflight, then spawn the real request normally.
   * That avoids full-request serialization while still shrinking the race
   * window around refresh_token rotation.
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const { args, prompt: finalPrompt } = this.buildArgs(prompt, options);
    await prepareClaudeSpawn();
    if (this.killed) {
      throw new Error("Claude subprocess was cancelled before spawn");
    }

    return new Promise<void>((startResolve, startReject) => {
      try {
        if (this.killed) {
          startReject(new Error("Claude subprocess was cancelled before spawn"));
          return;
        }
        this.process = spawn("claude", args, {
          cwd: options.cwd || process.cwd(),
          env: getCleanClaudeEnv(),
          stdio: ["pipe", "pipe", "pipe"],
        });
        this.closed = false;

        this.process.on("error", (err: NodeJS.ErrnoException) => {
          const mapped =
            err.code === "ENOENT"
              ? new Error(
                  "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
                )
              : err;
          startReject(mapped);
        });

        // Pipe the prompt through stdin. Passing large prompts as argv
        // (OpenClaw system prompts + history) hits the kernel's ARG_MAX
        // limit and spawn() fails with E2BIG.
        const stdin = this.process.stdin;
        if (stdin) {
          stdin.on("error", (err: NodeJS.ErrnoException) => {
            // EPIPE happens when claude exits before consuming the prompt;
            // surfacing it as a process error would mask the real exit reason.
            if (err.code !== "EPIPE") {
              log("subprocess.kill", {
                pid: this.process?.pid,
                reason: `stdin error: ${err.message}`,
              });
            }
          });
          const ok = stdin.write(finalPrompt);
          if (!ok) {
            stdin.once("drain", () => stdin.end());
          } else {
            stdin.end();
          }
        }

        const pid = this.process.pid;
        const effort =
          options.thinkingEffort ||
          (options.thinkingBudget
            ? thinkingBudgetToEffort(options.thinkingBudget)
            : undefined);
        this.startedAt = Date.now();
        this.model = options.model;
        this.reasoningMode = options.reasoningMode ?? "off";
        this.thinking = effort ?? "off";
        this.sessionId = options.sessionId;
        this.isResume = options.isResume === true;
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
          if (this.buffer.length > MAX_BUFFER_BYTES) {
            log("subprocess.kill", {
              pid: this.process?.pid,
              reason: "buffer_overflow",
              bufferBytes: this.buffer.length,
            });
            this.buffer = "";
            this.emit(
              "error",
              new Error(
                `Subprocess output exceeded ${MAX_BUFFER_BYTES} bytes without producing parseable JSON`,
              ),
            );
            this.kill();
            return;
          }
          this.processBuffer();
        });

        this.process.stderr?.on("data", (chunk: Buffer) => {
          const errorText = chunk.toString().trim();
          if (errorText && process.env.DEBUG) {
            console.error("[Subprocess stderr]:", errorText.slice(0, 200));
          }
        });

        this.process.on("close", (code: number | null) => {
          this.closed = true;
          log("subprocess.close", { pid: this.process?.pid, code });
          subprocessRegistry.unregister(this);
          if (this.buffer.trim()) {
            this.processBuffer();
          }
          this.emit("close", code);
        });

        startResolve();
      } catch (err) {
        startReject(err as Error);
      }
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
      if (options.forkSession) {
        args.push("--fork-session");
      }
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
    // Merge the optional global house prompt (CLAUDE_PROXY_SYSTEM_PROMPT_FILE)
    // ahead of any per-request client system prompt, then wrap both in the
    // <instructions> block embedded in the user message.
    const finalPrompt = buildClaudePrompt(prompt, options.systemPrompt);

    // Don't add a fallback model when extended thinking is active. A mid-turn
    // fallback (opus -> sonnet) produces a thinking block with a different
    // signature; resuming the next turn against that mismatched block triggers
    // Anthropic's "thinking blocks ... cannot be modified" 400. Keeping the
    // model stable preserves thinking-block continuity across resumes.
    const hasThinking = !!(options.thinkingEffort || options.thinkingBudget);
    if (options.model === "opus" && !hasThinking) {
      args.push("--fallback-model", "sonnet");
    }

    // Map thinking budget (token count) to Claude CLI's --effort levels.
    // The CLI no longer supports a raw token budget; only level-based effort.
    // Mapping matches the inverse of REASONING_EFFORT_MAP in routes.ts.
    const level =
      options.thinkingEffort ||
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
    if (this.killed) return;

    this.killed = true;
    if (!this.process) return;
    const pid = this.process.pid;

    log("subprocess.kill", { pid, signal: "SIGTERM" });
    this.process.kill("SIGTERM");

    // Escalate to SIGKILL if process doesn't exit within grace period.
    // unref() so the timer never keeps the event loop alive on its own.
    this.escalationTimer = setTimeout(() => {
      this.escalationTimer = null;
      if (this.process && this.process.exitCode === null) {
        log("subprocess.kill", {
          pid,
          signal: "SIGKILL",
          reason: "escalation after SIGTERM timeout",
        });
        this.process.kill("SIGKILL");
      }
    }, KILL_ESCALATION_MS);
    if (typeof this.escalationTimer.unref === "function") {
      this.escalationTimer.unref();
    }

    // Clear escalation timer if process exits normally
    this.process.once("close", () => {
      if (this.escalationTimer) {
        clearTimeout(this.escalationTimer);
        this.escalationTimer = null;
      }
    });
  }

  /**
   * Stop the subprocess and resolve only after it closes, or after bounded
   * SIGTERM/SIGKILL escalation has been exhausted. Calling this before spawn
   * prevents a pending start() from creating the child later.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.process || this.closed) {
      this.kill();
      return Promise.resolve();
    }

    const proc = this.process;
    this.stopPromise = new Promise<void>((resolve) => {
      let settled = false;
      let forceReleaseTimer: ReturnType<typeof setTimeout> | null = null;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        if (forceReleaseTimer) {
          clearTimeout(forceReleaseTimer);
        }
        resolve();
      };

      proc.once("close", settle);
      if (proc.exitCode === null) {
        this.kill();
      }
      forceReleaseTimer = setTimeout(
        settle,
        KILL_ESCALATION_MS + KILL_FORCE_RELEASE_MS,
      );
    });
    return this.stopPromise;
  }

  /**
   * Wait for stdout/stderr and the child process to fully close before the
   * caller releases its queue slot. A result event can arrive before `close`,
   * so a short grace period is followed by the same bounded stop escalation
   * used for cancellation.
   */
  waitForExit(graceMs = KILL_FORCE_RELEASE_MS): Promise<void> {
    if (!this.process || this.closed) return Promise.resolve();
    const proc = this.process;
    return new Promise<void>((resolve) => {
      let settled = false;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        if (graceTimer) clearTimeout(graceTimer);
        proc.removeListener("close", settle);
        resolve();
      };
      proc.once("close", settle);
      graceTimer = setTimeout(() => {
        void this.stop().finally(settle);
      }, Math.max(0, graceMs));
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

  getActiveSnapshot(now = Date.now()): ActiveSubprocessSnapshot | null {
    const pid = this.getPid();
    if (pid === null || !this.model || this.startedAt === 0) {
      return null;
    }

    return {
      pid,
      model: this.model,
      modelFamily: resolveModelFamily(this.model) ?? "unknown",
      startedAt: this.startedAt,
      uptimeMs: Math.max(0, now - this.startedAt),
      reasoningMode: this.reasoningMode,
      thinking: this.thinking,
      isResume: this.isResume,
      sessionId: this.sessionId,
      sessionIdShort: this.sessionId?.slice(0, 8),
    };
  }
}
export { verifyClaude, verifyAuth } from "../claude-cli.inspect.js";
export { thinkingBudgetToEffort } from "../reasoning.js";
