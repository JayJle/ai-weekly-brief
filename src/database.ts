import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DatabaseStatus {
  schemaVersion: number;
  runCount: number;
  eventCount: number;
  lastRunAt?: string;
  lastRunStatus?: string;
  deliveryCount: number;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface OperationalHealth {
  consecutiveHeartbeatFailures: number;
  runningRuns: number;
  uncertainDeliveries: number;
  lastHeartbeatAt?: string;
}

export function openDatabase(databaseFile: string): DatabaseSync {
  mkdirSync(dirname(databaseFile), { recursive: true });
  const database = new DatabaseSync(databaseFile);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  return database;
}

export function migrateDatabase(databaseFile: string): void {
  const database = openDatabase(databaseFile);
  try {
    database.exec(`
      BEGIN;

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_runs (
        id TEXT PRIMARY KEY,
        run_type TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        summary TEXT
      );

      CREATE TABLE IF NOT EXISTS weekly_deliveries (
        id TEXT PRIMARY KEY,
        week_id TEXT NOT NULL,
        brief_version INTEGER NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_message_id TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        UNIQUE (week_id, brief_version, channel)
      );

      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        week_id TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        why_it_matters TEXT NOT NULL,
        subjects_json TEXT NOT NULL,
        action TEXT NOT NULL,
        objects_json TEXT NOT NULL,
        occurred_at TEXT,
        announced_at TEXT,
        scores_json TEXT NOT NULL,
        evidence_level TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_checked_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_week_status_idx
      ON events (week_id, status);

      CREATE TABLE IF NOT EXISTS event_sources (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        publisher TEXT NOT NULL,
        url TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        source_type TEXT NOT NULL,
        trust_tier INTEGER NOT NULL,
        published_at TEXT,
        content_hash TEXT,
        lineage_key TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (event_id, canonical_url)
      );

      CREATE TABLE IF NOT EXISTS event_facts (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        fact_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        source_ids_json TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_relations (
        event_a_id TEXT NOT NULL REFERENCES events(id),
        event_b_id TEXT NOT NULL REFERENCES events(id),
        relation TEXT NOT NULL,
        confidence REAL NOT NULL,
        reason TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (event_a_id, event_b_id)
      );

      CREATE TABLE IF NOT EXISTS research_tasks (
        id TEXT PRIMARY KEY,
        candidate_event_id TEXT,
        question TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS source_registry (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        region TEXT NOT NULL,
        topics_json TEXT NOT NULL,
        priority TEXT NOT NULL,
        scan_mode TEXT NOT NULL,
        scan_target TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_successful_scan_at TEXT
      );

      CREATE TABLE IF NOT EXISTS source_scan_runs (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES source_registry(id),
        status TEXT NOT NULL,
        result_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS briefs (
        id TEXT PRIMARY KEY,
        week_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        markdown TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finalized_at TEXT,
        UNIQUE (week_id, version)
      );

      CREATE TABLE IF NOT EXISTS usage_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week_id TEXT NOT NULL,
        run_id TEXT,
        agent_type TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS usage_records_week_idx
      ON usage_records (week_id, created_at);

      INSERT OR IGNORE INTO schema_migrations (version, applied_at)
      VALUES (1, datetime('now'));

      INSERT OR IGNORE INTO schema_migrations (version, applied_at)
      VALUES (2, datetime('now'));

      INSERT OR IGNORE INTO schema_migrations (version, applied_at)
      VALUES (3, datetime('now'));

      INSERT OR IGNORE INTO schema_migrations (version, applied_at)
      VALUES (4, datetime('now'));

      COMMIT;
    `);
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // The transaction may already have been rolled back by SQLite.
    }
    throw error;
  } finally {
    database.close();
  }
}

export function recordUsage(
  databaseFile: string,
  input: {
    weekId: string;
    runId?: string;
    agentType: "MAIN" | "RESEARCH";
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  },
): void {
  const database = openDatabase(databaseFile);
  try {
    database.prepare(`
      INSERT INTO usage_records (
        week_id, run_id, agent_type, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.weekId,
      input.runId ?? null,
      input.agentType,
      input.provider,
      input.model,
      input.inputTokens,
      input.outputTokens,
      input.cacheReadTokens,
      input.cacheWriteTokens,
      input.costUsd,
      new Date().toISOString(),
    );
  } finally {
    database.close();
  }
}

export function getWeekUsage(databaseFile: string, weekId: string): UsageSummary {
  return getUsage(databaseFile, weekId, false);
}

export function getFormalWeekUsage(databaseFile: string, weekId: string): UsageSummary {
  return getUsage(databaseFile, weekId, true);
}

function getUsage(databaseFile: string, weekId: string, formalRunsOnly: boolean): UsageSummary {
  const database = openDatabase(databaseFile);
  try {
    const row = database.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM usage_records
      WHERE week_id = ?${formalRunsOnly ? " AND run_id IS NOT NULL" : ""}
    `).get(weekId) as Record<string, number>;
    const inputTokens = Number(row.input_tokens);
    const outputTokens = Number(row.output_tokens);
    const cacheReadTokens = Number(row.cache_read_tokens);
    const cacheWriteTokens = Number(row.cache_write_tokens);
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      costUsd: Number(row.cost_usd),
    };
  } finally {
    database.close();
  }
}

