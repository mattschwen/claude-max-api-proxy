import type { OpenAIChatMessage, OpenAIChatRequest } from "../types/openai.js";
import type { ConversationMessageRecord } from "../store/conversation.js";

function flattenContent(content: OpenAIChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function messageKey(message: {
  role: string;
  content: OpenAIChatMessage["content"] | string;
}): string {
  return `${message.role}\u0000${flattenContent(
    message.content as OpenAIChatMessage["content"],
  )}`;
}

function matchingSuffixLength(
  committed: OpenAIChatMessage[],
  requested: OpenAIChatMessage[],
): number {
  const maximum = Math.min(committed.length, requested.length);
  for (let length = maximum; length > 0; length -= 1) {
    const committedStart = committed.length - length;
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      if (
        messageKey(committed[committedStart + index]) !==
          messageKey(requested[index])
      ) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

/**
 * Rebuild a stateless/fresh provider request from the committed transcript.
 *
 * OpenAI clients vary: some resend the full history, while thread-oriented
 * clients send only the newest message. This keeps the full-history case
 * unchanged and prepends only the missing committed prefix for incremental or
 * truncated requests.
 */
export function mergeCommittedConversationMessages(
  request: OpenAIChatRequest & Record<string, unknown>,
  committedRecords: ConversationMessageRecord[],
): OpenAIChatRequest & Record<string, unknown> {
  const committed = committedRecords
    .filter((message) =>
      ["system", "developer", "user", "assistant"].includes(message.role)
    )
    .map((message) => ({
      role: message.role as OpenAIChatMessage["role"],
      content: message.content,
    }));
  if (committed.length === 0) return request;

  const requested = request.messages.map((message) => ({ ...message }));
  let overlap = matchingSuffixLength(committed, requested);
  let leadingInstructions: OpenAIChatMessage[] = [];
  let requestedConversation = requested;

  if (overlap === 0) {
    const firstConversationIndex = requested.findIndex(
      (message) => message.role !== "system" && message.role !== "developer",
    );
    if (firstConversationIndex > 0) {
      leadingInstructions = requested.slice(0, firstConversationIndex);
      requestedConversation = requested.slice(firstConversationIndex);
      overlap = matchingSuffixLength(committed, requestedConversation);
    }
  }

  return {
    ...request,
    messages: [
      ...leadingInstructions,
      ...committed.slice(0, committed.length - overlap),
      ...requestedConversation,
    ],
  };
}
