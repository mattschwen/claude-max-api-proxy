import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createDoneChunk, estimateTokens } from "./adapter/cli-to-openai.js";
import {
  type GeminiCliFallbackConfig,
  runtimeConfig,
} from "./config.js";
import type {
  ExternalChatProvider,
  PublicExternalProviderInfo,
} from "./external-provider-types.js";
import { stripModelProviderPrefix } from "./models.js";
import type {
  OpenAIChatMessage,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIModel,
} from "./types/openai.js";

interface GeminiCliProviderDeps {
  now: () => number;
  randomId: () => string;
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface GeminiCliExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const KILL_ESCALATION_MS = 3000;

function normalizeRequestedModel(model: string): string {
  return stripModelProviderPrefix(model).trim().toLowerCase();
}

function flattenChatContent(content: OpenAIChatMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function buildGeminiCliPrompt(
  messages: OpenAIChatRequest["messages"],
): string {
  const systemParts: string[] = [];
  const transcriptParts: string[] = [];

  for (const message of messages) {
    const text = flattenChatContent(message.content).trim();
    if (!text) {
      continue;
    }

    if (message.role === "system" || message.role === "developer") {
      systemParts.push(text);
      continue;
    }

    transcriptParts.push(`<${message.role}>\n${text}\n</${message.role}>`);
  }

  const sections: string[] = [];
  if (systemParts.length > 0) {
    sections.push(`<system>\n${systemParts.join("\n\n")}\n</system>`);
  }
  if (transcriptParts.length > 0) {
    sections.push(`<conversation>\n${transcriptParts.join("\n\n")}\n</conversation>`);
  }
  sections.push(
    "Continue the conversation with the next assistant message only. Do not include XML tags, role labels, or extra wrapper text.",
  );

  return sections.join("\n\n").trim();
}

function readNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function getFirstModelStats(
  source: unknown,
): Record<string, unknown> | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const models =
    "models" in source &&
      source.models &&
      typeof source.models === "object" &&
      !Array.isArray(source.models)
      ? source.models
      : undefined;
  if (!models) {
    return undefined;
  }

  const [firstKey] = Object.keys(models);
  if (!firstKey) {
    return undefined;
  }

  const first = (models as Record<string, unknown>)[firstKey];
  return first && typeof first === "object" && !Array.isArray(first)
    ? first as Record<string, unknown>
    : undefined;
}

export function readGeminiCliJsonUsage(
  payload: unknown,
  content: string,
): OpenAIUsage {
  const stats =
    payload && typeof payload === "object" && "stats" in payload
      ? payload.stats
      : undefined;
  const modelStats = getFirstModelStats(stats);
  const tokens =
    modelStats &&
      "tokens" in modelStats &&
      modelStats.tokens &&
      typeof modelStats.tokens === "object"
      ? modelStats.tokens
      : undefined;

  const promptTokens = readNumber(
    tokens && "prompt" in tokens ? tokens.prompt : undefined,
    tokens && "input" in tokens ? tokens.input : undefined,
  ) ?? 0;
  const completionTokens = readNumber(
    tokens && "output" in tokens ? tokens.output : undefined,
    tokens && "output_tokens" in tokens ? tokens.output_tokens : undefined,
    tokens && "candidates" in tokens ? tokens.candidates : undefined,
  ) ?? estimateTokens(content);
  const totalTokens = readNumber(
    tokens && "total" in tokens ? tokens.total : undefined,
    tokens && "total_tokens" in tokens ? tokens.total_tokens : undefined,
  ) ?? promptTokens + completionTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

export function readGeminiCliStreamUsage(
  payload: unknown,
  content: string,
): OpenAIUsage {
  const stats =
    payload && typeof payload === "object" && "stats" in payload
      ? payload.stats
      : undefined;
  const modelStats = getFirstModelStats(stats);

  const promptTokens = readNumber(
    stats && typeof stats === "object" && "input_tokens" in stats
      ? stats.input_tokens
      : undefined,
    stats && typeof stats === "object" && "input" in stats ? stats.input : undefined,
    modelStats && "input_tokens" in modelStats ? modelStats.input_tokens : undefined,
    modelStats && "input" in modelStats ? modelStats.input : undefined,
  ) ?? 0;
  const completionTokens = readNumber(
    stats && typeof stats === "object" && "output_tokens" in stats
      ? stats.output_tokens
      : undefined,
    modelStats && "output_tokens" in modelStats ? modelStats.output_tokens : undefined,
  ) ?? estimateTokens(content);
  const totalTokens = readNumber(
    stats && typeof stats === "object" && "total_tokens" in stats
      ? stats.total_tokens
      : undefined,
    modelStats && "total_tokens" in modelStats ? modelStats.total_tokens : undefined,
  ) ?? promptTokens + completionTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function tryParseJson(raw: string): unknown {
  return JSON.parse(raw);
}

function parseTrailingJson(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return tryParseJson(trimmed);
  } catch {
    /* ignore */
  }

  const lineStart = trimmed.lastIndexOf("\n{");
  if (lineStart >= 0) {
    const candidate = trimmed.slice(lineStart + 1);
    try {
      return tryParseJson(candidate);
    } catch {
      /* ignore */
    }
  }

  let brace = trimmed.lastIndexOf("{");
  while (brace >= 0) {
    const candidate = trimmed.slice(brace);
    try {
      return tryParseJson(candidate);
    } catch {
      brace = trimmed.lastIndexOf("{", brace - 1);
    }
  }

  return undefined;
}

export function buildGeminiCliErrorResponse(
  stdout: string,
  stderr: string,
): {
  status: number;
  body: {
    error: {
      message: string;
      type: string;
      code: string | null;
    };
  };
} {
  const parsed = parseTrailingJson(stderr) || parseTrailingJson(stdout);
  const parsedMessage =
    parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      parsed.error &&
      typeof parsed.error === "object" &&
      "message" in parsed.error &&
      typeof parsed.error.message === "string"
      ? parsed.error.message.trim()
      : "";

  const message = parsedMessage ||
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .find((line) => !line.startsWith("at ")) ||
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .find((line) => !line.startsWith("at ")) ||
    "Gemini CLI request failed.";

  const normalized = message.toLowerCase();
  let status = 502;
  let type = "server_error";
  let code: string | null = "gemini_cli_error";

  if (
    normalized.includes("capacity") ||
    normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("resource exhausted") ||
    normalized.includes("exhausted")
  ) {
    status = 429;
    type = "rate_limit_error";
    code = "rate_limit_exceeded";
  } else if (
    normalized.includes("auth") ||
    normalized.includes("unauthor") ||
    normalized.includes("forbidden") ||
    normalized.includes("credential") ||
    normalized.includes("login")
  ) {
    status = 401;
    type = "authentication_error";
    code = "authentication_failed";
  } else if (
    normalized.includes("not found") ||
    normalized.includes("modelnotfound")
  ) {
    status = 400;
    type = "invalid_request_error";
    code = "model_not_found";
  }

  return {
    status,
    body: {
      error: {
        message,
        type,
        code,
      },
    },
  };
}

export function buildGeminiCliChatCompletion(
  payload: unknown,
  model: string,
  requestId: string,
  createdAtMs: number,
): OpenAIChatResponse {
  const responseText =
    payload &&
      typeof payload === "object" &&
      "response" in payload &&
      typeof payload.response === "string"
      ? payload.response
      : "";
  const usage = readGeminiCliJsonUsage(payload, responseText);

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(createdAtMs / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: responseText,
        },
        finish_reason: "stop",
      },
    ],
    usage,
  };
}

