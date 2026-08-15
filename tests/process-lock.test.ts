import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireProcessLock } from "../src/runtime/process-lock.js";

test("process lock rejects a second live process and can be reacquired after release", () => {
  const directory = mkdtempSync(join(tmpdir(), "awb-lock-"));
  const lockFile = join(directory, "app.lock");
  try {
    const release = acquireProcessLock(lockFile);
    assert.throws(() => acquireProcessLock(lockFile), /已经在运行/u);
    release();
    const releaseAgain = acquireProcessLock(lockFile);
    releaseAgain();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
