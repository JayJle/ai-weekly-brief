export interface NotificationResult {
  provider: "feishu";
  messageId?: string;
}

interface FeishuWebhookResponse {
  code?: number;
  msg?: string;
  StatusCode?: number;
  StatusMessage?: string;
  data?: { message_id?: string };
}

export function validateFeishuWebhookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("飞书 Webhook URL 格式无效");
  }
  const allowedHost = url.hostname === "open.feishu.cn" || url.hostname === "open.larksuite.com";
  const validPath = /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/u.test(url.pathname);
  if (url.protocol !== "https:" || !allowedHost || !validPath || url.search || url.hash || url.username || url.password) {
    throw new Error("飞书 Webhook URL 必须是官方自定义机器人 v2 地址");
  }
  return url;
}

export async function sendFeishu(
  webhookUrl: string,
  input: { title: string; markdown: string },
): Promise<NotificationResult> {
  const url = validateFeishuWebhookUrl(webhookUrl);
  const title = input.title.replaceAll(/\r?\n/gu, " ").trim();
  const markdown = input.markdown.trim();
  if (!title) throw new Error("飞书消息标题不能为空");
  if (!markdown) throw new Error("飞书消息正文不能为空");
  if (title.length > 200) throw new Error("飞书消息标题过长");

  const payload = {
    msg_type: "interactive",
    card: {
      schema: "2.0",
      config: { update_multi: true },
      body: {
        direction: "vertical",
        padding: "12px 12px 12px 12px",
        elements: [{
          tag: "markdown",
          content: markdown,
          text_align: "left",
          text_size: "normal_v2",
          margin: "0px 0px 0px 0px",
        }],
      },
      header: {
        title: { tag: "plain_text", content: title },
        template: "blue",
        padding: "12px 12px 12px 12px",
      },
    },
  };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > 30_000) {
    throw new Error("飞书卡片请求体超过 30 KB，请缩短周报内容");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const responseText = await response.text();
  let result: FeishuWebhookResponse | undefined;
  try {
    result = JSON.parse(responseText) as FeishuWebhookResponse;
  } catch {
    // Preserve a bounded transport diagnostic below.
  }
  if (!response.ok) {
    const diagnostic = result?.msg ?? result?.StatusMessage ?? responseText.replaceAll(/\s+/gu, " ").trim().slice(0, 300);
    throw new Error(`飞书 Webhook HTTP ${response.status}${diagnostic ? `：${diagnostic}` : ""}`);
  }
  if (!result) throw new Error("飞书 Webhook 返回了无法解析的响应");
  const code = result.code ?? result.StatusCode;
  if (code !== 0) {
    throw new Error(`飞书发送失败：${result.msg ?? result.StatusMessage ?? `code=${String(code)}`}`);
  }
  const output: NotificationResult = { provider: "feishu" };
  if (result.data?.message_id) output.messageId = result.data.message_id;
  return output;
}