export class GeminiCliProvider implements ExternalChatProvider {
  constructor(
    private readonly config: GeminiCliFallbackConfig | null =
      runtimeConfig.geminiCliFallback,
    private readonly deps: GeminiCliProviderDeps = {
      now: Date.now,
      randomId: () => randomUUID().replace(/-/g, "").slice(0, 24),
    },
  ) {}

  private getSupportedModels(): string[] {
    if (!this.config) {
      return [];
    }
    return [this.config.model, ...this.config.extraModels];
  }

  private getSupportedModelMap(): Map<string, string> {
    return new Map(
      this.getSupportedModels().map((model) => [normalizeRequestedModel(model), model]),
    );
  }

  private ensureWorkdir(): void {
    if (!this.config) {
      return;
    }
    fs.mkdirSync(this.config.workdir, { recursive: true });
  }

  private buildArgs(model: string, format: "json" | "stream-json"): string[] {
    return [
      "--model",
      model,
      "--prompt",
      "",
      "--approval-mode",
      "plan",
      "--output-format",
      format,
    ];
  }

  private killChildProcess(process: ChildProcessWithoutNullStreams): void {
    if (process.killed) {
      return;
    }

    process.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (!process.killed) {
        process.kill("SIGKILL");
      }
    }, KILL_ESCALATION_MS);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  private runGeminiJsonCommand(
    prompt: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<GeminiCliExecutionResult> {
    return new Promise((resolve) => {
      if (!this.config) {
        resolve({
          exitCode: 1,
          stdout: "",
          stderr: "Gemini CLI fallback is not configured.",
        });
        return;
      }

      this.ensureWorkdir();
      let stdout = "";
      let stderr = "";
      let settled = false;
      let abortCleanup: (() => void) | undefined;
      const child = spawn(this.config.command, this.buildArgs(model, "json"), {
        cwd: this.config.workdir,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const finish = (exitCode: number): void => {
        if (settled) {
          return;
        }
        settled = true;
        abortCleanup?.();
        resolve({
          exitCode,
          stdout,
          stderr,
        });
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        stderr += error.code === "ENOENT"
          ? `Gemini CLI command '${this.config?.command || "gemini"}' was not found.`
          : error.message;
        finish(1);
      });
      child.on("close", (code) => {
        finish(code ?? 1);
      });

      if (signal) {
        const handleAbort = (): void => {
          stderr += "\nGemini CLI request aborted by signal.";
          this.killChildProcess(child);
        };

        if (signal.aborted) {
          handleAbort();
        } else {
          signal.addEventListener("abort", handleAbort, { once: true });
          abortCleanup = () => signal.removeEventListener("abort", handleAbort);
        }
      }

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  private createStreamingResponse(
    prompt: string,
    model: string,
    signal?: AbortSignal,
  ): Response {
    if (!this.config) {
      const failure = buildGeminiCliErrorResponse(
        "",
        "Gemini CLI fallback is not configured.",
      );
      return new Response(JSON.stringify(failure.body), {
        status: failure.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    this.ensureWorkdir();
    const command = this.config.command;
    const workdir = this.config.workdir;
    const requestId = this.deps.randomId();
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let child: ChildProcessWithoutNullStreams | null = null;
        let stdoutBuffer = "";
        let stderrBuffer = "";
        let assistantText = "";
        let sawAssistantChunk = false;
        let closed = false;
        let abortCleanup: (() => void) | undefined;

        const write = (chunk: string): void => {
          controller.enqueue(encoder.encode(chunk));
        };

        const closeStream = (): void => {
          if (closed) {
            return;
          }
          closed = true;
          abortCleanup?.();
          controller.close();
        };

        const failStream = (stdout = "", stderr = ""): void => {
          if (closed) {
            return;
          }
          const failure = buildGeminiCliErrorResponse(stdout, stderr);
          write(`data: ${JSON.stringify(failure.body)}\n\n`);
          write("data: [DONE]\n\n");
          closeStream();
        };

        const finishStream = (usage?: OpenAIUsage): void => {
          if (closed) {
            return;
          }
          const doneChunk = createDoneChunk(requestId, model);
          if (usage) {
            doneChunk.usage = usage;
          }
          write(`data: ${JSON.stringify(doneChunk)}\n\n`);
          write("data: [DONE]\n\n");
          closeStream();
        };

        const processLine = (line: string): void => {
          const trimmed = line.trim();
          if (!trimmed) {
            return;
          }

          let payload: unknown;
          try {
            payload = JSON.parse(trimmed);
          } catch {
            return;
          }

          if (
            payload &&
            typeof payload === "object" &&
            "type" in payload &&
            payload.type === "message" &&
            "role" in payload &&
            payload.role === "assistant" &&
            "content" in payload &&
            typeof payload.content === "string" &&
            payload.content
          ) {
            assistantText += payload.content;
            const chunkPayload = {
              id: `chatcmpl-${requestId}`,
              object: "chat.completion.chunk" as const,
              created: Math.floor(this.deps.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: sawAssistantChunk
                    ? { content: payload.content }
                    : { role: "assistant" as const, content: payload.content },
                  finish_reason: null,
                },
              ],
            };
            sawAssistantChunk = true;
            write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
            return;
          }

          if (
            payload &&
            typeof payload === "object" &&
            "type" in payload &&
            payload.type === "result"
          ) {
            finishStream(readGeminiCliStreamUsage(payload, assistantText));
          }
        };

        const flushBuffer = (flushTail = false): void => {
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = flushTail ? "" : (lines.pop() ?? "");
          for (const line of lines) {
            processLine(line);
          }
          if (flushTail && stdoutBuffer) {
            processLine(stdoutBuffer);
            stdoutBuffer = "";
          }
        };

        try {
          child = spawn(command, this.buildArgs(model, "stream-json"), {
            cwd: workdir,
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (error) {
          failStream(
            "",
            error instanceof Error ? error.message : String(error),
          );
          return;
        }

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBuffer += chunk.toString();
          flushBuffer(false);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBuffer += chunk.toString();
        });
        child.on("error", (error: NodeJS.ErrnoException) => {
          failStream(
            stdoutBuffer,
            stderrBuffer +
              (error.code === "ENOENT"
                ? `Gemini CLI command '${command}' was not found.`
                : error.message),
          );
        });
        child.on("close", (code) => {
          flushBuffer(true);
          if (closed) {
            return;
          }
          if ((code ?? 1) !== 0) {
            failStream(stdoutBuffer, stderrBuffer);
            return;
          }

          finishStream(
            assistantText
              ? {
                  prompt_tokens: 0,
                  completion_tokens: estimateTokens(assistantText),
                  total_tokens: estimateTokens(assistantText),
                }
              : undefined,
          );
        });

        if (signal) {
          const handleAbort = (): void => {
            if (child) {
              this.killChildProcess(child);
            }
          };

          if (signal.aborted) {
            handleAbort();
          } else {
            signal.addEventListener("abort", handleAbort, { once: true });
            abortCleanup = () =>
              signal.removeEventListener("abort", handleAbort);
          }
        }

        child.stdin.write(prompt);
        child.stdin.end();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  getDefaultModel(): string | null {
    return this.config?.model ?? null;
  }

  resolveModel(requestedModel?: string): string | null {
    if (!this.config) {
      return null;
    }

    if (!requestedModel) {
      return this.config.model;
    }

    return this.getSupportedModelMap().get(
      normalizeRequestedModel(requestedModel),
    ) ?? null;
  }

  getPublicInfo(): PublicExternalProviderInfo | null {
    if (!this.config) {
      return null;
    }

    return {
      provider: this.config.provider,
      transport: "local-cli",
      model: this.config.model,
      extraModels: this.config.extraModels,
      streamMode: this.config.streamMode,
      command: this.config.command,
      workdir: this.config.workdir,
    };
  }

  usesSyntheticStreaming(): boolean {
    return this.config?.streamMode !== "passthrough";
  }

  supportsModel(model: string | undefined): boolean {
    if (!this.config || !model) {
      return false;
    }

    return this.getSupportedModelMap().has(normalizeRequestedModel(model));
  }

  getPublicModelList(): OpenAIModel[] {
    const created = Math.floor(this.deps.now() / 1000);
    return this.getSupportedModels().map((model) => ({
      id: model,
      object: "model",
      owned_by: "gemini-cli",
      created,
    }));
  }

  async requestChatCompletion(
    body: Record<string, unknown>,
    model: string,
    options: {
      signal?: AbortSignal;
      stream?: boolean;
    } = {},
  ): Promise<Response> {
    if (!this.config) {
      throw new Error("Gemini CLI fallback is not configured");
    }

    const resolvedModel = this.resolveModel(model) || this.config.model;
    const prompt = buildGeminiCliPrompt(
      ((body as unknown as OpenAIChatRequest).messages) || [],
    );

    if (options.stream && !this.usesSyntheticStreaming()) {
      return this.createStreamingResponse(
        prompt,
        resolvedModel,
        options.signal,
      );
    }

    const result = await this.runGeminiJsonCommand(
      prompt,
      resolvedModel,
      options.signal,
    );
    if (result.exitCode !== 0) {
      const failure = buildGeminiCliErrorResponse(result.stdout, result.stderr);
      return new Response(JSON.stringify(failure.body), {
        status: failure.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const parsed = parseTrailingJson(result.stdout);
    if (!parsed || typeof parsed !== "object") {
      const failure = buildGeminiCliErrorResponse(
        result.stdout,
        result.stderr || "Gemini CLI returned invalid JSON output.",
      );
      return new Response(JSON.stringify(failure.body), {
        status: failure.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const payload = buildGeminiCliChatCompletion(
      parsed,
      resolvedModel,
      this.deps.randomId(),
      this.deps.now(),
    );
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const geminiCliProvider = new GeminiCliProvider();
