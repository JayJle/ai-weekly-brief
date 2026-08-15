import type { UsageSummary } from "../database.js";

export function subtractUsage(after: UsageSummary, before: UsageSummary): UsageSummary {
  return {
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
    cacheReadTokens: Math.max(0, after.cacheReadTokens - before.cacheReadTokens),
    cacheWriteTokens: Math.max(0, after.cacheWriteTokens - before.cacheWriteTokens),
    totalTokens: Math.max(0, after.totalTokens - before.totalTokens),
    costUsd: Math.max(0, after.costUsd - before.costUsd),
  };
}

export function appendUsageFooter(markdown: string, usage: UsageSummary, scope = "本次生成"): string {
  const number = new Intl.NumberFormat("zh-CN");
  return [
    markdown.trimEnd(),
    "",
    "---",
    "",
    `**${scope}的模型用量**`,
    "",
    `输入 ${number.format(usage.inputTokens)}｜输出 ${number.format(usage.outputTokens)}｜缓存读取 ${number.format(usage.cacheReadTokens)}｜缓存写入 ${number.format(usage.cacheWriteTokens)}｜合计 ${number.format(usage.totalTokens)} Token`,
    "",
    `**Token 费用：$${usage.costUsd.toFixed(4)} USD**（不含 Tavily 搜索费用）`,
  ].join("\n");
}
