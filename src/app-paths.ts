import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface AppPaths {
  projectRoot: string;
  envFile: string;
  dataDir: string;
  databaseFile: string;
  promptsDir: string;
  logsDir: string;
}

function isProjectRoot(directory: string): boolean {
  const packageFile = join(directory, "package.json");
  if (!existsSync(packageFile)) return false;

  try {
    const parsed = JSON.parse(readFileSync(packageFile, "utf8")) as { name?: string };
    return parsed.name === "ai-weekly-brief";
  } catch {
    return false;
  }
}

export function findProjectRoot(startDirectory = process.cwd()): string {
  const configured = process.env.AI_WEEKLY_BRIEF_ROOT;
  if (configured) {
    const root = resolve(configured);
    if (!isProjectRoot(root)) {
      throw new Error(`AI_WEEKLY_BRIEF_ROOT 不是有效的项目目录：${root}`);
    }
    return root;
  }

  const starts = [resolve(startDirectory), dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let current = start;
    while (true) {
      if (isProjectRoot(current)) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  throw new Error("无法定位项目根目录。请在项目目录中运行命令。 ");
}

export function resolveFromRoot(projectRoot: string, value: string): string {
  return isAbsolute(value) ? value : resolve(projectRoot, value);
}

export function createAppPaths(
  projectRoot = findProjectRoot(),
  values: { dataDir?: string | undefined; databasePath?: string | undefined } = {},
): AppPaths {
  const dataDir = resolveFromRoot(projectRoot, values.dataDir ?? "./data");
  return {
    projectRoot,
    envFile: join(projectRoot, ".env"),
    dataDir,
    databaseFile: resolveFromRoot(projectRoot, values.databasePath ?? "./data/weekly.db"),
    promptsDir: join(projectRoot, "prompts"),
    logsDir: join(projectRoot, "logs"),
  };
}
