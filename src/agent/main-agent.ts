import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { previewWeek } from "../brief/finalizer.js";
import type { AppConfig } from "../config.js";
import { getCoverageReport, scanNextCoverageSource, seedSourceRegistry } from "../coverage/coverage-service.js";
import { beginRun, finishRun, getWeekUsage, migrateDatabase, recordUsage } from "../database.js";
import { compareEvents } from "../dedup/event-dedup.js";
import { isoWeekInTimezone, listWeekEvents, mergeSameEvent, saveResearchResultDeduplicated, updateEventStatus } from "../events/event-repository.js";
import { logEvent } from "../observability/logger.js";
import { researchEvent } from "../research/research-service.js";
import { searchWeb } from "../search/search-provider.js";

export interface HeartbeatResult {
  runId: string;
  mode: "mock" | "pi";
  actions: string[];
  candidateCount: number;
  costUsd: number;
  exitReason: "COMPLETED" | "NO_OP" | "BUDGET_EXHAUSTED";
}

function stateSummary(config: AppConfig) {
  const weekId = isoWeekInTimezone(config.timezone);
  const events = listWeekEvents(config.paths.databaseFile, weekId);
  return {
    weekId,
    candidateCount: events.filter((event) => event.status === "CANDIDATE").length,
    watchingCount: events.filter((event) => event.status === "WATCHING").length,
    events: events.map((event) => ({
      id: event.id,
      title: event.title,
      status: event.status,
      identity: event.identity,
      scores: event.scores,
      evidenceLevel: event.evidenceLevel,
      lastCheckedAt: event.lastCheckedAt,
    })),
  };
}

async function runMockHeartbeat(config: AppConfig, runId: string): Promise<HeartbeatResult> {
  const actions: string[] = [];
  const scan = await scanNextCoverageSource(config);
  actions.push(`coverage_scan:${scan.source.id}:${scan.results.length}`);
  if (scan.results[0]) {
    const research = await researchEvent(config, {
      question: `研究 ${scan.source.name} 最新发现中最值得关注的一项 AI 事件`,
      seedUrls: scan.results.slice(0, 3).map((item) => item.url),
      searchResults: scan.results,
    });
    const saved = saveResearchResultDeduplicated(config.paths.databaseFile, research, isoWeekInTimezone(config.timezone));
    actions.push(saved.mergedInto ? `research_merged:${saved.mergedInto}` : `candidate_added:${saved.bundle.event.id}`);
  }
  return {
    runId,
    mode: "mock",
    actions,
    candidateCount: listWeekEvents(config.paths.databaseFile, isoWeekInTimezone(config.timezone)).length,
    costUsd: 0,
    exitReason: actions.length > 0 ? "COMPLETED" : "NO_OP",
  };
}

