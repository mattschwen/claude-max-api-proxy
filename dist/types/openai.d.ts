/**
 * Types for OpenAI-compatible API
 * Used for Clawdbot integration
 */
export interface OpenAIChatMessage {
    role: "system" | "user" | "assistant" | "developer";
    content: string | Array<{
        type?: string;
        text?: string;
    } | string>;
}
export interface OpenAIChatRequest {
    model: string;
    messages: OpenAIChatMessage[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    user?: string;
    thinking?: {
        type?: string;
        budget_tokens?: number;
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
//# sourceMappingURL=openai.d.ts.map