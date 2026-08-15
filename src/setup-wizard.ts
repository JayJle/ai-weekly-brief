import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createAppPaths, type AppPaths } from "./app-paths.js";
import { MODEL_PROVIDER_DEFINITIONS, type ModelProvider } from "./config.js";
import { backupAndWriteEnv, readEnvFile, type EnvMap } from "./env-file.js";
import { migrateDatabase } from "./database.js";
import { seedSourceRegistry } from "./coverage/coverage-service.js";

async function askText(label: string, defaultValue = ""): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const readline = createInterface({ input, output });
  try {
    const answer = (await readline.question(`${label}${suffix}: `)).trim();
    return answer || defaultValue;
  } finally {
    readline.close();
  }
}

async function askSecret(label: string, currentValue = ""): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return askText(`${label}（当前终端无法隐藏输入）`, currentValue);
  }

  output.write(`${label}${currentValue ? " [回车保留现有值]" : ""}: `);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const onData = (chunk: string | Buffer) => {
      const text = chunk.toString();
      for (const character of text) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("用户取消配置"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          output.write("\n");
          resolve(value || currentValue);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        if (character >= " ") {
          value += character;
          output.write("*");
        }
      }
    };
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
    };
    input.on("data", onData);
  });
}

async function choose(label: string, options: Array<{ label: string; value: string }>, defaultValue: string): Promise<string> {
  output.write(`\n${label}\n`);
  options.forEach((option, index) => output.write(`  ${index + 1}. ${option.label}${option.value === defaultValue ? "（默认）" : ""}\n`));
  const defaultIndex = Math.max(0, options.findIndex((option) => option.value === defaultValue));
  const answer = await askText("请输入序号", String(defaultIndex + 1));
  const selected = options[Number(answer) - 1];
  if (!selected) throw new Error(`无效选项：${answer}`);
  return selected.value;
}

export async function runSetupWizard(paths: AppPaths): Promise<{ backupPath?: string }> {
  const existing = readEnvFile(paths.envFile);
  output.write("\nAI Weekly Brief 初始化向导\n");
  output.write(`项目目录：${paths.projectRoot}\n`);
  output.write("密钥只会写入本机 .env，不会提交到 Git。\n");

  const modelProvider = await choose(
    "请选择模型提供商",
    Object.entries(MODEL_PROVIDER_DEFINITIONS).map(([value, definition]) => ({
      label: definition.label,
      value,
    })),
    existing.MODEL_PROVIDER ?? "mock",
  ) as ModelProvider;

  const providerDefinition = MODEL_PROVIDER_DEFINITIONS[modelProvider];
  const modelKeyName = providerDefinition.keyEnv;
  let modelApiKey = "";
  if (modelKeyName) modelApiKey = await askSecret("请输入模型 API Key", existing[modelKeyName] ?? "");

  const providerChanged = existing.MODEL_PROVIDER !== undefined && existing.MODEL_PROVIDER !== modelProvider;
  const defaultMain = providerChanged ? providerDefinition.mainModel : (existing.MODEL_MAIN ?? providerDefinition.mainModel);
  const defaultResearch = providerChanged ? providerDefinition.researchModel : (existing.MODEL_RESEARCH ?? providerDefinition.researchModel);
  const modelMain = await askText("Main Agent 模型 ID", defaultMain);
  if (!modelMain) throw new Error("Main Agent 模型 ID 不能为空");
  const modelResearch = await askText("Research Agent 模型 ID", defaultResearch || modelMain);

  const searchProvider = await choose("请选择搜索服务", [
    { label: "Mock（离线测试）", value: "mock" },
    { label: "Tavily Search API（适合 Agent 研究）", value: "tavily" },
    { label: "Brave Search API", value: "brave" },
  ], existing.SEARCH_PROVIDER ?? "mock");
  const searchApiKey = searchProvider === "mock"
    ? ""
    : await askSecret("请输入搜索 API Key", existing.SEARCH_API_KEY ?? "");
  const feishuWebhookUrl = await askSecret("请输入飞书群自定义机器人 Webhook URL（可暂时留空）", existing.FEISHU_WEBHOOK_URL ?? "");

  const runMode = await choose("请选择运行模式", [
    { label: "DRY_RUN：只生成结果，不发飞书", value: "DRY_RUN" },
    { label: "APPROVAL：确认后发送到飞书", value: "APPROVAL" },
    { label: "AUTO：自动发送到飞书", value: "AUTO" },
  ], existing.RUN_MODE ?? "DRY_RUN");

  const timezone = await askText("时区", existing.APP_TIMEZONE ?? "Asia/Shanghai");
  const weeklyBudget = await askText("每周最高预算（美元）", existing.WEEKLY_BUDGET_USD ?? "10");
  const heartbeatTimes = await askText("每天唤醒时间（逗号分隔）", existing.HEARTBEAT_TIMES ?? "08:00,20:00");
  const publishWeekday = await askText("周报发送星期（0=周日，1=周一）", existing.PUBLISH_WEEKDAY ?? "1");
  const publishTime = await askText("周报发送时间", existing.PUBLISH_TIME ?? "08:30");

  const values: EnvMap = {
    MODEL_PROVIDER: modelProvider,
    MODEL_MAIN: modelMain,
    MODEL_RESEARCH: modelResearch,
    SEARCH_PROVIDER: searchProvider,
    SEARCH_API_KEY: searchApiKey,
    FEISHU_WEBHOOK_URL: feishuWebhookUrl,
    APP_TIMEZONE: timezone,
    RUN_MODE: runMode,
    WEEKLY_BUDGET_USD: weeklyBudget,
    DATA_DIR: existing.DATA_DIR ?? "./data",
    DATABASE_PATH: existing.DATABASE_PATH ?? "./data/weekly.db",
    HEARTBEAT_TIMES: heartbeatTimes,
    PUBLISH_WEEKDAY: publishWeekday,
    PUBLISH_TIME: publishTime,
    LOG_LEVEL: existing.LOG_LEVEL ?? "info",
  };
  if (modelKeyName) values[modelKeyName] = modelApiKey;

  const backupPath = backupAndWriteEnv(paths.envFile, values);
  const configuredPaths = createAppPaths(paths.projectRoot, {
    dataDir: values.DATA_DIR,
    databasePath: values.DATABASE_PATH,
  });
  mkdirSync(configuredPaths.dataDir, { recursive: true });
  migrateDatabase(configuredPaths.databaseFile);
  seedSourceRegistry(configuredPaths.databaseFile);
  output.write("\n配置文件已生成，数据库已初始化。\n");
  if (backupPath) output.write(`旧配置备份：${backupPath}\n`);
  output.write("下一步运行：npm run config:check\n");
  const result: { backupPath?: string } = {};
  if (backupPath) result.backupPath = backupPath;
  return result;
}
