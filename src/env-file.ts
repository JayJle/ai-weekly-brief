import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export type EnvMap = Record<string, string>;

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll("\\n", "\n").replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseEnvFile(content: string): EnvMap {
  const result: EnvMap = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) continue;
    result[key] = unquote(line.slice(separator + 1).trim());
  }
  return result;
}

export function readEnvFile(path: string): EnvMap {
  return existsSync(path) ? parseEnvFile(readFileSync(path, "utf8")) : {};
}

function quote(value: string): string {
  if (/^[A-Za-z0-9_./,:@+-]*$/u.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

export function serializeEnv(values: EnvMap): string {
  return [
    "# 由 npm run setup 生成。不要提交到 Git。",
    ...Object.entries(values).map(([key, value]) => `${key}=${quote(value)}`),
    "",
  ].join("\n");
}

export function backupAndWriteEnv(path: string, values: EnvMap): string | undefined {
  let backupPath: string | undefined;
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replaceAll(":", "-");
    backupPath = `${path}.backup-${stamp}`;
    copyFileSync(path, backupPath);
  }
  writeFileSync(path, serializeEnv(values), { encoding: "utf8", mode: 0o600 });
  return backupPath;
}

export function applyEnv(values: EnvMap): void {
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
