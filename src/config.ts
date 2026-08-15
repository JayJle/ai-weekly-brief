import { createAppPaths, type AppPaths } from "./app-paths.js";
import { applyEnv, readEnvFile } from "./env-file.js";
import { validateFeishuWebhookUrl } from "./notifications/feishu.js";

export const MODEL_PROVIDER_DEFINITIONS = {
  mock: { label: "Mock（离线测试）", keyEnv: undefined, mainModel: "mock-main", researchModel: "mock-research" },
  deepseek: { label: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY", mainModel: "deepseek-v4-pro", researchModel: "deepseek-v4-flash" },
  openai: { label: "OpenAI", keyEnv: "OPENAI_API_KEY", mainModel: "gpt-5.4-mini", researchModel: "gpt-5.4-mini" },
  anthropic: { label: "Anthropic Claude", keyEnv: "ANTHROPIC_API_KEY", mainModel: "claude-sonnet-4-6", researchModel: "claude-haiku-4-5" },
  google: { label: "Google Gemini", keyEnv: "GEMINI_API_KEY", mainModel: "gemini-2.5-flash", researchModel: "gemini-2.5-flash" },
  openrouter: { label: "OpenRouter（一个 Key 使用多家模型）", keyEnv: "OPENROUTER_API_KEY", mainModel: "openai/gpt-5.4-mini", researchModel: "google/gemini-2.5-flash" },
  xai: { label: "xAI Grok", keyEnv: "XAI_API_KEY", mainModel: "grok-4.3", researchModel: "grok-4.3" },
  groq: { label: "Groq", keyEnv: "GROQ_API_KEY", mainModel: "openai/gpt-oss-120b", researchModel: "qwen/qwen3-32b" },
  mistral: { label: "Mistral", keyEnv: "MISTRAL_API_KEY", mainModel: "devstral-medium-latest", researchModel: "codestral-latest" },
  moonshotai: { label: "Moonshot/Kimi", keyEnv: "MOONSHOT_API_KEY", mainModel: "kimi-k2.6", researchModel: "kimi-k2.6" },
  zai: { label: "智谱/Z.ai", keyEnv: "ZAI_API_KEY", mainModel: "glm-5.1", researchModel: "glm-4.7" },
  nvidia: { label: "NVIDIA NIM", keyEnv: "NVIDIA_API_KEY", mainModel: "nvidia/nemotron-3-super-120b-a12b", researchModel: "openai/gpt-oss-120b" },
  cerebras: { label: "Cerebras", keyEnv: "CEREBRAS_API_KEY", mainModel: "zai-glm-4.7", researchModel: "gpt-oss-120b" },
  fireworks: { label: "Fireworks AI", keyEnv: "FIREWORKS_API_KEY", mainModel: "accounts/fireworks/models/kimi-k2p6", researchModel: "accounts/fireworks/models/deepseek-v4-flash" },
  together: { label: "Together AI", keyEnv: "TOGETHER_API_KEY", mainModel: "moonshotai/Kimi-K2.6", researchModel: "openai/gpt-oss-120b" },
} as const;

export type ModelProvider = keyof typeof MODEL_PROVIDER_DEFINITIONS;
export type SearchProvider = "mock" | "tavily" | "brave";
export type RunMode = "DRY_RUN" | "APPROVAL" | "AUTO";

export interface AppConfig {
  paths: AppPaths;
  modelProvider: ModelProvider;
  modelMain: string;
  modelResearch: string;
  searchProvider: SearchProvider;
  searchApiKey?: string;
  feishuWebhookUrl?: string;
  timezone: string;
  runMode: RunMode;
  weeklyBudgetUsd: number;
  heartbeatTimes: string[];
  publishWeekday: number;
  publishTime: string;
  logLevel: string;
}

function isTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

export function loadConfig(projectRoot?: string): AppConfig {
  const initialPaths = createAppPaths(projectRoot);
  const fileValues = readEnvFile(initialPaths.envFile);
  applyEnv(fileValues);
  const paths = createAppPaths(initialPaths.projectRoot, {
    dataDir: process.env.DATA_DIR,
    databasePath: process.env.DATABASE_PATH,
  });

  const config: AppConfig = {
    paths,
    modelProvider: (process.env.MODEL_PROVIDER ?? "mock") as ModelProvider,
    modelMain: process.env.MODEL_MAIN ?? "mock-main",
    modelResearch: process.env.MODEL_RESEARCH ?? "mock-research",
    searchProvider: (process.env.SEARCH_PROVIDER ?? "mock") as SearchProvider,
    timezone: process.env.APP_TIMEZONE ?? "Asia/Shanghai",
    runMode: (process.env.RUN_MODE ?? "DRY_RUN") as RunMode,
    weeklyBudgetUsd: Number(process.env.WEEKLY_BUDGET_USD ?? "10"),
    heartbeatTimes: (process.env.HEARTBEAT_TIMES ?? "08:00,20:00").split(",").map((item) => item.trim()),
    publishWeekday: Number(process.env.PUBLISH_WEEKDAY ?? "1"),
    publishTime: process.env.PUBLISH_TIME ?? "08:30",
    logLevel: process.env.LOG_LEVEL ?? "info",
  };

  if (process.env.SEARCH_API_KEY) config.searchApiKey = process.env.SEARCH_API_KEY;
  if (process.env.FEISHU_WEBHOOK_URL) config.feishuWebhookUrl = process.env.FEISHU_WEBHOOK_URL;
  return config;
}

export function validateConfig(config: AppConfig): string[] {
  const issues: string[] = [];
  if (!Object.hasOwn(MODEL_PROVIDER_DEFINITIONS, config.modelProvider)) {
    issues.push(`不支持的 MODEL_PROVIDER：${config.modelProvider}`);
  }
  if (!config.modelMain) issues.push("MODEL_MAIN 不能为空");
  if (!config.modelResearch) issues.push("MODEL_RESEARCH 不能为空");
  if (!(["mock", "tavily", "brave"] as string[]).includes(config.searchProvider)) {
    issues.push(`不支持的 SEARCH_PROVIDER：${config.searchProvider}`);
  }
  if (config.searchProvider !== "mock" && !config.searchApiKey) {
    issues.push("真实搜索服务需要 SEARCH_API_KEY");
  }
  if (!(["DRY_RUN", "APPROVAL", "AUTO"] as string[]).includes(config.runMode)) {
    issues.push(`不支持的 RUN_MODE：${config.runMode}`);
  }
  if (config.runMode !== "DRY_RUN" && !config.feishuWebhookUrl) {
    issues.push(`${config.runMode} 模式需要 FEISHU_WEBHOOK_URL`);
  }
  if (config.feishuWebhookUrl) {
    try {
      validateFeishuWebhookUrl(config.feishuWebhookUrl);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!Number.isFinite(config.weeklyBudgetUsd) || config.weeklyBudgetUsd <= 0) {
    issues.push("WEEKLY_BUDGET_USD 必须是大于 0 的数字");
  }
  if (config.heartbeatTimes.length === 0 || config.heartbeatTimes.some((time) => !isTime(time))) {
    issues.push("HEARTBEAT_TIMES 必须是逗号分隔的 HH:mm，例如 08:00,20:00");
  }
  if (!Number.isInteger(config.publishWeekday) || config.publishWeekday < 0 || config.publishWeekday > 6) {
    issues.push("PUBLISH_WEEKDAY 必须是 0–6，0 表示周日，1 表示周一");
  }
  if (!isTime(config.publishTime)) issues.push("PUBLISH_TIME 必须是 HH:mm");
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: config.timezone }).format(new Date());
  } catch {
    issues.push(`无效时区：${config.timezone}`);
  }

  const providerDefinition = MODEL_PROVIDER_DEFINITIONS[config.modelProvider];
  const keyEnvironmentName = providerDefinition?.keyEnv;
  if (keyEnvironmentName && !process.env[keyEnvironmentName]) {
    issues.push(`${config.modelProvider} 模型需要 ${keyEnvironmentName}`);
  }
  return issues;
}

export function publicConfigSummary(config: AppConfig): Record<string, unknown> {
  return {
    projectRoot: config.paths.projectRoot,
    envFile: config.paths.envFile,
    databaseFile: config.paths.databaseFile,
    modelProvider: config.modelProvider,
    modelMain: config.modelMain,
    modelResearch: config.modelResearch,
    searchProvider: config.searchProvider,
    feishuConfigured: Boolean(config.feishuWebhookUrl),
    timezone: config.timezone,
    runMode: config.runMode,
    weeklyBudgetUsd: config.weeklyBudgetUsd,
    heartbeatTimes: config.heartbeatTimes,
    publish: `${config.publishWeekday} ${config.publishTime}`,
  };
}
