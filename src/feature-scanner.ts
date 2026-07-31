import {
  getExternalProviderAvailability,
  probeConfiguredExternalProviders,
} from "./external-providers.js";
import { log, logError } from "./logger.js";
import { modelAvailability } from "./model-availability.js";

const DEFAULT_SCAN_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_EXTERNAL_PROBE_TIMEOUT_MS = 30 * 1000;

let scanPromise: Promise<FeatureScanSnapshot> | null = null;
let scanTimer: ReturnType<typeof setInterval> | null = null;
let lastScan: FeatureScanSnapshot | null = null;
let activeScanController: AbortController | null = null;

export interface FeatureScanSnapshot {
  checkedAt: number;
  claude: {
    availableModels: string[];
    unavailableModels: string[];
    cliVersion?: string;
  };
  externalProviders: ReturnType<typeof getExternalProviderAvailability>;
}

export async function runExternalProviderProbeWithTimeout<T>(
  probe: (signal: AbortSignal) => Promise<T>,
  timeoutMs = DEFAULT_EXTERNAL_PROBE_TIMEOUT_MS,
  lifecycleSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const boundedTimeoutMs = Math.max(1, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeLifecycleAbortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `External provider probe timed out after ${boundedTimeoutMs}ms`,
      );
      controller.abort(error);
      reject(error);
    }, boundedTimeoutMs);
  });
  const lifecycleAbort = new Promise<never>((_resolve, reject) => {
    if (!lifecycleSignal) return;
    const abort = (): void => {
      const reason = lifecycleSignal.reason instanceof Error
        ? lifecycleSignal.reason
        : new Error("Feature scanner stopped");
      controller.abort(reason);
      reject(reason);
    };
    if (lifecycleSignal.aborted) {
      abort();
      return;
    }
    lifecycleSignal.addEventListener("abort", abort, { once: true });
    removeLifecycleAbortListener = () =>
      lifecycleSignal.removeEventListener("abort", abort);
  });

  try {
    return await Promise.race([
      probe(controller.signal),
      timeout,
      lifecycleAbort,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    removeLifecycleAbortListener?.();
  }
}

export async function scanAvailableFeatures(): Promise<FeatureScanSnapshot> {
  if (scanPromise) return scanPromise;
  const scanController = new AbortController();
  activeScanController = scanController;
  scanPromise = (async () => {
    const [claudeResult] = await Promise.allSettled([
      modelAvailability.getSnapshot(true),
      runExternalProviderProbeWithTimeout(
        (signal) => probeConfiguredExternalProviders({ signal }),
        DEFAULT_EXTERNAL_PROBE_TIMEOUT_MS,
        scanController.signal,
      ),
    ]);
    const claude =
      claudeResult.status === "fulfilled"
        ? {
            availableModels: claudeResult.value.available.map(
              (model) => model.id,
            ),
            unavailableModels: claudeResult.value.unavailable.map(
              (entry) => entry.definition.id,
            ),
            cliVersion: claudeResult.value.cli?.version,
          }
        : {
            availableModels: [],
            unavailableModels: [],
          };
    lastScan = {
      checkedAt: Date.now(),
      claude,
      externalProviders: getExternalProviderAvailability(),
    };
    log("model.probe", {
      source: "feature_scanner",
      availableModels: claude.availableModels.length,
      externalProviders: lastScan.externalProviders.length,
    });
    return lastScan;
  })();
  try {
    return await scanPromise;
  } catch (error) {
    logError("request.error", error, { source: "feature_scanner" });
    throw error;
  } finally {
    scanPromise = null;
    if (activeScanController === scanController) {
      activeScanController = null;
    }
  }
}

export function getLastFeatureScan(): FeatureScanSnapshot | null {
  return lastScan;
}

export function startFeatureScanner(
  intervalMs = DEFAULT_SCAN_INTERVAL_MS,
): void {
  if (scanTimer) return;
  void scanAvailableFeatures().catch(() => {
    /* the cached availability payload carries the actionable provider errors */
  });
  scanTimer = setInterval(() => {
    void scanAvailableFeatures().catch(() => {
      /* keep the last known-good scan and retry on the next interval */
    });
  }, intervalMs);
  scanTimer.unref?.();
}

export function stopFeatureScanner(): void {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  activeScanController?.abort(new Error("Feature scanner stopped"));
}
