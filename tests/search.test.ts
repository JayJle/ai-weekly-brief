import assert from "node:assert/strict";
import test from "node:test";
import { createAppPaths, findProjectRoot } from "../src/app-paths.js";
import type { AppConfig } from "../src/config.js";
import { searchWeb } from "../src/search/search-provider.js";

test("mock search returns deterministic structured result", async () => {
  const config: AppConfig = {
    paths: createAppPaths(findProjectRoot()),
    modelProvider: "mock",
    modelMain: "mock-main",
    modelResearch: "mock-research",
    searchProvider: "mock",
    timezone: "Asia/Shanghai",
    runMode: "DRY_RUN",
    weeklyBudgetUsd: 10,
    heartbeatTimes: ["08:00"],
    publishWeekday: 1,
    publishTime: "08:30",
    logLevel: "info",
  };
  const results = await searchWeb(config, "test query");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.url, "https://example.com/mock-ai-event");
  assert.match(results[0]?.snippet ?? "", /test query/u);
});

test("Tavily adapter sends a bounded basic search and maps structured results", async () => {
  const config: AppConfig = {
    paths: createAppPaths(findProjectRoot()),
    modelProvider: "mock",
    modelMain: "mock-main",
    modelResearch: "mock-research",
    searchProvider: "tavily",
    searchApiKey: "tvly-test-key",
    timezone: "Asia/Shanghai",
    runMode: "DRY_RUN",
    weeklyBudgetUsd: 10,
    heartbeatTimes: ["08:00"],
    publishWeekday: 1,
    publishTime: "08:30",
    logLevel: "info",
  };
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  let authorization = "";
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://api.tavily.com/search");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({
        results: [{
          title: "Official release",
          url: "https://example.com/release",
          content: "A structured Tavily snippet.",
          published_date: "2026-08-15T00:00:00Z",
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const results = await searchWeb(config, "AI release", 50);
    assert.equal(authorization, "Bearer tvly-test-key");
    assert.equal(requestBody?.search_depth, "basic");
    assert.equal(requestBody?.max_results, 20);
    assert.equal(requestBody?.include_raw_content, false);
    assert.equal(results[0]?.snippet, "A structured Tavily snippet.");
    assert.equal(results[0]?.publishedAt, "2026-08-15T00:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
