/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */
import { normalizeModelName } from "../models.js";
/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message) {
    return message.message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
}
/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(message, requestId, isFirst = false) {
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
 */
export function createDoneChunk(requestId, model) {
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
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export function cliResultToOpenai(result, requestId) {
    const modelName = result.modelUsage
        ? Object.keys(result.modelUsage)[0]
        : "claude-sonnet-4";
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
//# sourceMappingURL=cli-to-openai.js.map