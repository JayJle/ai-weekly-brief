import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateEvent } from "../src/domain/types.js";
import { compareEvents, rankingScore } from "../src/dedup/event-dedup.js";
import { migrateDatabase } from "../src/database.js";
import { mergeSameEvent, saveResearchResult } from "../src/events/event-repository.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResearchResult } from "../src/domain/types.js";

function event(action: CandidateEvent["identity"]["action"], object = "Model X"): CandidateEvent {
  return {
    id: `${action}-${object}`,
    weekId: "2026-W33",
    status: "CANDIDATE",
    title: `${action} ${object}`,
    summary: "summary",
    whyItMatters: "reason",
    identity: { subjects: ["Example AI"], action, objects: [object] },
    announcedAt: "2026-08-15T00:00:00Z",
    firstSeenAt: "2026-08-15T00:00:00Z",
    lastCheckedAt: "2026-08-15T00:00:00Z",
    scores: { novelty: 8, importance: 9, disruption: 7, confidence: 9 },
    evidenceLevel: "PRIMARY",
  };
}

test("same event consolidates while different action remains related", () => {
  assert.equal(compareEvents(event("RELEASE"), { ...event("RELEASE"), id: "other" }).relation, "SAME_EVENT");
  assert.equal(compareEvents(event("RELEASE"), event("PRICE_CHANGE")).relation, "RELATED");
  assert.equal(compareEvents(event("ANNOUNCE"), event("GENERAL_AVAILABILITY")).relation, "UPDATE");
  assert.equal(compareEvents(event("RELEASE"), event("RELEASE", "Model Y")).relation, "DISTINCT");
});

test("ranking score rewards importance and confidence", () => {
  const strong = event("RELEASE");
  const weak = { ...event("RELEASE"), scores: { novelty: 5, importance: 5, disruption: 5, confidence: 7 } };
  assert.ok(rankingScore(strong) > rankingScore(weak));
});

test("merge service keeps audit-friendly canonical event and combines evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "awb-merge-"));
  const database = join(directory, "weekly.db");
  const makeResearch = (url: string, fact: string): ResearchResult => ({
    event: {
      title: "Example AI releases Model X",
      summary: "summary",
      whyItMatters: "reason",
      identity: { subjects: ["Example AI"], action: "RELEASE", objects: ["Model X"] },
      announcedAt: "2026-08-15T00:00:00Z",
    },
    facts: [{ key: fact, value: true, sourceIndexes: [0], confidence: 9 }],
    sources: [{ publisher: "Source", url, sourceType: "OFFICIAL", trustTier: 1 }],
    conflicts: [],
    missingEvidence: [],
    scores: { novelty: 8, importance: 9, disruption: 7, confidence: 9 },
    evidenceLevel: "PRIMARY",
  });
  try {
    migrateDatabase(database);
    const canonical = saveResearchResult(database, makeResearch("https://example.com/one", "one"), "2026-W33");
    const duplicate = saveResearchResult(database, makeResearch("https://example.com/two", "two"), "2026-W33");
    const merged = mergeSameEvent(database, canonical.event.id, duplicate.event.id);
    assert.equal(merged.sources.length, 2);
    assert.equal(merged.facts.length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
