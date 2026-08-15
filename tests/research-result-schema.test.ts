import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import { researchResultSchema } from "../src/research/research-result-schema.js";

const validate = Compile(researchResultSchema);

function validResult(): Record<string, unknown> {
  return {
    event: {
      title: "测试事件",
      summary: "测试事实摘要",
      whyItMatters: "测试重要性",
      identity: { subjects: ["AI Lab"], action: "RELEASE", objects: ["Model"] },
      announcedAt: "2026-08-15T00:00:00Z",
    },
    facts: [{ key: "availability", value: "public", sourceIndexes: [0], confidence: 9 }],
    sources: [{
      publisher: "AI Lab",
      url: "https://example.com/release",
      sourceType: "OFFICIAL",
      trustTier: 1,
      publishedAt: "2026-08-15T00:00:00Z",
    }],
    conflicts: [],
    missingEvidence: [],
    scores: { novelty: 8, importance: 9, disruption: 7, confidence: 9 },
    evidenceLevel: "PRIMARY",
  };
}

test("research terminating tool schema accepts a complete result", () => {
  assert.equal(validate.Check(validResult()), true);
});

test("research terminating tool schema rejects malformed structures", () => {
  const invalidScore = validResult();
  invalidScore.scores = { novelty: 8, importance: 9, disruption: 7, confidence: 11 };
  assert.equal(validate.Check(invalidScore), false);

  const invalidAction = validResult();
  invalidAction.event = {
    title: "测试事件",
    summary: "测试事实摘要",
    whyItMatters: "测试重要性",
    identity: { subjects: ["AI Lab"], action: "MAKE_UP", objects: ["Model"] },
  };
  assert.equal(validate.Check(invalidAction), false);

  const noSources = validResult();
  noSources.sources = [];
  assert.equal(validate.Check(noSources), false);

  const extraProperty = validResult();
  extraProperty.unexpected = true;
  assert.equal(validate.Check(extraProperty), false);
});
