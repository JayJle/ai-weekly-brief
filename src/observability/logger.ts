import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SENSITIVE_KEY = /(?:api[_-]?key|webhook|secret|token|authorization|cookie|password)/iu;

function redactString(value: string): string {
  return value
    .replaceAll(/https:\/\/(?:open\.feishu\.cn|open\.larksuite\.com)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+/gu, "[REDACTED_FEISHU_WEBHOOK]")
    .replaceAll(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_API_KEY]")
    .replaceAll(/Bearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]");
}

export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item),
  ]));
}

export function logEvent(
  logsDirectory: string,
  level: "debug" | "info" | "warn" | "error",
  event: string,
  details: Record<string, unknown> = {},
): void {
  mkdirSync(logsDirectory, { recursive: true });
  const now = new Date();
  const line = JSON.stringify(redact({
    timestamp: now.toISOString(),
    level,
    event,
    ...details,
  }));
  appendFileSync(join(logsDirectory, `app-${now.toISOString().slice(0, 10)}.jsonl`), `${line}\n`, "utf8");
}
