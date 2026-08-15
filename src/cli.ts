#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { runMainHeartbeat } from "./agent/main-agent.js";
import { createAppPaths, findProjectRoot } from "./app-paths.js";
import { finalizeWeek, previewWeek } from "./brief/finalizer.js";
import { renderEventMarkdown } from "./brief/render.js";
import { loadConfig, publicConfigSummary, validateConfig } from "./config.js";
import { getCoverageReport, scanNextCoverageSource, seedSourceRegistry } from "./coverage/coverage-service.js";
import { backupDatabase, claimAlert, getDatabaseStatus, getOperationalHealth, getWeekUsage, isWeekDelivered, listRecentRuns, migrateDatabase, recoverInterruptedRuns, resolveUncertainDelivery } from "./database.js";
import { isoWeekInTimezone, previousIsoWeekInTimezone, saveResearchResultDeduplicated } from "./events/event-repository.js";
import { deliverBrief } from "./notifications/delivery-service.js";
import { sendFeishu } from "./notifications/feishu.js";
import { runPiSmoke } from "./pi/smoke.js";
import { listConfiguredProviderModels } from "./pi/models.js";
import { runQualityTest } from "./quality/quality-test.js";
import { researchEvent } from "./research/research-service.js";
import { acquireProcessLock } from "./runtime/process-lock.js";
import { searchWeb } from "./search/search-provider.js";
import { runSetupWizard } from "./setup-wizard.js";

const command = process.argv[2] ?? "help";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireValidConfig(): ReturnType<typeof loadConfig> {
  const config = loadConfig();
  const issues = validateConfig(config);
  if (issues.length > 0) {
    throw new Error(`配置不完整：\n- ${issues.join("\n- ")}\n请运行 npm run setup 修改配置。`);
  }
  return config;
}

async function setup(): Promise<void> {
  const root = findProjectRoot();
  await runSetupWizard(createAppPaths(root));
}

function checkConfig(): void {
  const config = loadConfig();
  const issues = validateConfig(config);
  printJson(publicConfigSummary(config));
  if (issues.length > 0) throw new Error(`配置检查失败：\n- ${issues.join("\n- ")}`);
  process.stdout.write("配置检查通过。\n");
}

function migrate(): void {
  const config = loadConfig();
  migrateDatabase(config.paths.databaseFile);
  seedSourceRegistry(config.paths.databaseFile);
  process.stdout.write(`数据库迁移完成：${config.paths.databaseFile}\n`);
}

function status(): void {
  const config = loadConfig();
  migrateDatabase(config.paths.databaseFile);
  seedSourceRegistry(config.paths.databaseFile);
  printJson({
    config: publicConfigSummary(config),
    database: getDatabaseStatus(config.paths.databaseFile),
    health: getOperationalHealth(config.paths.databaseFile),
    weeklyUsage: {
      ...getWeekUsage(config.paths.databaseFile, isoWeekInTimezone(config.timezone)),
      budgetUsd: config.weeklyBudgetUsd,
    },
    process: {
      node: process.version,
      pid: process.pid,
      platform: process.platform,
    },
  });
}

