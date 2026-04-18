/**
 * Converts Claude CLI output to OpenAI-compatible response format
 * Phase 5c: Token validation and streaming token estimates
 */
import { normalizeModelName } from "../models.js";
import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIChatResponse, OpenAIChatChunk } from "../types/openai.js";

/**
 * Rough token estimate: ~1 token per 4 characters for English text.
 * Phase 5c: Used for streaming token estimates and validation.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message: ClaudeCliAssistant): string {
  return message.message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(message: ClaudeCliAssistant, requestId: string, isFirst = false): OpenAIChatChunk {
  const text = extractTextContent(message);
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(message.message.model),
    choices: [
      {
        index: 0,
        delta: {
          role: isFirst ? "assistant" : undefined,
          content: text,
        },
        finish_reason: message.message.stop_reason ? "stop" : null,
      },
    ],
  };
}

/**
 * Create a final "done" chunk for streaming
 * Phase 5c: Extended to support optional usage data in done chunk
 */
export interface OpenAIChatChunkWithUsage extends OpenAIChatChunk {
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function createDoneChunk(requestId: string, model: string): OpenAIChatChunkWithUsage {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(model),
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
}

/**
 * Validate token counts against actual content.
 * Phase 5c: Ensures token counts are reasonable (at least some tokens if content exists).
 */
export function validateTokens(
  promptTokens: number,
  completionTokens: number,
  contentLength: number,
): { valid: boolean; reason?: string } {
  if (contentLength === 0 && completionTokens > 0) {
    return { valid: false, reason: "Non-zero completion tokens but empty content" };
  }
  if (completionTokens === 0 && contentLength > 0) {
    return { valid: false, reason: "Content present but zero completion tokens" };
  }
  if (promptTokens < 0 || completionTokens < 0) {
    return { valid: false, reason: "Negative token counts" };
  }
  return { valid: true };
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export function cliResultToOpenai(
  result: ClaudeCliResult,
  requestId: string,
  fallbackModel = "sonnet",
): OpenAIChatResponse {
  const modelName = Object.keys(result.modelUsage || {})[0] || fallbackModel;

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(modelName),
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.result,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: result.usage?.input_tokens || 0,
      completion_tokens: result.usage?.output_tokens || 0,
      total_tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
    },
  };
}
