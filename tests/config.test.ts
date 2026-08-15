import assert from "node:assert/strict";
import test from "node:test";
import { createAppPaths, findProjectRoot } from "../src/app-paths.js";
import { type AppConfig, validateConfig } from "../src/config.js";

function validConfig(): AppConfig {
  return {
    paths: createAppPaths(findProjectRoot()),
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

test("mock configuration passes without external keys", () => {
  assert.deepEqual(validateConfig(validConfig()), []);
});

test("invalid schedule and budget produce readable issues", () => {
  const config = validConfig();
  config.weeklyBudgetUsd = 0;
  config.heartbeatTimes = ["25:00"];
  const issues = validateConfig(config);
  assert.ok(issues.some((issue) => issue.includes("WEEKLY_BUDGET_USD")));
  assert.ok(issues.some((issue) => issue.includes("HEARTBEAT_TIMES")));
});

test("DeepSeek configuration uses its native API key environment variable", () => {
  const config = validConfig();
  config.modelProvider = "deepseek";
  config.modelMain = "deepseek-v4-pro";
  config.modelResearch = "deepseek-v4-flash";
  const previous = process.env.DEEPSEEK_API_KEY;
  try {
    delete process.env.DEEPSEEK_API_KEY;
    assert.ok(validateConfig(config).some((issue) => issue.includes("DEEPSEEK_API_KEY")));
    process.env.DEEPSEEK_API_KEY = "test-key";
    assert.deepEqual(validateConfig(config), []);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

test("approval and auto modes require an official Feishu webhook", () => {
  const config = validConfig();
  config.runMode = "AUTO";
  assert.ok(validateConfig(config).some((issue) => issue.includes("FEISHU_WEBHOOK_URL")));
  config.feishuWebhookUrl = "https://example.com/hook/test";
  assert.ok(validateConfig(config).some((issue) => issue.includes("官方自定义机器人")));
  config.feishuWebhookUrl = "https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook";
  assert.deepEqual(validateConfig(config), []);
});
