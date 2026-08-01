import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";
import { CleanupSet, safeEnd, safeWrite } from "./chat-execution.js";

interface FakeRes {
  writableEnded: boolean;
  destroyed: boolean;
  written: string[];
  endCalls: number;
  writeImpl?: () => boolean;
  endImpl?: () => void;
  write(data: string): boolean;
  end(): void;
}

function makeRes(overrides: Partial<FakeRes> = {}): FakeRes {
  const res: FakeRes = {
    writableEnded: false,
    destroyed: false,
    written: [],
    endCalls: 0,
    write(data: string): boolean {
      if (this.writeImpl) return this.writeImpl();
      this.written.push(data);
      return true;
    },
    end(): void {
      if (this.endImpl) {
        this.endImpl();
        return;
      }
      this.endCalls++;
      this.writableEnded = true;
    },
    ...overrides,
  };
  return res;
}

function errWithCode(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

test("safeWrite writes when stream is open", () => {
  const res = makeRes();
  const ok = safeWrite(res as unknown as Response, "hello");
  assert.equal(ok, true);
  assert.deepEqual(res.written, ["hello"]);
});

test("safeWrite returns false without throwing when writableEnded", () => {
  const res = makeRes({ writableEnded: true });
  const ok = safeWrite(res as unknown as Response, "hello");
  assert.equal(ok, false);
  assert.deepEqual(res.written, []);
});

test("safeWrite returns false without throwing when destroyed", () => {
  const res = makeRes({ destroyed: true });
  const ok = safeWrite(res as unknown as Response, "hello");
  assert.equal(ok, false);
});

for (const code of [
  "ERR_STREAM_WRITE_AFTER_END",
  "ERR_STREAM_DESTROYED",
  "EPIPE",
]) {
  test(`safeWrite swallows ${code} thrown from res.write`, () => {
    const res = makeRes({
      writeImpl: () => {
        throw errWithCode(code);
      },
    });
    const ok = safeWrite(res as unknown as Response, "hello");
    assert.equal(ok, false);
  });
}

test("safeWrite rethrows unexpected errors", () => {
  const res = makeRes({
    writeImpl: () => {
      throw new Error("boom");
    },
  });
  assert.throws(
    () => safeWrite(res as unknown as Response, "hello"),
    /boom/,
  );
});

test("safeEnd ends the response when open", () => {
  const res = makeRes();
  safeEnd(res as unknown as Response);
  assert.equal(res.endCalls, 1);
  assert.equal(res.writableEnded, true);
});

test("safeEnd is a no-op when writableEnded", () => {
  const res = makeRes({ writableEnded: true });
  safeEnd(res as unknown as Response);
  assert.equal(res.endCalls, 0);
});

for (const code of [
  "ERR_STREAM_WRITE_AFTER_END",
  "ERR_STREAM_DESTROYED",
  "EPIPE",
]) {
  test(`safeEnd swallows ${code} thrown from res.end`, () => {
    const res = makeRes({
      endImpl: () => {
        throw errWithCode(code);
      },
    });
    assert.doesNotThrow(() => safeEnd(res as unknown as Response));
  });
}

test("safeEnd rethrows unexpected errors", () => {
  const res = makeRes({
    endImpl: () => {
      throw new Error("boom");
    },
  });
  assert.throws(() => safeEnd(res as unknown as Response), /boom/);
});

test("CleanupSet runs all functions exactly once", () => {
  const set = new CleanupSet();
  const calls: string[] = [];
  set.add(() => calls.push("a"));
  set.add(() => calls.push("b"));
  set.runAll();
  set.runAll();
  assert.deepEqual(calls, ["a", "b"]);
});

test("CleanupSet keeps running after a fn throws", () => {
  const set = new CleanupSet();
  const calls: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    set.add(() => {
      throw new Error("first fails");
    });
    set.add(() => calls.push("second"));
    set.runAll();
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  assert.deepEqual(calls, ["second"]);
});

test("CleanupSet.add after runAll is ignored", () => {
  const set = new CleanupSet();
  let late = 0;
  set.runAll();
  set.add(() => {
    late++;
  });
  set.runAll();
  assert.equal(late, 0);
});
