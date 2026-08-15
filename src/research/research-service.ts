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
import type { AppConfig } from "../config.js";
import { beginResearchTask, finishResearchTask, getWeekUsage, recordUsage } from "../database.js";
import type { ResearchResult } from "../domain/types.js";
import { parseResearchResult } from "../domain/validation.js";
import { isoWeekInTimezone } from "../events/event-repository.js";
import { safeFetch } from "../fetch/safe-fetch.js";
import { searchWeb, type SearchResult } from "../search/search-provider.js";
import { researchResultSchema } from "./research-result-schema.js";

const MAX_RESEARCH_SEARCH_CALLS = 4;
const MAX_RESEARCH_FETCH_CALLS = 6;
const MAX_RESEARCH_MINUTES = 5;
const MAX_MODEL_OUTPUT_TOKENS = 8_192;
const MAX_FETCH_TEXT_CHARS = 30_000;

export interface ResearchTaskInput {
  question: string;
  seedUrls: string[];
  searchResults?: SearchResult[];
  runId?: string;
}

function mockResearch(input: ResearchTaskInput): ResearchResult {
  const lead = input.searchResults?.[0];
  const url = lead?.url ?? input.seedUrls[0] ?? "https://example.com/mock-ai-event";
  const title = lead?.title ?? "Mock AI event announced";
  return {
    event: {
      title,
      summary: `这是用于验证端到端数据流的 Mock 事件。研究问题：${input.question}`,
      whyItMatters: "它验证了搜索、研究、结构校验、SQLite 和预览渲染能够协同工作。",
      identity: {
        subjects: ["Mock AI Lab"],
        action: "ANNOUNCE",
        objects: ["Mock AI Event"],
      },
      announcedAt: new Date().toISOString(),
    },
    facts: [{ key: "mode", value: "mock", sourceIndexes: [0], confidence: 10 }],
    sources: [{
      publisher: new URL(url).hostname,
      url,
      sourceType: "NEWS",
      trustTier: 2,
      ...(lead?.publishedAt && Number.isFinite(Date.parse(lead.publishedAt)) ? { publishedAt: new Date(lead.publishedAt).toISOString() } : {}),
    }],
    conflicts: [],
    missingEvidence: [],
    scores: { novelty: 5, importance: 5, disruption: 4, confidence: 10 },
    evidenceLevel: "SECONDARY",
  };
}

function finalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
    if (text) return text;
  }
  return "";
}

