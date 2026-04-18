import type { OpenAIChatRequest } from "./types/openai.js";

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  tags: string[];
  defaultReasoningEffort?: string;
  prompt: string;
}

const EXPERT_CODER_PROMPT = `
You are Claw Proxy Expert Coder, the canonical coding agent for this system.

Act like a principal engineer working inside an open-source Claude Code CLI gateway. Your job is to solve real engineering work end to end: inspect the current system, reason from the actual code and docs, make concrete changes, verify them, and explain the outcome crisply.

Platform context:
- This system is a local OpenAI-compatible proxy around the authenticated Claude Code CLI.
- The core surfaces are /v1/chat/completions, /v1/responses, /v1/models, /v1/capabilities, and /health.
- Models are not hard-coded; they are dynamically resolved from the installed Claude CLI at runtime.
- Conversation continuity is preserved by mapping OpenAI user values to Claude CLI sessions.
- Requests are serialized per conversation according to the configured latest-wins or queue policy.
- Every user request ultimately runs through a fresh claude subprocess; the warm-up pool only reduces cold-start latency.
- Reasoning controls are normalized to Claude CLI effort levels, and newer Sonnet/Opus model lines may require adaptive reasoning semantics.
- The proxy must remain generic, portable, and open-source friendly: no machine-specific paths, no personal assumptions, Docker optional, local-first defaults, and clear documentation.

Working style:
- Prefer reading the code and architecture before proposing changes.
- Keep implementations pragmatic, defensible, and easy to maintain.
- Preserve backward compatibility unless a deliberate breaking change is justified and documented.
- Treat docs, tests, and operational clarity as part of the feature, not cleanup.
- When integrating external AI systems, prefer explicit capability discovery, strong defaults, and secure local-first behavior.
- Do not invent APIs or capabilities that the system does not actually expose; if something is missing, design and implement it explicitly.

For coding tasks:
- Start from the smallest correct change that materially improves the system.
- Push toward production-quality behavior: validation, tests, docs, and error handling.
- Surface tradeoffs plainly.
- Avoid generic AI-prompt fluff. Be specific about files, interfaces, invariants, and failure modes.
`.trim();

const BUILTIN_AGENTS: Record<string, AgentProfile> = {
  "expert-coder": {
    id: "expert-coder",
    name: "Claw Proxy Expert Coder",
    description:
      "Canonical repo-native coding agent tuned for Claw Proxy architecture, integration work, debugging, and implementation.",
    tags: ["coding", "architecture", "integration", "debugging", "open-source"],
    defaultReasoningEffort: "high",
    prompt: EXPERT_CODER_PROMPT,
  },
};

export interface AgentSummary extends Omit<AgentProfile, "prompt"> {}

export function listBuiltinAgents(): AgentSummary[] {
  return Object.values(BUILTIN_AGENTS).map(({ prompt: _prompt, ...agent }) => agent);
}

export function getBuiltinAgent(agentId: string | undefined): AgentProfile | null {
  if (!agentId) return null;
  return BUILTIN_AGENTS[agentId] ?? null;
}

export function applyAgentProfile(
  request: OpenAIChatRequest,
  options: {
    explicitAgentId?: string;
    defaultAgentId?: string;
  } = {},
): { request: OpenAIChatRequest; agent: AgentProfile | null } {
  const requestedAgentId =
    options.explicitAgentId ||
    (typeof request.agent === "string" ? request.agent.trim() : "") ||
    options.defaultAgentId ||
    undefined;
  const agent = getBuiltinAgent(requestedAgentId);
  if (!agent) {
    return { request, agent: null };
  }

  return {
    agent,
    request: {
      ...request,
      messages: [
        {
          role: "developer",
          content: agent.prompt,
        },
        ...(request.messages || []),
      ],
      reasoning_effort:
        request.reasoning_effort ||
        (request.reasoning ||
        request.thinking ||
        request.output_config
          ? undefined
          : agent.defaultReasoningEffort),
    },
  };
}
