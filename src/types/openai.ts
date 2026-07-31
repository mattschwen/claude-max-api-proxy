/**
 * Types for OpenAI-compatible API
 * Used for Clawdbot integration
 */

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "developer";
  content: string | Array<{ type?: string; text?: string } | string>;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  agent?: string;
  stream?: boolean;
  /**
   * Proxy-specific stable thread identifier. Prefer this over `user`, whose
   * OpenAI meaning is an end-user identifier rather than a conversation.
   */
  conversation_id?: string;
  /**
   * Proxy-specific override for same-conversation admission behavior.
   */
  conversation_policy?: "interrupt" | "queue";
  metadata?: Record<string, unknown>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  user?: string;
  thinking?: {
    type?: string;
    budget_tokens?: number;
    effort?: string;
    output_config?: {
      effort?: string;
    };
  };
  reasoning?: {
    mode?: "off" | "fixed" | "adaptive";
    effort?: string;
    budget_tokens?: number;
    max_budget_tokens?: number;
  };
  reasoning_effort?: string;
  output_config?: {
    effort?: string;
  };
}

export interface OpenAIChatResponseChoice {
  index: number;
  message: {
    role: "assistant";
    content: string;
  };
  finish_reason: "stop" | "length" | "content_filter" | null;
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatResponseChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIChatChunkDelta {
  role?: "assistant";
  content?: string;
}

export interface OpenAIChatChunkChoice {
  index: number;
  delta: OpenAIChatChunkDelta;
  finish_reason: "stop" | "length" | "content_filter" | null;
}

export interface OpenAIChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChatChunkChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIModel {
  id: string;
  object: "model";
  owned_by: string;
  created?: number;
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}
