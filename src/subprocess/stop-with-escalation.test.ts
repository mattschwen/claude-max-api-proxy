import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createEscalatedStop } from "./stop-with-escalation.js";

class FakeProcess extends EventEmitter {
  exitCode: number | null = null;
  readonly kills: Array<string | number | undefined> = [];

  kill(signal?: number | NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }
}

test("createEscalatedStop escalates to SIGKILL and force releases if close never arrives", async () => {
  const proc = new FakeProcess();
  let settled = 0;
  const stopper = createEscalatedStop(proc, () => {
    settled++;
  }, 10, 5);

  stopper.requestStop();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(proc.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(settled, 1);
});

test("createEscalatedStop settles once when the process closes after SIGTERM", async () => {
  const proc = new FakeProcess();
  let settled = 0;
  const stopper = createEscalatedStop(proc, () => {
    settled++;
  }, 20, 20);

  stopper.requestStop();
  proc.exitCode = 0;
  proc.emit("close", 0);

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(proc.kills, ["SIGTERM"]);
  assert.equal(settled, 1);
});
