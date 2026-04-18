import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyClaudeError,
  extractClaudeErrorFromMessages,
  extractClaudeErrorFromResult,
  parseAuthStatus,
  parseClaudeJsonOutput,
  parseClaudeVersion,
  supportsAdaptiveReasoningCli,
  supportsXHighEffort,
} from "./claude-cli.inspect.js";
import type { ClaudeCliMessage, ClaudeCliResult } from "./types/claude-cli.js";

test("parseAuthStatus parses valid auth JSON", () => {
  assert.deepEqual(
    parseAuthStatus(
      '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}',
    ),
    {
      loggedIn: true,
      authMethod: "oauth_token",
      apiProvider: "firstParty",
    },
  );
});

test("parseAuthStatus returns null for invalid JSON", () => {
  assert.equal(parseAuthStatus("not json"), null);
});

test("parseClaudeJsonOutput parses array output", () => {
  const messages = parseClaudeJsonOutput(
    '[{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"duration_api_ms":1,"num_turns":1,"result":"OK","session_id":"abc","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1},"modelUsage":{}}]',
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, "result");
});

test("extractClaudeErrorFromMessages classifies model access failures", () => {
  const messages: ClaudeCliMessage[] = [
    {
      type: "assistant",
      error: "invalid_request",
      message: {
        id: "msg_1",
        model: "<synthetic>",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "There's an issue with the selected model (claude-sonnet-4-6). It may not exist or you may not have access to it.",
          },
        ],
        stop_reason: "stop_sequence",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      session_id: "session-1",
      uuid: "uuid-1",
    },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      duration_ms: 1,
      duration_api_ms: 0,
      num_turns: 1,
      result:
        "There's an issue with the selected model (claude-sonnet-4-6). It may not exist or you may not have access to it.",
      session_id: "session-1",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
    },
  ];

  const error = extractClaudeErrorFromMessages(messages);
  assert.ok(error);
  assert.equal(error?.status, 400);
  assert.equal(error?.code, "model_unavailable");
});

test("extractClaudeErrorFromResult ignores successful results", () => {
  const result: ClaudeCliResult = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: "OK",
    session_id: "session-1",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  };

  assert.equal(extractClaudeErrorFromResult(result), null);
});

test("classifyClaudeError maps auth failures", () => {
  const error = classifyClaudeError(
    "Claude CLI is not authenticated. Run: claude auth login",
  );
  assert.equal(error.status, 401);
  assert.equal(error.code, "auth_required");
});

test("classifyClaudeError maps passthrough Anthropic auth payloads", () => {
  const cases = [
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
    "HTTP 401 unauthorized from api.anthropic.com",
    "upstream status: 401",
    '{"error":{"type":"authentication_error"}}',
    "Invalid authentication credentials",
  ];
  for (const msg of cases) {
    const error = classifyClaudeError(msg);
    assert.equal(error.status, 401, `expected 401 for: ${msg}`);
    assert.equal(
      error.code,
      "auth_required",
      `expected auth_required for: ${msg}`,
    );
  }
});

test("parseClaudeVersion extracts semver from Claude CLI output", () => {
  assert.deepEqual(parseClaudeVersion("claude 2.1.112"), {
    major: 2,
    minor: 1,
    patch: 112,
  });
  assert.equal(parseClaudeVersion("Claude Code CLI"), null);
});

test("supportsXHighEffort only enables xhigh on supported CLI versions", () => {
  assert.equal(supportsXHighEffort("claude 2.1.111"), false);
  assert.equal(supportsXHighEffort("claude 2.1.112"), true);
  assert.equal(supportsXHighEffort("claude 2.2.0"), true);
  assert.equal(supportsXHighEffort(undefined), false);
});

test("supportsAdaptiveReasoningCli requires Claude CLI 2.1.111 or newer", () => {
  assert.equal(supportsAdaptiveReasoningCli("claude 2.1.110"), false);
  assert.equal(supportsAdaptiveReasoningCli("claude 2.1.111"), true);
  assert.equal(supportsAdaptiveReasoningCli("claude 2.2.0"), true);
  assert.equal(supportsAdaptiveReasoningCli(undefined), false);
});
