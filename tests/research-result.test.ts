import assert from "node:assert/strict";
import test from "node:test";
import { parseResearchResult } from "../src/domain/validation.js";

const valid = {
  event: {
    title: "测试事件",
    summary: "发生了一件可验证的事情。",
    whyItMatters: "它能够验证结构。",
    identity: { subjects: ["Lab"], action: "RELEASE", objects: ["Model"] },
  },
  facts: [{ key: "availability", value: "public", sourceIndexes: [0], confidence: 9 }],
  sources: [{ publisher: "Lab", url: "https://example.com", sourceType: "OFFICIAL", trustTier: 1 }],
  conflicts: [],
  missingEvidence: [],
  scores: { novelty: 8, importance: 8, disruption: 7, confidence: 9 },
  evidenceLevel: "PRIMARY",
};

test("valid research result passes strict parsing", () => {
  const parsed = parseResearchResult(valid);
  assert.equal(parsed.event.identity.action, "RELEASE");
  assert.equal(parsed.sources[0]?.trustTier, 1);
});

test("invalid score and action are rejected", () => {
  assert.throws(() => parseResearchResult({ ...valid, scores: { ...valid.scores, confidence: 11 } }), /1–10/u);
  assert.throws(() => parseResearchResult({
    ...valid,
    event: { ...valid.event, identity: { ...valid.event.identity, action: "SAME_EVENT" } },
  }), /EventAction/u);
});

test("unsafe URLs, invalid dates and untraceable facts are rejected", () => {
  assert.throws(() => parseResearchResult({
    ...valid,
    sources: [{ ...valid.sources[0], url: "file:///secret" }],
  }), /HTTP\/HTTPS URL/u);
  assert.throws(() => parseResearchResult({
    ...valid,
    event: { ...valid.event, announcedAt: "yesterday" },
  }), /ISO-8601/u);
  assert.throws(() => parseResearchResult({
    ...valid,
    facts: [{ ...valid.facts[0], sourceIndexes: [] }],
  }), /非空数组/u);
});
