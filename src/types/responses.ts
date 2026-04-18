export interface ResponsesInputTextPart {
  type?: "input_text" | "text";
  text: string;
}

export interface ResponsesInputMessage {
  type?: "message";
  role?: "system" | "developer" | "user" | "assistant";
  content:
    | string
    | Array<ResponsesInputTextPart | string | { type?: string; text?: string }>;
}

export type ResponsesInputItem =
  | string
  | ResponsesInputTextPart
  | ResponsesInputMessage;

export interface OpenAIResponsesRequest {
  model?: string;
  input: ResponsesInputItem | ResponsesInputItem[];
  stream?: boolean;
  user?: string;
  instructions?: string;
  previous_response_id?: string;
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
  thinking?: {
    type?: string;
    budget_tokens?: number;
    effort?: string;
    output_config?: {
      effort?: string;
    };
  };
}

export interface OpenAIResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed";
  model: string;
  output: Array<{
    id: string;
    type: "message";
    status: "completed";
    role: "assistant";
    content: Array<{
      type: "output_text";
      text: string;
      annotations: unknown[];
    }>;
  }>;
  output_text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  previous_response_id?: string | null;
}
