import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppPaths, findProjectRoot, resolveFromRoot } from "../src/app-paths.js";

test("findProjectRoot discovers package root from a nested directory", () => {
  const temporary = mkdtempSync(join(tmpdir(), "awb-paths-"));
  const root = join(temporary, "项目 with spaces");
  const nested = join(root, "src", "nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ai-weekly-brief" }), "utf8");
  try {
    assert.equal(findProjectRoot(nested), root);
    assert.equal(resolveFromRoot(root, "./data/test.db"), join(root, "data", "test.db"));
    const paths = createAppPaths(root);
    assert.equal(paths.databaseFile, join(root, "data", "weekly.db"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
