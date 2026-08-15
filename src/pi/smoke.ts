import { mkdirSync } from "node:fs";
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

export async function runPiSmoke(config: AppConfig): Promise<{ toolCalled: boolean; model: string }> {
  if (config.modelProvider === "mock") {
    return { toolCalled: true, model: "mock (未调用外部模型)" };
  }

  const runtimeDirectory = join(config.paths.dataDir, "pi-runtime");
  const agentDirectory = join(config.paths.dataDir, "pi-agent");
  mkdirSync(runtimeDirectory, { recursive: true });
  mkdirSync(agentDirectory, { recursive: true });

  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: true,
    modelRefreshTimeoutMs: 15_000,
  });
  const model = modelRuntime.getModel(config.modelProvider, config.modelMain);
  if (!model) {
    throw new Error(`Pi 找不到模型：${config.modelProvider}/${config.modelMain}`);
  }

  let toolCalled = false;
  const healthTool = defineTool({
    name: "health_check",
    label: "Health Check",
    description: "Return the application health status. Always call this tool for a smoke test.",
    parameters: Type.Object({
      message: Type.String({ description: "A short test message" }),
    }),
    execute: async (_toolCallId, params) => {
      toolCalled = true;
      return {
        content: [{ type: "text" as const, text: `healthy: ${params.message}` }],
        details: { ok: true },
      };
    },
  });

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 500 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: runtimeDirectory,
    agentDir: agentDirectory,
    settingsManager,
    systemPromptOverride: () => [
      "You are a connectivity smoke-test agent.",
      "You must call the health_check tool exactly once, then finish.",
      "Do not perform any other action.",
    ].join("\n"),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    skillsOverride: (current) => ({ skills: [], diagnostics: current.diagnostics }),
    promptsOverride: (current) => ({ prompts: [], diagnostics: current.diagnostics }),
  });
  await resourceLoader.reload();

  const { session, extensionsResult } = await createAgentSession({
    cwd: runtimeDirectory,
    agentDir: agentDirectory,
    model,
    modelRuntime,
    thinkingLevel: "low",
    settingsManager,
    sessionManager: SessionManager.inMemory(runtimeDirectory),
    resourceLoader,
    noTools: "builtin",
    customTools: [healthTool],
  });
  try {
    if (extensionsResult.errors.length > 0) {
      throw new Error(`Pi 资源加载失败：${extensionsResult.errors.map((item) => item.error).join("; ")}`);
    }
    const timeout = setTimeout(() => void session.abort(), 60_000);
    try {
      await session.prompt("Run the health check now.");
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    session.dispose();
  }

  if (!toolCalled) throw new Error("Pi 返回了响应，但没有调用 health_check 工具");
  return { toolCalled, model: `${config.modelProvider}/${config.modelMain}` };
}
