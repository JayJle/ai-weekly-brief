import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppPaths } from "../src/app-paths.js";
import type { AppConfig } from "../src/config.js";
import type { ResearchResult } from "../src/domain/types.js";
import { runQualityTest } from "../src/quality/quality-test.js";

test("quality test requires DeepSeek/Tavily, deduplicates, and sends a clearly labelled preview", async () => {
  const directory = mkdtempSync(join(tmpdir(), "awb-quality-"));
  const config: AppConfig = {
    paths: createAppPaths(directory, { dataDir: join(directory, "data"), databasePath: join(directory, "data", "weekly.db") }),
    modelProvider: "deepseek",
    modelMain: "deepseek-v4-pro",
    modelResearch: "deepseek-v4-flash",
    searchProvider: "tavily",
    searchApiKey: "tvly-test",
    feishuWebhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook",
    timezone: "Asia/Shanghai",
    runMode: "DRY_RUN",
    weeklyBudgetUsd: 10,
    heartbeatTimes: ["08:00"],
    publishWeekday: 1,
    publishTime: "08:30",
    logLevel: "info",
  };
  let researchIndex = 0;
  let pushedTitle = "";
  const research = (): ResearchResult => {
    researchIndex += 1;
    return {
      event: {
        title: `Quality event ${researchIndex}`,
        summary: "Verified summary",
        whyItMatters: "Material impact",
        identity: { subjects: [`Lab ${researchIndex}`], action: "RELEASE", objects: [`Model ${researchIndex}`] },
        announcedAt: new Date().toISOString(),
      },
      facts: [{ key: "release", value: true, sourceIndexes: [0], confidence: 9 }],
      sources: [{ publisher: "Official", url: `https://example.com/${researchIndex}`, sourceType: "OFFICIAL", trustTier: 1 }],
      conflicts: [],
      missingEvidence: [],
      scores: { novelty: 8, importance: 9, disruption: 7, confidence: 9 },
      evidenceLevel: "PRIMARY",
    };
  };
  try {
    const result = await runQualityTest(config, 2, {
      search: async () => [{ title: "Lead", url: "https://example.com/lead", snippet: "Lead" }],
      research: async () => research(),
      notify: async (_key, input) => {
        pushedTitle = input.title;
        assert.match(input.markdown, /不是正式周报/u);
        assert.match(input.markdown, /Token 费用：\$0\.0000 USD/u);
        assert.match(input.markdown, /不含 Tavily 搜索费用/u);
        return { provider: "feishu", messageId: "test-message" };
      },
    });
    assert.equal(result.deliveredItems, 2);
    assert.equal(result.messageId, "test-message");
    assert.equal(result.usage.totalTokens, 0);
    assert.match(pushedTitle, /内容质量测试/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
