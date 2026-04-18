import type {
  OpenAIChatMessage,
  OpenAIChatRequest,
  OpenAIChatResponse,
} from "../types/openai.js";
import type {
  OpenAIResponsesRequest,
  OpenAIResponsesResponse,
  ResponsesInputItem,
} from "../types/responses.js";

function flattenContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        return typeof part.text === "string" ? part.text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeInputs(
  input: OpenAIResponsesRequest["input"],
): ResponsesInputItem[] {
  return Array.isArray(input) ? input : [input];
}

function itemToMessage(item: ResponsesInputItem): OpenAIChatMessage | null {
  if (typeof item === "string") {
    return { role: "user", content: item };
  }
  if (!item || typeof item !== "object") {
    return null;
  }
  if ("role" in item || item.type === "message") {
    const role = item.role || "user";
    return {
      role,
      content: flattenContent(item.content),
    };
  }
  if ("text" in item && typeof item.text === "string") {
    return {
      role: "user",
      content: item.text,
    };
  }
  return null;
}

export function responsesToChatRequest(
  request: OpenAIResponsesRequest,
  conversationId?: string,
): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = [];

  if (request.instructions?.trim()) {
    messages.push({
      role: "developer",
      content: request.instructions.trim(),
    });
  }

  for (const item of normalizeInputs(request.input)) {
    const message = itemToMessage(item);
    if (message) {
      messages.push(message);
    }
  }

  return {
    model: request.model || "sonnet",
    messages,
    stream: false,
    user: conversationId || request.user,
    thinking: request.thinking,
    reasoning: request.reasoning,
    reasoning_effort: request.reasoning_effort,
    output_config: request.output_config,
  };
}

export function chatToResponsesResponse(
  response: OpenAIChatResponse,
  options: {
    responseId: string;
    previousResponseId?: string;
  },
): OpenAIResponsesResponse {
  const outputText = response.choices[0]?.message.content || "";
  return {
    id: options.responseId,
    object: "response",
    created_at: response.created,
    status: "completed",
    model: response.model,
    output: [
      {
        id: `msg_${options.responseId}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: outputText,
            annotations: [],
          },
        ],
      },
    ],
    output_text: outputText,
    usage: {
      input_tokens: response.usage.prompt_tokens,
      output_tokens: response.usage.completion_tokens,
      total_tokens: response.usage.total_tokens,
    },
    previous_response_id: options.previousResponseId ?? null,
  };
}