async function maybeSendOperationalAlert(
  config: ReturnType<typeof loadConfig>,
  key: string,
  title: string,
  markdown: string,
): Promise<void> {
  if (!config.feishuWebhookUrl || config.runMode === "DRY_RUN") return;
  if (!claimAlert(config.paths.databaseFile, key)) return;
  try {
    await sendFeishu(config.feishuWebhookUrl, { title, markdown });
  } catch (error) {
    process.stderr.write(`运行告警发送失败：${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function history(): void {
  const config = loadConfig();
  migrateDatabase(config.paths.databaseFile);
  printJson(listRecentRuns(config.paths.databaseFile, Number(process.argv[3] ?? "20")));
}

function backup(): void {
  const config = loadConfig();
  migrateDatabase(config.paths.databaseFile);
  const destination = backupDatabase(config.paths.databaseFile);
  process.stdout.write(`数据库备份完成并通过完整性校验：${destination}\n`);
}

function resolveDelivery(): void {
  const config = loadConfig();
  migrateDatabase(config.paths.databaseFile);
  const weekId = process.argv[3];
  const version = Number(process.argv[4]);
  const resolution = process.argv[5];
  if (!weekId || !/^\d{4}-W\d{2}$/u.test(weekId) || !Number.isInteger(version) || version < 1) {
    throw new Error("用法：npm run delivery:resolve -- 2026-W33 1 SENT|RETRY");
  }
  if (resolution !== "SENT" && resolution !== "RETRY") {
    throw new Error("处理结果必须是 SENT（确认已收到）或 RETRY（确认未收到，允许重试）");
  }
  resolveUncertainDelivery(config.paths.databaseFile, { weekId, version, resolution });
  process.stdout.write(resolution === "SENT"
    ? "已将该记录确认为发送成功。\n"
    : "已清除不确定记录；确认飞书未收到后，可重新执行 brief:send。\n");
}

function coverageStatus(): void {
  const config = loadConfig();
  migrateDatabase(config.paths.databaseFile);
  seedSourceRegistry(config.paths.databaseFile);
  printJson(getCoverageReport(config.paths.databaseFile));
}

async function coverageScan(): Promise<void> {
  const config = requireValidConfig();
  migrateDatabase(config.paths.databaseFile);
  seedSourceRegistry(config.paths.databaseFile);
  const result = await scanNextCoverageSource(config);
  printJson({ source: result.source, resultCount: result.results.length, results: result.results });
}

async function notifyTest(): Promise<void> {
  const config = requireValidConfig();
  if (!config.feishuWebhookUrl) throw new Error("尚未配置 FEISHU_WEBHOOK_URL，请先运行 npm run setup");
  const result = await sendFeishu(config.feishuWebhookUrl, {
    title: "AI Weekly Brief 飞书测试",
    markdown: [
      "# 配置成功",
      "",
      "AI Weekly Brief 已成功连接飞书自定义机器人。",
      "",
      `测试时间：${new Date().toISOString()}`,
    ].join("\n"),
  });
  process.stdout.write(`飞书测试消息发送成功${result.messageId ? `，messageId=${result.messageId}` : ""}。\n`);
}

async function searchSmoke(): Promise<void> {
  const config = requireValidConfig();
  const results = await searchWeb(config, "AI model release this week", 3);
  printJson({ provider: config.searchProvider, count: results.length, results });
  if (results.length === 0) throw new Error("搜索连接成功，但没有返回结果");
  process.stdout.write("搜索冒烟测试通过。\n");
}

async function piSmoke(): Promise<void> {
  const config = requireValidConfig();
  const result = await runPiSmoke(config);
  printJson(result);
  process.stdout.write(config.modelProvider === "mock"
    ? "Pi 冒烟命令已在 Mock 模式通过；配置真实模型后会调用 Pi SDK 和模型 API。\n"
    : "Pi SDK、自定义工具和模型连接测试通过。\n");
}

async function listModels(): Promise<void> {
  const provider = process.argv[3];
  const query = process.argv.slice(4).join(" ");
  printJson(await listConfiguredProviderModels(provider, query));
  if (!provider) {
    process.stdout.write("\n查看某个提供商的模型：npm run models:list -- deepseek\n");
  }
}

async function demoEvent(): Promise<void> {
  const config = requireValidConfig();
  migrateDatabase(config.paths.databaseFile);
  const question = process.argv.slice(3).join(" ").replaceAll("^", "") || "研究本周一个值得关注的 AI 产品发布";
  process.stdout.write(`正在搜索：${question}\n`);
  const searchResults = await searchWeb(config, question, 5);
  if (searchResults.length === 0) throw new Error("没有找到可研究的搜索线索");
  process.stdout.write(`找到 ${searchResults.length} 条线索，正在启动 Research Agent……\n`);
  const research = await researchEvent(config, {
    question,
    seedUrls: searchResults.slice(0, 3).map((item) => item.url),
    searchResults,
  });
  const saved = saveResearchResultDeduplicated(config.paths.databaseFile, research, isoWeekInTimezone(config.timezone));
  const bundle = saved.bundle;
  const markdown = renderEventMarkdown(bundle);
  process.stdout.write("\n单事件闭环完成：\n\n");
  process.stdout.write(markdown);
  process.stdout.write(saved.mergedInto
    ? `\n已识别为同一事件并合并证据，eventId=${saved.mergedInto}\n`
    : `\n已保存到 SQLite，eventId=${bundle.event.id}\n`);
}

async function qualityTest(): Promise<void> {
  const config = requireValidConfig();
  const requestedItems = Number(process.argv[3] ?? "5");
  mkdirSync(config.paths.dataDir, { recursive: true });
  const previewFile = join(config.paths.dataDir, "quality-test-latest.md");
  process.stdout.write("即将调用真实 DeepSeek、Tavily 和飞书 Webhook；这会产生 API 用量。\n");
  const result = await runQualityTest(config, requestedItems, {
    search: searchWeb,
    research: researchEvent,
    notify: async (webhookUrl, input) => {
      writeFileSync(previewFile, input.markdown, "utf8");
      return sendFeishu(webhookUrl, input);
    },
    onProgress: (message) => process.stdout.write(`${message}\n`),
  });
  writeFileSync(previewFile, result.markdown, "utf8");
  printJson({
    requestedItems: result.requestedItems,
    deliveredItems: result.deliveredItems,
    searchedQueries: result.searchedQueries,
    rejectedItems: result.rejectedItems,
    duplicateItems: result.duplicateItems,
    usage: result.usage,
    messageId: result.messageId,
    previewFile,
  });
  process.stdout.write("内容质量测试已推送到飞书群。\n");
}

async function heartbeat(insideRunningService = false): Promise<void> {
  const config = requireValidConfig();
  const releaseLock = insideRunningService
    ? () => undefined
    : acquireProcessLock(join(config.paths.dataDir, "ai-weekly-brief.lock"));
  try {
    const result = await runMainHeartbeat(config);
    printJson(result);
    process.stdout.write("Main Agent Heartbeat 执行完成。\n");
  } finally {
    releaseLock();
  }
}

function preview(): void {
  const config = requireValidConfig();
  migrateDatabase(config.paths.databaseFile);
  const weekId = process.argv[3] ?? isoWeekInTimezone(config.timezone);
  const result = previewWeek(config.paths.databaseFile, weekId);
  process.stdout.write(`${result.markdown}\n`);
  if (result.issues.length > 0) {
    process.stdout.write(`\n预检尚未通过：\n- ${result.issues.join("\n- ")}\n`);
  }
}

function finalize(): void {
  const config = requireValidConfig();
  migrateDatabase(config.paths.databaseFile);
  const weekId = process.argv[3] ?? isoWeekInTimezone(config.timezone);
  const result = finalizeWeek(config.paths.databaseFile, weekId);
  if (!result.ok) throw new Error(`周报 Finalizer 未通过：\n- ${result.issues.join("\n- ")}`);
  process.stdout.write(`周报已冻结：briefId=${result.briefId} version=${result.version}\n`);
}

async function sendBrief(weekId?: string): Promise<void> {
  const config = requireValidConfig();
  if (config.runMode === "DRY_RUN") throw new Error("当前 RUN_MODE=DRY_RUN，不允许真实飞书发送");
  migrateDatabase(config.paths.databaseFile);
  const targetWeek = weekId ?? process.argv[3] ?? isoWeekInTimezone(config.timezone);
  const result = finalizeWeek(config.paths.databaseFile, targetWeek);
  if (!result.ok || !result.briefId || !result.version) {
    throw new Error(`周报 Finalizer 未通过：\n- ${result.issues.join("\n- ")}`);
  }
  const delivered = await deliverBrief(config, {
    briefId: result.briefId,
    weekId: result.weekId,
    version: result.version,
    markdown: result.markdown,
  });
  process.stdout.write(delivered.status === "SKIPPED" ? "该版本已经发送，已跳过。\n" : "周报已发送到飞书群。\n");
}

function localTime(config: ReturnType<typeof loadConfig>): { date: string; time: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = `${values.year}-${values.month}-${values.day}`;
  return { date, time: `${values.hour}:${values.minute}`, weekday: new Date(`${date}T00:00:00Z`).getUTCDay() };
}

async function scheduledPublish(config: ReturnType<typeof loadConfig>): Promise<void> {
  const targetWeek = previousIsoWeekInTimezone(config.timezone);
  if (isWeekDelivered(config.paths.databaseFile, targetWeek)) return;
  const result = previewWeek(config.paths.databaseFile, targetWeek);
  if (!result.ok) {
    process.stdout.write(`周报尚未达到发布条件：${result.issues.join("；")}\n`);
    await maybeSendOperationalAlert(
      config,
      `publish-not-ready:${targetWeek}`,
      `AI Weekly Brief 未能发布 · ${targetWeek}`,
      ["# 周报未达到发布条件", "", ...result.issues.map((issue) => `- ${issue}`)].join("\n"),
    );
    return;
  }
  if (config.runMode === "DRY_RUN") {
    process.stdout.write("周报预检通过；当前为 DRY_RUN，未发送。可运行 npm run brief:preview 查看。\n");
    return;
  }
  if (config.runMode === "APPROVAL") {
    process.stdout.write("周报预检通过；当前为 APPROVAL，请确认后运行 npm run brief:send。\n");
    return;
  }
  await sendBrief(targetWeek);
}

async function start(): Promise<void> {
  const config = requireValidConfig();
  mkdirSync(config.paths.dataDir, { recursive: true });
  migrateDatabase(config.paths.databaseFile);
  const recovered = recoverInterruptedRuns(config.paths.databaseFile);
  seedSourceRegistry(config.paths.databaseFile);
  const releaseLock = acquireProcessLock(join(config.paths.dataDir, "ai-weekly-brief.lock"));
  process.stdout.write("AI Weekly Brief 已启动。\n");
  process.stdout.write(`项目目录：${config.paths.projectRoot}\n`);
  process.stdout.write(`数据库：${config.paths.databaseFile}\n`);
  process.stdout.write(`时区：${config.timezone}\n`);
  process.stdout.write(`Heartbeat：${config.heartbeatTimes.join(", ")}\n`);
  if (recovered > 0) process.stdout.write(`已恢复 ${recovered} 个上次异常中断的 Run。\n`);
  process.stdout.write("按 Ctrl+C 停止。\n");

  let lastHeartbeatKey = "";
  let lastPublishAttemptKey = "";
  let running = false;
  const tick = async (startup = false) => {
    if (running) return;
    const now = localTime(config);
    const heartbeatKey = `${now.date}T${now.time}`;
    const heartbeatDue = startup || (config.heartbeatTimes.includes(now.time) && heartbeatKey !== lastHeartbeatKey);
    const daysSincePublishWeekday = (now.weekday - config.publishWeekday + 7) % 7;
    const publishTimeReached = daysSincePublishWeekday > 0
      || (daysSincePublishWeekday === 0 && now.time >= config.publishTime);
    const publishAttemptKey = config.runMode === "AUTO"
      ? `${now.date}T${now.time.slice(0, 2)}`
      : now.date;
    const publishDue = publishTimeReached && publishAttemptKey !== lastPublishAttemptKey;
    if (!heartbeatDue && !publishDue) return;
    running = true;
    try {
      if (heartbeatDue) {
        lastHeartbeatKey = heartbeatKey;
        await heartbeat(true);
        const health = getOperationalHealth(config.paths.databaseFile);
        if (health.consecutiveHeartbeatFailures >= 2) {
          await maybeSendOperationalAlert(
            config,
            "heartbeat-consecutive-failures",
            "AI Weekly Brief 连续运行失败",
            `已连续失败 ${health.consecutiveHeartbeatFailures} 次，请运行 npm run status 和 npm run history 检查。`,
          );
        }
        const weekId = isoWeekInTimezone(config.timezone);
        const usage = getWeekUsage(config.paths.databaseFile, weekId);
        if (usage.costUsd >= config.weeklyBudgetUsd * 0.8) {
          await maybeSendOperationalAlert(
            config,
            `budget-80:${weekId}`,
            "AI Weekly Brief 预算提醒",
            `本周已使用 $${usage.costUsd.toFixed(4)}，预算为 $${config.weeklyBudgetUsd.toFixed(2)}。`,
          );
        }
      }
      if (publishDue) {
        lastPublishAttemptKey = publishAttemptKey;
        await scheduledPublish(config);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`定时任务失败：${message}\n`);
      const health = getOperationalHealth(config.paths.databaseFile);
      if (health.consecutiveHeartbeatFailures >= 2) {
        await maybeSendOperationalAlert(
          config,
          "heartbeat-consecutive-failures",
          "AI Weekly Brief 连续运行失败",
          `已连续失败 ${health.consecutiveHeartbeatFailures} 次。最近错误：${message}`,
        );
      }
    } finally {
      running = false;
    }
  };
  void tick(true);
  const timer = setInterval(() => void tick(), 30_000);
  const shutdown = () => {
    clearInterval(timer);
    releaseLock();
    process.stdout.write("\nAI Weekly Brief 已停止。\n");
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function help(): void {
  process.stdout.write(`
AI Weekly Brief 命令

  npm run setup          首次配置或修改配置
  npm run config:check   检查配置和路径
  npm run db:migrate     初始化或升级 SQLite
  npm run status         查看当前状态
  npm run history        查看最近的 Agent 运行记录
  npm run backup         创建并校验 SQLite 一致性备份
  npm run delivery:resolve -- 2026-W33 1 SENT|RETRY
  npm run coverage:status 查看来源、地区和主题覆盖率
  npm run coverage:scan  手工扫描下一个覆盖来源
  npm run notify:test    向飞书群发送测试卡片
  npm run search:smoke   测试搜索服务
  npm run pi:smoke       测试 Pi SDK、模型和自定义工具
  npm run models:list    查看支持的模型提供商；-- deepseek 查看模型
  npm run demo:event     执行搜索→研究→SQLite→预览闭环
  npm run quality:test   用 DeepSeek + Tavily 生成并立即推送质量测试
  npm run heartbeat      手工执行一次完整 Main Agent Heartbeat
  npm run brief:preview  查看周报预览
  npm run brief:finalize 执行最终硬校验并冻结周报
  npm run brief:send     最终校验后发送飞书群
  npm start              启动长期运行服务
`);
}

const handlers: Record<string, () => void | Promise<void>> = {
  setup,
  "config:check": checkConfig,
  "db:migrate": migrate,
  status,
  history,
  backup,
  "delivery:resolve": resolveDelivery,
  "coverage:status": coverageStatus,
  "coverage:scan": coverageScan,
  "notify:test": notifyTest,
  "search:smoke": searchSmoke,
  "pi:smoke": piSmoke,
  "models:list": listModels,
  "demo:event": demoEvent,
  "quality:test": qualityTest,
  heartbeat,
  "brief:preview": preview,
  "brief:finalize": finalize,
  "brief:send": sendBrief,
  start,
  help,
};

try {
  const handler = handlers[command];
  if (!handler) {
    help();
    throw new Error(`未知命令：${command}`);
  }
  await handler();
} catch (error) {
  const message = error instanceof Error ? error.message : inspect(error);
  process.stderr.write(`\n错误：${message}\n`);
  if (process.env.LOG_LEVEL === "debug" && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
}