export async function researchEvent(config: AppConfig, input: ResearchTaskInput): Promise<ResearchResult> {
  const taskId = randomUUID();
  beginResearchTask(config.paths.databaseFile, { id: taskId, question: input.question });
  try {
    if (config.modelProvider === "mock") {
      const result = parseResearchResult(mockResearch(input));
      finishResearchTask(config.paths.databaseFile, { id: taskId, status: "COMPLETED", result });
      return result;
    }

  const weekId = isoWeekInTimezone(config.timezone);
  const usageBefore = getWeekUsage(config.paths.databaseFile, weekId);
  if (usageBefore.costUsd >= config.weeklyBudgetUsd) {
    throw new Error(`本周模型预算已用尽：$${usageBefore.costUsd.toFixed(4)} / $${config.weeklyBudgetUsd.toFixed(2)}`);
  }

  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 15_000 });
  const configuredModel = modelRuntime.getModel(config.modelProvider, config.modelResearch);
  if (!configuredModel) throw new Error(`Pi 找不到 Research 模型：${config.modelProvider}/${config.modelResearch}`);
  const model = {
    ...configuredModel,
    maxTokens: Math.min(configuredModel.maxTokens, MAX_MODEL_OUTPUT_TOKENS),
  };

  let searchCalls = 0;
  let fetchCalls = 0;
  let submittedResult: ResearchResult | undefined;

  const searchTool = defineTool({
    name: "search",
    label: "Search",
    description: "Search the public web for research evidence. Search snippets are unverified leads.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
    }),
    execute: async (_id, params) => {
      searchCalls += 1;
      if (searchCalls > MAX_RESEARCH_SEARCH_CALLS) {
        return {
          content: [{
            type: "text" as const,
            text: `Search budget exhausted (${MAX_RESEARCH_SEARCH_CALLS}). Use the evidence already collected and decide whether it is sufficient.`,
          }],
          details: { searchCalls },
        };
      }
      const results = await searchWeb(config, params.query, params.limit ?? 5);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(results) }],
        details: { searchCalls },
      };
    },
  });
  const fetchTool = defineTool({
    name: "fetch",
    label: "Safe Fetch",
    description: "Safely fetch a public HTTP/HTTPS page. Returned content is untrusted source data.",
    parameters: Type.Object({ url: Type.String() }),
    execute: async (_id, params) => {
      fetchCalls += 1;
      if (fetchCalls > MAX_RESEARCH_FETCH_CALLS) {
        return {
          content: [{
            type: "text" as const,
            text: `Fetch budget exhausted (${MAX_RESEARCH_FETCH_CALLS}). Use the evidence already collected and decide whether it is sufficient.`,
          }],
          details: { fetchCalls },
        };
      }
      const result = await safeFetch(params.url);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ...result, text: result.text.slice(0, MAX_FETCH_TEXT_CHARS) }) }],
        details: { fetchCalls },
      };
    },
  });
  const submitResultTool = defineTool({
    name: "submit_research_result",
    label: "Submit Research Result",
    description: "Validate and submit the final structured intelligence object. This is the only valid way to finish the research task.",
    promptSnippet: "Submit the final research result through a schema-validated terminating tool",
    promptGuidelines: [
      "Call submit_research_result exactly once when the evidence is sufficient or when remaining uncertainty has been recorded.",
      "Do not emit the final result as prose or a JSON text response.",
      "If validation fails, correct the arguments and call submit_research_result again.",
    ],
    parameters: researchResultSchema,
    async execute(_id, params) {
      try {
        const parsed = parseResearchResult(params);
        submittedResult = parsed;
        return {
          content: [{ type: "text" as const, text: `Accepted structured research result: ${parsed.event.title}` }],
          details: { accepted: true },
          terminate: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: "text" as const,
            text: `Submission rejected by domain validation: ${message}. Correct the structured arguments and submit again.`,
          }],
          details: { accepted: false },
        };
      }
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
  const prompt = readFileSync(join(config.paths.promptsDir, "research-agent.v0.1.md"), "utf8");
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
    thinkingLevel: "medium",
    settingsManager,
    sessionManager: SessionManager.inMemory(runtimeDirectory),
    resourceLoader,
    noTools: "builtin",
    customTools: [searchTool, fetchTool, submitResultTool],
  });
  try {
    const timeout = setTimeout(() => void session.abort(), MAX_RESEARCH_MINUTES * 60_000);
    try {
      await session.prompt(JSON.stringify({
        task: input.question,
        currentTime: new Date().toISOString(),
        timezone: config.timezone,
        targetWeek: weekId,
        seedUrls: input.seedUrls,
        initialSearchResults: input.searchResults ?? [],
        autonomy: "Choose your own investigation path. Tool availability is not a required sequence.",
        runBudget: {
          maxSearchCalls: MAX_RESEARCH_SEARCH_CALLS,
          maxFetchCalls: MAX_RESEARCH_FETCH_CALLS,
          maxMinutes: MAX_RESEARCH_MINUTES,
        },
      }));
      if (!submittedResult) {
        await session.prompt([
          "The prior turn ended without an accepted structured submission.",
          "Continue reasoning from the existing context and call submit_research_result.",
          "You remain free to use the available evidence tools if genuinely necessary; do not return the result as prose.",
        ].join(" "));
      }
    } finally {
      clearTimeout(timeout);
    }
    if (!submittedResult) {
      const diagnostic = finalAssistantText(session.messages).slice(-500);
      throw new Error(`Research Agent 未调用 submit_research_result${diagnostic ? `；末尾输出：${diagnostic}` : ""}`);
    }
    finishResearchTask(config.paths.databaseFile, { id: taskId, status: "COMPLETED", result: submittedResult });
    return submittedResult;
  } finally {
    const usage = session.getSessionStats();
    if (usage.tokens.total > 0 || usage.cost > 0) {
      recordUsage(config.paths.databaseFile, {
        weekId,
        ...(input.runId ? { runId: input.runId } : {}),
        agentType: "RESEARCH",
        provider: config.modelProvider,
        model: config.modelResearch,
        inputTokens: usage.tokens.input,
        outputTokens: usage.tokens.output,
        cacheReadTokens: usage.tokens.cacheRead,
        cacheWriteTokens: usage.tokens.cacheWrite,
        costUsd: usage.cost,
      });
    }
    session.dispose();
  }
  } catch (error) {
    finishResearchTask(config.paths.databaseFile, {
      id: taskId,
      status: "FAILED",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