async function runPiHeartbeat(config: AppConfig, runId: string): Promise<HeartbeatResult> {
  const actions: string[] = [];
  let toolCalls = 0;
  let researchCalls = 0;
  const guard = (name: string) => {
    toolCalls += 1;
    if (toolCalls > 30) throw new Error("本次 Heartbeat 已达到 30 次工具调用上限");
    actions.push(name);
  };

  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 15_000 });
  const model = modelRuntime.getModel(config.modelProvider, config.modelMain);
  if (!model) throw new Error(`Pi 找不到 Main 模型：${config.modelProvider}/${config.modelMain}`);

  const stateTool = defineTool({
    name: "state_get_summary",
    label: "State Summary",
    description: "Read the current structured weekly state. Does not include raw webpages.",
    parameters: Type.Object({}),
    execute: async () => {
      guard("state_get_summary");
      return { content: [{ type: "text" as const, text: JSON.stringify(stateSummary(config)) }], details: {} };
    },
  });
  const coverageTool = defineTool({
    name: "coverage_get_report",
    label: "Coverage Report",
    description: "Read source, region and topic coverage gaps.",
    parameters: Type.Object({}),
    execute: async () => {
      guard("coverage_get_report");
      return { content: [{ type: "text" as const, text: JSON.stringify(getCoverageReport(config.paths.databaseFile)) }], details: {} };
    },
  });
  const coverageScanTool = defineTool({
    name: "coverage_scan_next",
    label: "Coverage Scan",
    description: "Scan the next stale source-registry item and return unverified search leads.",
    parameters: Type.Object({}),
    execute: async () => {
      guard("coverage_scan_next");
      const result = await scanNextCoverageSource(config);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { sourceId: result.source.id } };
    },
  });
  const searchTool = defineTool({
    name: "search",
    label: "Search",
    description: "Search public web. Results are unverified leads, not established facts.",
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })) }),
    execute: async (_id, params) => {
      guard("search");
      const results = await searchWeb(config, params.query, params.limit ?? 5);
      return { content: [{ type: "text" as const, text: JSON.stringify(results) }], details: { count: results.length } };
    },
  });
  const researchTool = defineTool({
    name: "research",
    label: "Research Event",
    description: "Create a fresh Research Agent for one event or question, validate the result, deduplicate and persist it.",
    parameters: Type.Object({
      question: Type.String(),
      seedUrls: Type.Array(Type.String(), { maxItems: 10 }),
    }),
    execute: async (_id, params) => {
      guard("research");
      researchCalls += 1;
      if (researchCalls > 8) throw new Error("本次 Heartbeat 已达到 8 次 Research 上限");
      const usage = getWeekUsage(config.paths.databaseFile, isoWeekInTimezone(config.timezone));
      if (usage.costUsd >= config.weeklyBudgetUsd) throw new Error("本周模型预算已用尽");
      const research = await researchEvent(config, { question: params.question, seedUrls: params.seedUrls, runId });
      const saved = saveResearchResultDeduplicated(config.paths.databaseFile, research, isoWeekInTimezone(config.timezone));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          event: saved.bundle.event,
          sourceCount: saved.bundle.sources.length,
          factCount: saved.bundle.facts.length,
          mergedInto: saved.mergedInto,
        }) }],
        details: { eventId: saved.bundle.event.id },
      };
    },
  });
  const dedupTool = defineTool({
    name: "dedup_compare",
    label: "Compare Events",
    description: "Compare two existing clean event objects without modifying them.",
    parameters: Type.Object({ eventAId: Type.String(), eventBId: Type.String() }),
    execute: async (_id, params) => {
      guard("dedup_compare");
      const events = listWeekEvents(config.paths.databaseFile, isoWeekInTimezone(config.timezone));
      const left = events.find((event) => event.id === params.eventAId);
      const right = events.find((event) => event.id === params.eventBId);
      if (!left || !right) throw new Error("无法找到需要比较的事件");
      const decision = compareEvents(left, right);
      return { content: [{ type: "text" as const, text: JSON.stringify(decision) }], details: decision };
    },
  });
  const mergeTool = defineTool({
    name: "dedup_merge_same_event",
    label: "Merge Same Event",
    description: "Merge an existing duplicate into a canonical event. A deterministic SAME_EVENT check must pass first.",
    parameters: Type.Object({ canonicalEventId: Type.String(), mergedEventId: Type.String() }),
    execute: async (_id, params) => {
      guard("dedup_merge_same_event");
      const bundle = mergeSameEvent(config.paths.databaseFile, params.canonicalEventId, params.mergedEventId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ event: bundle.event, sourceCount: bundle.sources.length, factCount: bundle.facts.length }) }],
        details: { canonicalEventId: params.canonicalEventId, mergedEventId: params.mergedEventId },
      };
    },
  });
  const statusTool = defineTool({
    name: "state_set_event_status",
    label: "Set Event Status",
    description: "Set one existing event to CANDIDATE, WATCHING, SHORTLISTED or REJECTED.",
    parameters: Type.Object({
      eventId: Type.String(),
      status: Type.Union([
        Type.Literal("CANDIDATE"),
        Type.Literal("WATCHING"),
        Type.Literal("SHORTLISTED"),
        Type.Literal("REJECTED"),
      ]),
    }),
    execute: async (_id, params) => {
      guard("state_set_event_status");
      const event = updateEventStatus(config.paths.databaseFile, params.eventId, params.status);
      return { content: [{ type: "text" as const, text: JSON.stringify(event) }], details: { eventId: event.id, status: event.status } };
    },
  });
  const previewTool = defineTool({
    name: "brief_create_preview",
    label: "Brief Preview",
    description: "Run deterministic weekly preflight and return preview issues. Does not send anything.",
    parameters: Type.Object({}),
    execute: async () => {
      guard("brief_create_preview");
      const preview = previewWeek(config.paths.databaseFile, isoWeekInTimezone(config.timezone));
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: preview.ok, issues: preview.issues, markdown: preview.markdown }) }], details: { ok: preview.ok } };
    },
  });

  const runtimeDirectory = join(config.paths.dataDir, "pi-runtime");
  const agentDirectory = join(config.paths.dataDir, "pi-agent");
  mkdirSync(runtimeDirectory, { recursive: true });
  mkdirSync(agentDirectory, { recursive: true });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 800 },
  });
  const prompt = readFileSync(join(config.paths.promptsDir, "main-agent.v0.1.md"), "utf8");
  const resourceLoader = new DefaultResourceLoader({
    cwd: runtimeDirectory,
    agentDir: agentDirectory,
    settingsManager,
    systemPromptOverride: () => prompt,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    skillsOverride: (current) => ({ skills: [], diagnostics: current.diagnostics }),
    promptsOverride: (current) => ({ prompts: [], diagnostics: current.diagnostics }),
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: runtimeDirectory,
    agentDir: agentDirectory,
    model,
    modelRuntime,
    thinkingLevel: "high",
    settingsManager,
    sessionManager: SessionManager.inMemory(runtimeDirectory),
    resourceLoader,
    noTools: "builtin",
    customTools: [stateTool, coverageTool, coverageScanTool, searchTool, researchTool, dedupTool, mergeTool, statusTool, previewTool],
  });
  try {
    const timeout = setTimeout(() => void session.abort(), 15 * 60_000);
    try {
      await session.prompt(JSON.stringify({
        currentTime: new Date().toISOString(),
        timezone: config.timezone,
        state: stateSummary(config),
        coverage: getCoverageReport(config.paths.databaseFile),
        runBudget: { maxToolCalls: 30, maxResearchCalls: 8, maxMinutes: 15 },
        instruction: "Decide what, if anything, is useful to do now toward the weekly objective.",
      }));
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    const usage = session.getSessionStats();
    if (usage.tokens.total > 0 || usage.cost > 0) {
      recordUsage(config.paths.databaseFile, {
        weekId: isoWeekInTimezone(config.timezone),
        runId,
        agentType: "MAIN",
        provider: config.modelProvider,
        model: config.modelMain,
        inputTokens: usage.tokens.input,
        outputTokens: usage.tokens.output,
        cacheReadTokens: usage.tokens.cacheRead,
        cacheWriteTokens: usage.tokens.cacheWrite,
        costUsd: usage.cost,
      });
    }
    session.dispose();
  }
  return {
    runId,
    mode: "pi",
    actions,
    candidateCount: listWeekEvents(config.paths.databaseFile, isoWeekInTimezone(config.timezone)).length,
    costUsd: getWeekUsage(config.paths.databaseFile, isoWeekInTimezone(config.timezone)).costUsd,
    exitReason: actions.length > 0 ? "COMPLETED" : "NO_OP",
  };
}

