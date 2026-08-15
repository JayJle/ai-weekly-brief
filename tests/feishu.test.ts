import assert from "node:assert/strict";
import test from "node:test";
import { sendFeishu } from "../src/notifications/feishu.js";

test("feishu rejects non-official webhook URLs before network access", async () => {
  await assert.rejects(
    sendFeishu("https://example.com/hook/test", { title: "test", markdown: "test" }),
    /官方自定义机器人/u,
  );
});

test("feishu sends a JSON 2.0 interactive card", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook");
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json; charset=utf-8");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ code: 0, msg: "success", data: { message_id: "om_test" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const result = await sendFeishu(
      "https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook",
      { title: "AI Weekly Brief", markdown: "# Test\n\nContent" },
    );
    assert.equal(requestBody?.msg_type, "interactive");
    assert.equal((requestBody?.card as { schema?: string } | undefined)?.schema, "2.0");
    assert.equal(result.provider, "feishu");
    assert.equal(result.messageId, "om_test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
