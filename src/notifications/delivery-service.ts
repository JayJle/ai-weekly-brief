import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { getFormalWeekUsage, openDatabase } from "../database.js";
import { appendUsageFooter } from "../usage/usage-footer.js";
import { sendFeishu } from "./feishu.js";

export async function deliverBrief(
  config: AppConfig,
  input: { briefId: string; weekId: string; version: number; markdown: string },
): Promise<{ status: "SENT" | "SKIPPED"; messageId?: string }> {
  if (!config.feishuWebhookUrl) throw new Error("缺少 FEISHU_WEBHOOK_URL");
  const database = openDatabase(config.paths.databaseFile);
  const existing = database.prepare(`
    SELECT status, provider_message_id FROM weekly_deliveries
    WHERE week_id = ? AND brief_version = ? AND channel = 'FEISHU'
  `).get(input.weekId, input.version) as { status: string; provider_message_id: string | null } | undefined;
  if (existing?.status === "SENT") {
    database.close();
    const skipped: { status: "SKIPPED"; messageId?: string } = { status: "SKIPPED" };
    if (existing.provider_message_id) skipped.messageId = existing.provider_message_id;
    return skipped;
  }
  if (existing?.status === "SENDING" || existing?.status === "UNKNOWN") {
    database.close();
    throw new Error("该周报上次发送结果不确定。为避免飞书重复消息，请先人工核对后再处理发送记录。");
  }
  const deliveryId = randomUUID();
  try {
    database.prepare(`
      INSERT INTO weekly_deliveries (
        id, week_id, brief_version, channel, status, created_at
      ) VALUES (?, ?, ?, 'FEISHU', 'SENDING', ?)
    `).run(deliveryId, input.weekId, input.version, new Date().toISOString());
  } finally {
    database.close();
  }

  try {
    const sent = await sendFeishu(config.feishuWebhookUrl, {
      title: `AI Weekly Brief · ${input.weekId}`,
      markdown: appendUsageFooter(
        input.markdown,
        getFormalWeekUsage(config.paths.databaseFile, input.weekId),
        "本期周报生成累计",
      ),
    });
    const update = openDatabase(config.paths.databaseFile);
    try {
      update.prepare(`
        UPDATE weekly_deliveries SET status = 'SENT', provider_message_id = ?, sent_at = ? WHERE id = ?
      `).run(sent.messageId ?? null, new Date().toISOString(), deliveryId);
    } finally {
      update.close();
    }
    const result: { status: "SENT"; messageId?: string } = { status: "SENT" };
    if (sent.messageId) result.messageId = sent.messageId;
    return result;
  } catch (error) {
    const update = openDatabase(config.paths.databaseFile);
    try {
      update.prepare("UPDATE weekly_deliveries SET status = 'UNKNOWN' WHERE id = ?").run(deliveryId);
    } finally {
      update.close();
    }
    throw error;
  }
}
