/**
 * Converts OpenAI chat request format to Claude CLI input
 */
import { resolveModel } from "../models.js";
/**
 * Extract Claude model alias from request model string.
 */
export function extractModel(model) {
    return (resolveModel(model) ?? "sonnet");
}
/**
 * Flatten content to a string. Handles both string content and
 * OpenAI multi-part content arrays [{type: "text", text: "..."}].
 */
function flattenContent(content) {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => {
            if (typeof part === "string")
                return part;
            if (part && typeof part === "object" && "text" in part && part.text)
                return part.text;
            return "";
        })
            .filter(Boolean)
            .join("\n");
    }
    return String(content || "");
}
/**
 * Extract system messages and non-system messages separately.
 */
export function extractSystemAndPrompt(messages) {
    const systemParts = [];
    const promptParts = [];
    for (const msg of messages) {
        const text = flattenContent(msg.content);
        switch (msg.role) {
            case "system":
            case "developer":
                systemParts.push(text);
                break;
            case "user":
                promptParts.push(text);
                break;
            case "assistant":
                promptParts.push(`<previous_response>\n${text}\n</previous_response>\n`);
                break;
        }
    }
    return {
        systemPrompt: systemParts.join("\n\n") || undefined,
        prompt: promptParts.join("\n").trim(),
    };
}
/**
 * Extract only the last user message for resume mode.
 */
export function extractLastUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
            return flattenContent(messages[i].content);
        }
    }
    return "";
}
/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request, isResume = false) {
    if (isResume) {
        return {
            prompt: extractLastUserMessage(request.messages),
            systemPrompt: undefined,
            model: extractModel(request.model),
            sessionId: request.user,
            isResume: true,
        };
    }
    const { systemPrompt, prompt } = extractSystemAndPrompt(request.messages);
    return {
        prompt,
        systemPrompt,
        model: extractModel(request.model),
        sessionId: request.user,
        isResume: false,
    };
}
//# sourceMappingURL=openai-to-cli.js.map