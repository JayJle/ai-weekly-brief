import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backupDatabase, beginRun, getDatabaseStatus, getFormalWeekUsage, getOperationalHealth, getWeekUsage, isWeekDelivered, migrateDatabase, openDatabase, recordRun, recordUsage, recoverInterruptedRuns, resolveUncertainDelivery } from "../src/database.js";

test("database migration is repeatable and run status persists", () => {
  const directory = mkdtempSync(join(tmpdir(), "awb-db-"));
  const databaseFile = join(directory, "nested", "weekly.db");
  try {
    migrateDatabase(databaseFile);
    migrateDatabase(databaseFile);
    recordRun(databaseFile, { id: "run-test", type: "TEST", status: "COMPLETED" });
    const status = getDatabaseStatus(databaseFile);
    assert.equal(status.schemaVersion, 4);
    assert.equal(status.runCount, 1);
    assert.equal(status.lastRunStatus, "COMPLETED");
    recordUsage(databaseFile, {
      weekId: "2026-W33",
      agentType: "MAIN",
      provider: "test",
      model: "test-model",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      costUsd: 0.125,
    });
    const usage = getWeekUsage(databaseFile, "2026-W33");
    assert.equal(usage.totalTokens, 20);
    assert.equal(usage.costUsd, 0.125);
    assert.equal(getFormalWeekUsage(databaseFile, "2026-W33").totalTokens, 0);
    recordUsage(databaseFile, {
      weekId: "2026-W33",
      runId: "formal-run",
      agentType: "RESEARCH",
      provider: "test",
      model: "test-model",
      inputTokens: 2,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
    });
    assert.equal(getFormalWeekUsage(databaseFile, "2026-W33").totalTokens, 3);
    const backup = backupDatabase(databaseFile);
    assert.equal(existsSync(backup), true);

    beginRun(databaseFile, { id: "interrupted-run", type: "MAIN_HEARTBEAT" });
    assert.equal(getOperationalHealth(databaseFile).runningRuns, 1);
    assert.equal(recoverInterruptedRuns(databaseFile), 1);
    assert.equal(getOperationalHealth(databaseFile).runningRuns, 0);

    const sqlite = openDatabase(databaseFile);
    try {
      sqlite.prepare(`
        INSERT INTO weekly_deliveries (
          id, week_id, brief_version, channel, status, created_at
        ) VALUES ('delivery-test', '2026-W33', 1, 'FEISHU', 'UNKNOWN', ?)
      `).run(new Date().toISOString());
    } finally {
      sqlite.close();
    }
    resolveUncertainDelivery(databaseFile, { weekId: "2026-W33", version: 1, resolution: "SENT" });
    assert.equal(isWeekDelivered(databaseFile, "2026-W33"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
