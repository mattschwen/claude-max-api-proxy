import assert from "node:assert/strict";
import test from "node:test";
import { runExternalProviderProbeWithTimeout } from "./feature-scanner.js";

test("runExternalProviderProbeWithTimeout aborts and rejects a hung probe", async () => {
  let observedSignal: AbortSignal | undefined;

  await assert.rejects(
    runExternalProviderProbeWithTimeout(
      (signal) => {
        observedSignal = signal;
        return new Promise<never>(() => {
          // Deliberately never settles; the scanner deadline must bound it.
        });
      },
      10,
    ),
    /probe timed out after 10ms/i,
  );

  assert.equal(observedSignal?.aborted, true);
});

test("runExternalProviderProbeWithTimeout returns completed probe results", async () => {
  const result = await runExternalProviderProbeWithTimeout(
    async (signal) => {
      assert.equal(signal.aborted, false);
      return "available";
    },
    100,
  );

  assert.equal(result, "available");
});

test("runExternalProviderProbeWithTimeout propagates scanner shutdown", async () => {
  const lifecycle = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const probe = runExternalProviderProbeWithTimeout(
    (signal) => {
      observedSignal = signal;
      return new Promise<never>(() => {
        // Deliberately waits for lifecycle cancellation.
      });
    },
    1_000,
    lifecycle.signal,
  );

  lifecycle.abort(new Error("scanner shutdown"));

  await assert.rejects(probe, /scanner shutdown/i);
  assert.equal(observedSignal?.aborted, true);
});
