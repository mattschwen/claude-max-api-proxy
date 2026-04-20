import test from "node:test";
import assert from "node:assert/strict";

test("chat completions keep Claude as the implicit default even when an external provider is configured", async () => {
  const previousGeminiEnabled = process.env.GEMINI_CLI_ENABLED;
  const previousGeminiModel = process.env.GEMINI_CLI_MODEL;

  process.env.GEMINI_CLI_ENABLED = "true";
  process.env.GEMINI_CLI_MODEL = "gemini-2.5-pro";

  try {
    const routes = await import("./routes.js");
    const { modelAvailability } = await import("../model-availability.js");

    const originalGetSnapshot = modelAvailability.getSnapshot.bind(
      modelAvailability,
    );
    try {
      modelAvailability.getSnapshot = async () =>
        ({
          checkedAt: Date.now(),
          auth: { loggedIn: true },
          cli: null,
          available: [],
          unavailable: [
            {
              definition: {
                id: "sonnet",
                family: "sonnet",
                alias: "sonnet",
                timeoutMs: 1,
                stallTimeoutMs: 1,
              },
              error: {
                status: 503,
                type: "server_error",
                code: "no_models_available",
                message: "Claude unavailable",
              },
            },
          ],
        }) as never;

      const req = {
        body: {
          messages: [{ role: "user", content: "hello" }],
        },
        params: {},
        header: () => undefined,
      } as any;

      const result: { statusCode: number; payload: unknown } = {
        statusCode: 200,
        payload: null,
      };

      const res = {
        status(code: number) {
          result.statusCode = code;
          return this;
        },
        json(payload: unknown) {
          result.payload = payload;
          return this;
        },
      } as any;

      await routes.handleChatCompletions(req, res);

      assert.equal(result.statusCode, 503);
      assert.equal((result.payload as any)?.error?.code, "no_models_available");
      assert.match(
        String((result.payload as any)?.error?.message || ""),
        /Claude remains the implicit default/i,
      );
    } finally {
      modelAvailability.getSnapshot = originalGetSnapshot;
    }
  } finally {
    if (previousGeminiEnabled == null) {
      delete process.env.GEMINI_CLI_ENABLED;
    } else {
      process.env.GEMINI_CLI_ENABLED = previousGeminiEnabled;
    }

    if (previousGeminiModel == null) {
      delete process.env.GEMINI_CLI_MODEL;
    } else {
      process.env.GEMINI_CLI_MODEL = previousGeminiModel;
    }
  }
});
