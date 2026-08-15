import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

function removeStaleLock(lockFile: string): boolean {
  try {
    const pid = Number(readFileSync(lockFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && processExists(pid)) return false;
    unlinkSync(lockFile);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    return false;
  }
}

export function acquireProcessLock(lockFile: string): () => void {
  let descriptor: number;
  try {
    descriptor = openSync(lockFile, "wx");
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code !== "EEXIST" || !removeStaleLock(lockFile)) {
      throw new Error(`项目已经在运行，或锁文件不可用：${lockFile}`);
    }
    descriptor = openSync(lockFile, "wx");
  }
  writeFileSync(descriptor, String(process.pid), "utf8");
  closeSync(descriptor);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const owner = Number(readFileSync(lockFile, "utf8").trim());
      if (owner === process.pid) unlinkSync(lockFile);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
        throw error;
      }
    }
  };
}
