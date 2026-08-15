import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { logEvent, redact } from "../src/observability/logger.js";

test("structured logger redacts credential-shaped fields and values", () => {
  const webhook = "https://open.feishu.cn/open-apis/bot/v2/hook/secret-hook-id";
  const redacted = redact({ apiKey: "secret", message: `Bearer abc.def ${webhook}`, nested: { webhookUrl: webhook } });
  assert.equal(JSON.stringify(redacted).includes("secret"), false);
  assert.equal(JSON.stringify(redacted).includes("secret-hook-id"), false);

  const directory = mkdtempSync(join(tmpdir(), "awb-log-"));
  try {
    logEvent(directory, "info", "test.event", { token: "hidden", ok: true });
    const file = join(directory, `app-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const row = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(row.event, "test.event");
    assert.equal(row.token, "[REDACTED]");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
