import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finalizeWeek, previewWeek } from "../src/brief/finalizer.js";
import { migrateDatabase } from "../src/database.js";
import type { ResearchResult } from "../src/domain/types.js";
import { saveResearchResult } from "../src/events/event-repository.js";

function research(index: number): ResearchResult {
  return {
    event: {
      title: `Event ${index}`,
      summary: `Summary ${index}`,
      whyItMatters: `Reason ${index}`,
      identity: { subjects: [`Lab ${index}`], action: "RELEASE", objects: [`Model ${index}`] },
      announcedAt: `2026-08-${String(10 + index).padStart(2, "0")}T00:00:00Z`,
    },
    facts: [{ key: "index", value: index, sourceIndexes: [0], confidence: 9 }],
    sources: [{ publisher: `Lab ${index}`, url: `https://example.com/${index}`, sourceType: "OFFICIAL", trustTier: 1 }],
    conflicts: [],
    missingEvidence: [],
    scores: { novelty: 8, importance: 8, disruption: 7, confidence: 9 },
    evidenceLevel: "PRIMARY",
  };
}

test("finalizer fails closed below ten and succeeds with ten distinct sourced events", () => {
  const directory = mkdtempSync(join(tmpdir(), "awb-finalizer-"));
  const database = join(directory, "weekly.db");
  const week = "2026-W33";
  try {
    migrateDatabase(database);
    for (let index = 0; index < 9; index += 1) saveResearchResult(database, research(index), week);
    const incomplete = previewWeek(database, week);
    assert.equal(incomplete.ok, false);
    assert.match(incomplete.issues.join(" "), /不足 10/u);
    saveResearchResult(database, research(9), week);
    const complete = finalizeWeek(database, week);
    assert.equal(complete.ok, true);
    assert.equal(complete.bundles.length, 10);
    assert.ok(complete.briefId);
    assert.equal(complete.version, 1);
    const unchanged = finalizeWeek(database, week);
    assert.equal(unchanged.briefId, complete.briefId);
    assert.equal(unchanged.version, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
