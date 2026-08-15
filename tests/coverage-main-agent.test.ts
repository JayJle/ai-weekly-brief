import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runMainHeartbeat } from "../src/agent/main-agent.js";
import { createAppPaths } from "../src/app-paths.js";
import type { AppConfig } from "../src/config.js";
import { getCoverageReport, seedSourceRegistry } from "../src/coverage/coverage-service.js";
import { getDatabaseStatus, migrateDatabase } from "../src/database.js";

function mockConfig(projectRoot: string): AppConfig {
  const paths = createAppPaths(projectRoot, {
    dataDir: join(projectRoot, "data"),
    databasePath: join(projectRoot, "data", "weekly.db"),
  });
  return {
    paths,
    modelProvider: "mock",
    modelMain: "mock-main",
    modelResearch: "mock-research",
    searchProvider: "mock",
    timezone: "Asia/Shanghai",
    runMode: "DRY_RUN",
    weeklyBudgetUsd: 10,
    heartbeatTimes: ["08:00", "20:00"],
    publishWeekday: 1,
    publishTime: "08:30",
    logLevel: "info",
  };
}

test("coverage registry spans regions and a mock heartbeat scans, researches and persists", async () => {
  const directory = mkdtempSync(join(tmpdir(), "awb-main-"));
  try {
    const config = mockConfig(directory);
    migrateDatabase(config.paths.databaseFile);
    seedSourceRegistry(config.paths.databaseFile);
    const before = getCoverageReport(config.paths.databaseFile);
    assert.ok(before.totalEnabled >= 15);
    assert.ok(before.byRegion.US);
    assert.ok(before.byRegion.CHINA);
    assert.ok(before.byRegion.EU);
    assert.ok(before.byRegion.GLOBAL);

    const result = await runMainHeartbeat(config);
    assert.equal(result.mode, "mock");
    assert.match(result.actions.join(" "), /coverage_scan/u);
    assert.equal(getCoverageReport(config.paths.databaseFile).scanned, 1);
    const database = getDatabaseStatus(config.paths.databaseFile);
    assert.equal(database.runCount, 1);
    assert.equal(database.eventCount, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
