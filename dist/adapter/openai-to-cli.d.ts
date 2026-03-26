import type { OpenAIChatRequest, OpenAIChatMessage } from "../types/openai.js";
export type ClaudeModel = "opus" | "sonnet" | "haiku";
export interface CliInput {
    prompt: string;
    model: ClaudeModel;
    sessionId?: string;
    systemPrompt?: string;
    isResume?: boolean;
    thinkingBudget?: number;
    _conversationId?: string;
    _startTime?: number;
}
/**
 * Extract Claude model alias from request model string.
 */
export declare function extractModel(model: string): ClaudeModel;
/**
 * Extract system messages and non-system messages separately.
 */
export declare function extractSystemAndPrompt(messages: OpenAIChatMessage[]): {
    systemPrompt: string | undefined;
    prompt: string;
};
/**
 * Extract only the last user message for resume mode.
 */
export declare function extractLastUserMessage(messages: OpenAIChatMessage[]): string;
/**
 * Convert OpenAI chat request to CLI input format
 */
export declare function openaiToCli(request: OpenAIChatRequest, isResume?: boolean): CliInput;
//# sourceMappingURL=openai-to-cli.d.ts.map