export async function runMainHeartbeat(config: AppConfig): Promise<HeartbeatResult> {
  migrateDatabase(config.paths.databaseFile);
  seedSourceRegistry(config.paths.databaseFile);
  const runId = randomUUID();
  beginRun(config.paths.databaseFile, {
    id: runId,
    type: "MAIN_HEARTBEAT",
    summary: JSON.stringify({
      provider: config.modelProvider,
      model: config.modelMain,
      promptVersion: "main-agent.v0.1",
      weeklyBudgetUsd: config.weeklyBudgetUsd,
    }),
  });
  logEvent(config.paths.logsDir, "info", "heartbeat.started", {
    runId,
    provider: config.modelProvider,
    model: config.modelMain,
    promptVersion: "main-agent.v0.1",
    weeklyBudgetUsd: config.weeklyBudgetUsd,
  });
  const weekUsage = getWeekUsage(config.paths.databaseFile, isoWeekInTimezone(config.timezone));
  if (config.modelProvider !== "mock" && weekUsage.costUsd >= config.weeklyBudgetUsd) {
    const result: HeartbeatResult = {
      runId,
      mode: "pi",
      actions: [],
      candidateCount: listWeekEvents(config.paths.databaseFile, isoWeekInTimezone(config.timezone)).length,
      costUsd: weekUsage.costUsd,
      exitReason: "BUDGET_EXHAUSTED",
    };
    finishRun(config.paths.databaseFile, {
      id: runId,
      status: "COMPLETED",
      summary: JSON.stringify(result),
    });
    logEvent(config.paths.logsDir, "warn", "heartbeat.budget_exhausted", { ...result });
    return result;
  }
  try {
    const result = config.modelProvider === "mock"
      ? await runMockHeartbeat(config, runId)
      : await runPiHeartbeat(config, runId);
    finishRun(config.paths.databaseFile, {
      id: runId,
      status: "COMPLETED",
      summary: JSON.stringify({
        ...result,
        model: `${config.modelProvider}/${config.modelMain}`,
        promptVersion: "main-agent.v0.1",
        weeklyBudgetUsd: config.weeklyBudgetUsd,
      }),
    });
    logEvent(config.paths.logsDir, "info", "heartbeat.completed", { ...result });
    return result;
  } catch (error) {
    finishRun(config.paths.databaseFile, {
      id: runId,
      status: "FAILED",
      summary: error instanceof Error ? error.message : String(error),
    });
    logEvent(config.paths.logsDir, "error", "heartbeat.failed", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