export function listRecentRuns(databaseFile: string, limit = 20): Array<Record<string, unknown>> {
  const database = openDatabase(databaseFile);
  try {
    return database.prepare(`
      SELECT id, run_type, status, started_at, finished_at, summary
      FROM app_runs ORDER BY started_at DESC LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 100)) as Array<Record<string, unknown>>;
  } finally {
    database.close();
  }
}

export function isWeekDelivered(databaseFile: string, weekId: string): boolean {
  const database = openDatabase(databaseFile);
  try {
    const row = database.prepare(`
      SELECT 1 AS delivered FROM weekly_deliveries
      WHERE week_id = ? AND channel = 'FEISHU' AND status = 'SENT'
      LIMIT 1
    `).get(weekId) as { delivered: number } | undefined;
    return row?.delivered === 1;
  } finally {
    database.close();
  }
}

export function resolveUncertainDelivery(
  databaseFile: string,
  input: { weekId: string; version: number; resolution: "SENT" | "RETRY" },
): void {
  const database = openDatabase(databaseFile);
  try {
    const row = database.prepare(`
      SELECT id, status FROM weekly_deliveries
      WHERE week_id = ? AND brief_version = ? AND channel = 'FEISHU'
    `).get(input.weekId, input.version) as { id: string; status: string } | undefined;
    if (!row) throw new Error("找不到对应的飞书发送记录");
    if (!(row.status === "UNKNOWN" || row.status === "SENDING")) {
      throw new Error(`只有 UNKNOWN/SENDING 记录可以人工处理，当前状态：${row.status}`);
    }
    if (input.resolution === "SENT") {
      database.prepare(`
        UPDATE weekly_deliveries SET status = 'SENT', sent_at = COALESCE(sent_at, ?) WHERE id = ?
      `).run(new Date().toISOString(), row.id);
    } else {
      database.prepare("DELETE FROM weekly_deliveries WHERE id = ?").run(row.id);
    }
  } finally {
    database.close();
  }
}

export function getOperationalHealth(databaseFile: string): OperationalHealth {
  const database = openDatabase(databaseFile);
  try {
    const recent = database.prepare(`
      SELECT status, started_at FROM app_runs
      WHERE run_type = 'MAIN_HEARTBEAT'
      ORDER BY started_at DESC LIMIT 20
    `).all() as Array<{ status: string; started_at: string }>;
    let consecutiveHeartbeatFailures = 0;
    for (const row of recent) {
      if (row.status !== "FAILED") break;
      consecutiveHeartbeatFailures += 1;
    }
    const running = database.prepare("SELECT COUNT(*) AS count FROM app_runs WHERE status = 'RUNNING'").get() as { count: number };
    const uncertain = database.prepare(`
      SELECT COUNT(*) AS count FROM weekly_deliveries WHERE status IN ('SENDING', 'UNKNOWN')
    `).get() as { count: number };
    return {
      consecutiveHeartbeatFailures,
      runningRuns: Number(running.count),
      uncertainDeliveries: Number(uncertain.count),
      ...(recent[0]?.started_at ? { lastHeartbeatAt: recent[0].started_at } : {}),
    };
  } finally {
    database.close();
  }
}

export function claimAlert(databaseFile: string, key: string, cooldownHours = 24): boolean {
  const database = openDatabase(databaseFile);
  try {
    const metadataKey = `alert:${key}`;
    const existing = database.prepare("SELECT value FROM app_metadata WHERE key = ?").get(metadataKey) as { value: string } | undefined;
    const now = Date.now();
    if (existing && now - Date.parse(existing.value) < cooldownHours * 3_600_000) return false;
    const timestamp = new Date(now).toISOString();
    database.prepare(`
      INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(metadataKey, timestamp, timestamp);
    return true;
  } finally {
    database.close();
  }
}

export function backupDatabase(databaseFile: string, backupDirectory = join(dirname(databaseFile), "backups")): string {
  mkdirSync(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const destination = join(backupDirectory, `${basename(databaseFile, ".db")}-${timestamp}.db`);
  const database = openDatabase(databaseFile);
  try {
    database.prepare("VACUUM INTO ?").run(destination);
  } finally {
    database.close();
  }
  const verification = new DatabaseSync(destination);
  try {
    const result = verification.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (result.integrity_check !== "ok") throw new Error(`数据库备份校验失败：${result.integrity_check}`);
  } finally {
    verification.close();
  }
  return destination;
}

export function recordRun(
  databaseFile: string,
  input: { id: string; type: string; status: string; summary?: string },
): void {
  const database = openDatabase(databaseFile);
  try {
    database.prepare(`
      INSERT INTO app_runs (id, run_type, status, started_at, finished_at, summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.type,
      input.status,
      new Date().toISOString(),
      new Date().toISOString(),
      input.summary ?? null,
    );
  } finally {
    database.close();
  }
}

export function beginRun(databaseFile: string, input: { id: string; type: string; summary?: string }): void {
  const database = openDatabase(databaseFile);
  try {
    database.prepare(`
      INSERT INTO app_runs (id, run_type, status, started_at, summary)
      VALUES (?, ?, 'RUNNING', ?, ?)
    `).run(input.id, input.type, new Date().toISOString(), input.summary ?? null);
  } finally {
    database.close();
  }
}

export function finishRun(
  databaseFile: string,
  input: { id: string; status: "COMPLETED" | "FAILED" | "INTERRUPTED"; summary?: string },
): void {
  const database = openDatabase(databaseFile);
  try {
    const result = database.prepare(`
      UPDATE app_runs SET status = ?, finished_at = ?, summary = ? WHERE id = ?
    `).run(input.status, new Date().toISOString(), input.summary ?? null, input.id);
    if (result.changes !== 1) throw new Error(`无法结束不存在的 Run：${input.id}`);
  } finally {
    database.close();
  }
}

export function recoverInterruptedRuns(databaseFile: string): number {
  const database = openDatabase(databaseFile);
  try {
    const result = database.prepare(`
      UPDATE app_runs
      SET status = 'INTERRUPTED', finished_at = ?,
          summary = COALESCE(summary, 'Process stopped before the run completed.')
      WHERE status = 'RUNNING'
    `).run(new Date().toISOString());
    return Number(result.changes);
  } finally {
    database.close();
  }
}

export function beginResearchTask(databaseFile: string, input: { id: string; question: string; candidateEventId?: string }): void {
  const database = openDatabase(databaseFile);
  try {
    database.prepare(`
      INSERT INTO research_tasks (id, candidate_event_id, question, status, created_at)
      VALUES (?, ?, ?, 'RUNNING', ?)
    `).run(input.id, input.candidateEventId ?? null, input.question, new Date().toISOString());
  } finally {
    database.close();
  }
}

export function finishResearchTask(
  databaseFile: string,
  input: { id: string; status: "COMPLETED" | "FAILED"; result?: unknown; error?: string },
): void {
  const database = openDatabase(databaseFile);
  try {
    database.prepare(`
      UPDATE research_tasks
      SET status = ?, result_json = ?, error = ?, finished_at = ? WHERE id = ?
    `).run(
      input.status,
      input.result === undefined ? null : JSON.stringify(input.result),
      input.error ?? null,
      new Date().toISOString(),
      input.id,
    );
  } finally {
    database.close();
  }
}

export function getDatabaseStatus(databaseFile: string): DatabaseStatus {
  const database = openDatabase(databaseFile);
  try {
    const version = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };
    const runs = database.prepare(`
      SELECT COUNT(*) AS count, MAX(started_at) AS last_run_at
      FROM app_runs
    `).get() as { count: number; last_run_at: string | null };
    const lastRun = database.prepare(`
      SELECT status FROM app_runs ORDER BY started_at DESC LIMIT 1
    `).get() as { status: string } | undefined;
    const deliveries = database.prepare("SELECT COUNT(*) AS count FROM weekly_deliveries").get() as { count: number };
    const events = database.prepare("SELECT COUNT(*) AS count FROM events WHERE status != 'MERGED'").get() as { count: number };

    const result: DatabaseStatus = {
      schemaVersion: version.version,
      runCount: runs.count,
      eventCount: events.count,
      deliveryCount: deliveries.count,
    };
    if (runs.last_run_at) result.lastRunAt = runs.last_run_at;
    if (lastRun) result.lastRunStatus = lastRun.status;
    return result;
  } finally {
    database.close();
  }
}
