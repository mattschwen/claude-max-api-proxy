export interface EscalatedStopHandle {
  requestStop: () => void;
  settle: () => void;
}

interface StoppableProcess {
  exitCode: number | null;
  kill(signal?: number | NodeJS.Signals): boolean;
  once(event: "close", listener: () => void): this;
}

/**
 * Request a polite stop first, escalate to SIGKILL after `killGraceMs`,
 * and release the caller even if the runtime never delivers `close`.
 */
export function createEscalatedStop(
  proc: StoppableProcess,
  onSettled: () => void,
  killGraceMs = 5000,
  forceReleaseMs = 1000,
): EscalatedStopHandle {
  let stopRequested = false;
  let settled = false;
  let escalationTimer: ReturnType<typeof setTimeout> | null = null;
  let forceReleaseTimer: ReturnType<typeof setTimeout> | null = null;

  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (escalationTimer) clearTimeout(escalationTimer);
    if (forceReleaseTimer) clearTimeout(forceReleaseTimer);
    onSettled();
  };

  proc.once("close", settle);

  return {
    requestStop(): void {
      if (stopRequested) return;
      stopRequested = true;

      try {
        proc.kill("SIGTERM");
      } catch {
        settle();
        return;
      }

      escalationTimer = setTimeout(() => {
        if (proc.exitCode === null) {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          forceReleaseTimer = setTimeout(settle, forceReleaseMs);
          return;
        }
        settle();
      }, killGraceMs);
    },
    settle,
  };
}
