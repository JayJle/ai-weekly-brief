import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { compareEvents } from "../dedup/event-dedup.js";
import type { CandidateEvent, ResearchResult } from "../domain/types.js";
import { getWeekUsage, migrateDatabase, type UsageSummary } from "../database.js";
import { isoWeekInTimezone } from "../events/event-repository.js";
import { sendFeishu, type NotificationResult } from "../notifications/feishu.js";
import { researchEvent, type ResearchTaskInput } from "../research/research-service.js";
import { searchWeb, type SearchResult } from "../search/search-provider.js";
import { appendUsageFooter, subtractUsage } from "../usage/usage-footer.js";

const QUALITY_QUERIES = [
  "most important AI model or agent product release this week official announcement",
  "中国 人工智能 大模型 Agent 本周 官方 发布",
  "AI open source model developer tool release this week GitHub official",
  "AI research paper benchmark breakthrough this week",
  "AI chips compute infrastructure major announcement this week",
  "AI policy regulation legal action this week official",
  "AI company acquisition funding pricing major change this week",
  "AI safety security incident important development this week",
  "Europe AI major development this week official",
  "AI application workflow product launch this week official",
] as const;

export interface QualityTestDependencies {
  search: (config: AppConfig, query: string, limit: number) => Promise<SearchResult[]>;
  research: (config: AppConfig, input: ResearchTaskInput) => Promise<ResearchResult>;
  notify: (webhookUrl: string, input: { title: string; markdown: string }) => Promise<NotificationResult>;
  onProgress?: (message: string) => void;
}

export interface QualityTestResult {
  requestedItems: number;
  deliveredItems: number;
  searchedQueries: number;
  rejectedItems: number;
  duplicateItems: number;
  usage: UsageSummary;
  markdown: string;
  messageId?: string;
}

function candidateFromResearch(result: ResearchResult): CandidateEvent {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    weekId: "QUALITY_TEST",
    status: "CANDIDATE",
    title: result.event.title,
    summary: result.event.summary,
    whyItMatters: result.event.whyItMatters,
    identity: result.event.identity,
    firstSeenAt: now,
    lastCheckedAt: now,
    scores: result.scores,
    evidenceLevel: result.evidenceLevel,
    ...(result.event.occurredAt ? { occurredAt: result.event.occurredAt } : {}),
    ...(result.event.announcedAt ? { announcedAt: result.event.announcedAt } : {}),
  };
}

export function renderQualityTestBrief(results: ResearchResult[]): string {
  const sections = results.map((result, index) => [
    `## ${index + 1}. ${result.event.title}`,
    "",
    result.event.summary,
    "",
    `**为什么值得关注：** ${result.event.whyItMatters}`,
    "",
    `**评分：** 新颖性 ${result.scores.novelty}｜重要性 ${result.scores.importance}｜颠覆性 ${result.scores.disruption}｜可信度 ${result.scores.confidence}`,
    "",
    `**证据等级：** ${result.evidenceLevel}`,
    "",
    `**来源：** ${result.sources.map((source) => `[${source.publisher}](${source.url})`).join(" · ")}`,
  ].join("\n"));
  return [
    "# AI Weekly Brief 内容质量测试",
    "",
    "> 这是一份由 DeepSeek + Tavily 临时生成的测试推送，不是正式周报，不会进入正式候选库。",
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    ...sections.flatMap((section) => [section, "", "---", ""]),
  ].join("\n");
}

export async function runQualityTest(
  config: AppConfig,
  requestedItems = 5,
  dependencies: QualityTestDependencies = {
    search: searchWeb,
    research: researchEvent,
    notify: sendFeishu,
  },
): Promise<QualityTestResult> {
  if (config.modelProvider !== "deepseek") throw new Error("内容质量测试要求 MODEL_PROVIDER=deepseek");
  if (config.searchProvider !== "tavily") throw new Error("内容质量测试要求 SEARCH_PROVIDER=tavily");
  if (!config.feishuWebhookUrl) throw new Error("内容质量测试需要 FEISHU_WEBHOOK_URL");
  if (!Number.isInteger(requestedItems) || requestedItems < 1 || requestedItems > 10) {
    throw new Error("测试条数必须是 1–10 的整数");
  }
  migrateDatabase(config.paths.databaseFile);

  const accepted: Array<{ research: ResearchResult; candidate: CandidateEvent }> = [];
  const targetWeek = isoWeekInTimezone(config.timezone);
  const usageBefore = getWeekUsage(config.paths.databaseFile, targetWeek);
  let searchedQueries = 0;
  let rejectedItems = 0;
  let duplicateItems = 0;
  for (const query of QUALITY_QUERIES) {
    if (accepted.length >= requestedItems) break;
    searchedQueries += 1;
    dependencies.onProgress?.(`搜索 ${searchedQueries}/${QUALITY_QUERIES.length}：${query}`);
    const results = await dependencies.search(config, query, 5);
    if (results.length === 0) {
      rejectedItems += 1;
      continue;
    }
    dependencies.onProgress?.(`启动独立 Research Agent：${results[0]?.title ?? query}`);
    const research = await dependencies.research(config, {
      question: `从以下线索中核验一个本周真实发生、最值得关注的 AI 事件。优先一手来源；若证据不足必须降低可信度。主题：${query}`,
      seedUrls: results.slice(0, 5).map((item) => item.url),
      searchResults: results,
    });
    const eventTimes = [research.event.announcedAt, research.event.occurredAt]
      .filter((value): value is string => Boolean(value));
    const belongsToTargetWeek = eventTimes.some(
      (value) => isoWeekInTimezone(config.timezone, new Date(value)) === targetWeek,
    );
    if (!belongsToTargetWeek) {
      dependencies.onProgress?.(`拒绝非本周事件：${research.event.title}`);
      rejectedItems += 1;
      continue;
    }
    if (research.scores.confidence < 7 || research.evidenceLevel === "WEAK" || research.sources.length === 0) {
      rejectedItems += 1;
      continue;
    }
    const candidate = candidateFromResearch(research);
    const relation = accepted.map((item) => compareEvents(item.candidate, candidate))
      .find((decision) => decision.relation === "SAME_EVENT" || decision.relation === "UNCERTAIN");
    if (relation) {
      duplicateItems += 1;
      continue;
    }
    accepted.push({ research, candidate });
  }

  if (accepted.length === 0) throw new Error("没有得到满足可信度要求的测试内容，因此没有推送");
  const usage = subtractUsage(getWeekUsage(config.paths.databaseFile, targetWeek), usageBefore);
  const markdown = appendUsageFooter(
    renderQualityTestBrief(accepted.map((item) => item.research)),
    usage,
  );
  dependencies.onProgress?.(`正在向飞书推送 ${accepted.length} 条测试内容……`);
  const sent = await dependencies.notify(config.feishuWebhookUrl, {
    title: `AI Weekly Brief 内容质量测试 · ${accepted.length} 条`,
    markdown,
  });
  return {
    requestedItems,
    deliveredItems: accepted.length,
    searchedQueries,
    rejectedItems,
    duplicateItems,
    usage,
    markdown,
    ...(sent.messageId ? { messageId: sent.messageId } : {}),
  };
}
