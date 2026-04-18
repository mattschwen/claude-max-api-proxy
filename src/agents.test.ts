import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAgentProfile,
  getBuiltinAgent,
  listBuiltinAgents,
} from "./agents.js";

test("listBuiltinAgents exposes the built-in expert coding agent", () => {
  const agents = listBuiltinAgents();
  assert.equal(agents.some((agent) => agent.id === "expert-coder"), true);
});

test("getBuiltinAgent returns the canonical expert coding agent", () => {
  const agent = getBuiltinAgent("expert-coder");
  assert.equal(agent?.id, "expert-coder");
  assert.equal(agent?.defaultReasoningEffort, "high");
});

test("applyAgentProfile injects the expert coding developer prompt and default reasoning", () => {
  const applied = applyAgentProfile(
    {
      model: "sonnet",
      messages: [{ role: "user", content: "Fix the bug." }],
      agent: "expert-coder",
    },
    {},
  );

  assert.equal(applied.agent?.id, "expert-coder");
  assert.equal(applied.request.reasoning_effort, "high");
  assert.equal(applied.request.messages[0]?.role, "developer");
  assert.match(
    String(applied.request.messages[0]?.content),
    /Claw Proxy Expert Coder/,
  );
});

test("applyAgentProfile preserves explicit reasoning settings from the caller", () => {
  const applied = applyAgentProfile(
    {
      model: "sonnet",
      messages: [{ role: "user", content: "Fix the bug." }],
      agent: "expert-coder",
      reasoning_effort: "max",
    },
    {},
  );

  assert.equal(applied.request.reasoning_effort, "max");
});
