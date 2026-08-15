import type { AppConfig } from "../config.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
    }>;
  };
}

interface TavilySearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    published_date?: string;
  }>;
}

async function searchTavily(apiKey: string, query: string, limit: number): Promise<SearchResult[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: Math.min(Math.max(limit, 1), 20),
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Tavily Search HTTP ${response.status}`);
  const payload = await response.json() as TavilySearchResponse;
  return (payload.results ?? []).flatMap((item) => {
    if (!item.title || !item.url) return [];
    const result: SearchResult = {
      title: item.title,
      url: item.url,
      snippet: item.content ?? "",
    };
    if (item.published_date && Number.isFinite(Date.parse(item.published_date))) {
      result.publishedAt = new Date(item.published_date).toISOString();
    }
    return [result];
  });
}

async function searchBrave(apiKey: string, query: string, limit: number): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(Math.max(limit, 1), 20)));
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Brave Search HTTP ${response.status}`);

  const payload = await response.json() as BraveSearchResponse;
  return (payload.web?.results ?? []).flatMap((item) => {
    if (!item.title || !item.url) return [];
    const result: SearchResult = {
      title: item.title,
      url: item.url,
      snippet: item.description ?? "",
    };
    if (item.age && Number.isFinite(Date.parse(item.age))) result.publishedAt = new Date(item.age).toISOString();
    return [result];
  });
}

export async function searchWeb(
  config: AppConfig,
  query: string,
  limit = 5,
): Promise<SearchResult[]> {
  if (config.searchProvider === "mock") {
    return [{
      title: "Mock AI event",
      url: "https://example.com/mock-ai-event",
      snippet: `Mock search result for: ${query}`,
      publishedAt: new Date().toISOString(),
    }];
  }

  if (!config.searchApiKey) throw new Error("缺少 SEARCH_API_KEY");
  if (config.searchProvider === "tavily") return searchTavily(config.searchApiKey, query, limit);
  return searchBrave(config.searchApiKey, query, limit);
}
