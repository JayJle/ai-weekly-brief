import assert from "node:assert/strict";
import test from "node:test";
import { appendUsageFooter, subtractUsage } from "../src/usage/usage-footer.js";

test("usage footer reports per-run token counts and cost", () => {
  const usage = subtractUsage(
    { inputTokens: 1200, outputTokens: 350, cacheReadTokens: 400, cacheWriteTokens: 5, totalTokens: 1955, costUsd: 0.123456 },
    { inputTokens: 200, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 5, totalTokens: 355, costUsd: 0.02 },
  );
  const markdown = appendUsageFooter("# Brief", usage);
  assert.match(markdown, /输入 1,000｜输出 300｜缓存读取 300｜缓存写入 0｜合计 1,600 Token/u);
  assert.match(markdown, /Token 费用：\$0\.1035 USD/u);
});
