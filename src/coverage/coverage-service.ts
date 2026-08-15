import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { openDatabase } from "../database.js";
import { searchWeb, type SearchResult } from "../search/search-provider.js";

export interface RegisteredSource {
  id: string;
  name: string;
  sourceType: string;
  region: string;
  topics: string[];
  priority: "P0" | "P1" | "P2";
  scanMode: "SEARCH_QUERY" | "RSS" | "PAGE";
  scanTarget: string;
  enabled: boolean;
  lastSuccessfulScanAt?: string;
}

const DEFAULT_SOURCES: RegisteredSource[] = [
  { id: "openai-news", name: "OpenAI News", sourceType: "OFFICIAL", region: "US", topics: ["models", "agents", "research"], priority: "P0", scanMode: "SEARCH_QUERY", scanTarget: "site:openai.com/news AI", enabled: true },
  { id: "anthropic-news", name: "Anthropic News", sourceType: "OFFICIAL", region: "US", topics: ["models", "agents", "safety"], priority: "P0", scanMode: "SEARCH_QUERY", scanTarget: "site:anthropic.com/news AI", enabled: true },
  { id: "google-deepmind", name: "Google DeepMind", sourceType: "OFFICIAL", region: "US", topics: ["models", "research", "agents"], priority: "P0", scanMode: "SEARCH_QUERY", scanTarget: "site:deepmind.google/discover/blog AI", enabled: true },
  { id: "meta-ai", name: "Meta AI", sourceType: "OFFICIAL", region: "US", topics: ["models", "open-source", "research"], priority: "P0", scanMode: "SEARCH_QUERY", scanTarget: "site:ai.meta.com/blog AI", enabled: true },
  { id: "microsoft-ai", name: "Microsoft AI", sourceType: "OFFICIAL", region: "US", topics: ["agents", "applications", "infrastructure"], priority: "P1", scanMode: "SEARCH_QUERY", scanTarget: "site:blogs.microsoft.com/ai AI", enabled: true },
  { id: "nvidia-ai", name: "NVIDIA AI", sourceType: "OFFICIAL", region: "US", topics: ["chips", "infrastructure", "models"], priority: "P0", scanMode: "SEARCH_QUERY", scanTarget: "site:blogs.nvidia.com AI", enabled: true },
  { id: "huggingface-blog", name: "Hugging Face", sourceType: "OFFICIAL", region: "GLOBAL", topics: ["open-source", "models", "developer-tools"], priority: "P0", scanMode: "SEARCH_QUERY", scanTarget: "site:huggingface.co/blog AI", enabled: true },
  { id: "github-ai", name: "GitHub Changelog", sourceType: "CODE", region: "GLOBAL", topics: ["developer-tools", "agents", "open-source"], priority: "P1", scanMode: "SEARCH_QUERY", scanTarget: "site:github.blog/changelog AI", enabled: true },
  { id: "arxiv-ai", name: "arXiv AI", sourceType: "PAPER", region: "GLOBAL", topics: ["research", "benchmarks"], priority: "P0", scanMode: "SEARCH_QUERY", scanTarget: "site:arxiv.org AI new model benchmark", enabled: true },
  { id: "eu-ai-office", name: "European AI Office", sourceType: "REGULATOR", region: "EU", topics: ["policy", "law", "safety"], priority: "P0", scanMode: "SEARCH_QUERY", scanTarget: "site:digital-strategy.ec.europa.eu AI Office", enabled: true },
  { id: "nist-ai", name: "NIST AI", sourceType: "REGULATOR", region: "US", topics: ["policy", "safety", "standards"], priority: "P1", scanMode: "SEARCH_QUERY", scanTarget: "site:nist.gov artificial intelligence", enabled: true },
  { id: "cac-ai", name: "中国网信办 AI", sourceType: "REGULATOR", region: "CHINA", topics: ["policy", "law", "safety"], priority: "P0", scanMode: "SEARCH_QUERY", scanTarget: "site:cac.gov.cn 人工智能", enabled: true },
  { id: "qwen", name: "Qwen", sourceType: "CODE", region: "CHINA", topics: ["models", "open-source", "agents"], priority: "P0", scanMode: "SEARCH_QUERY", scanTarget: "Qwen official GitHub release model", enabled: true },
  { id: "deepseek", name: "DeepSeek", sourceType: "OFFICIAL", region: "CHINA", topics: ["models", "research", "open-source"], priority: "P0", scanMode: "SEARCH_QUERY", scanTarget: "DeepSeek official model release", enabled: true },
  { id: "baidu-ai", name: "Baidu AI", sourceType: "OFFICIAL", region: "CHINA", topics: ["models", "applications", "agents"], priority: "P1", scanMode: "SEARCH_QUERY", scanTarget: "百度 人工智能 官方 发布", enabled: true },
  { id: "alibaba-cloud-ai", name: "Alibaba Cloud AI", sourceType: "OFFICIAL", region: "CHINA", topics: ["models", "infrastructure", "applications"], priority: "P1", scanMode: "SEARCH_QUERY", scanTarget: "阿里云 人工智能 官方 发布", enabled: true },
  { id: "reuters-ai", name: "Reuters AI", sourceType: "NEWS", region: "GLOBAL", topics: ["business", "policy", "models"], priority: "P0", scanMode: "SEARCH_QUERY", scanTarget: "site:reuters.com artificial intelligence", enabled: true },
];

export interface CoverageReport {
  totalEnabled: number;
  scanned: number;
  neverScanned: number;
  byRegion: Record<string, { total: number; scanned: number }>;
  byTopic: Record<string, { total: number; scanned: number }>;
  staleP0: Array<{ id: string; name: string; scanTarget: string }>;
}

export function seedSourceRegistry(databaseFile: string): void {
  const database = openDatabase(databaseFile);
  const insert = database.prepare(`
    INSERT OR IGNORE INTO source_registry (
      id, name, source_type, region, topics_json, priority, scan_mode, scan_target, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  try {
    for (const source of DEFAULT_SOURCES) {
      insert.run(
        source.id, source.name, source.sourceType, source.region, JSON.stringify(source.topics),
        source.priority, source.scanMode, source.scanTarget, source.enabled ? 1 : 0,
      );
    }
  } finally {
    database.close();
  }
}

export function listSources(databaseFile: string): RegisteredSource[] {
  const database = openDatabase(databaseFile);
  try {
    return database.prepare("SELECT * FROM source_registry WHERE enabled = 1 ORDER BY priority, region, name").all().map((item) => {
      const row = item as Record<string, unknown>;
      return {
        id: String(row.id),
        name: String(row.name),
        sourceType: String(row.source_type),
        region: String(row.region),
        topics: JSON.parse(String(row.topics_json)) as string[],
        priority: String(row.priority) as RegisteredSource["priority"],
        scanMode: String(row.scan_mode) as RegisteredSource["scanMode"],
        scanTarget: String(row.scan_target),
        enabled: Number(row.enabled) === 1,
        ...(row.last_successful_scan_at ? { lastSuccessfulScanAt: String(row.last_successful_scan_at) } : {}),
      };
    });
  } finally {
    database.close();
  }
}

export function getCoverageReport(databaseFile: string): CoverageReport {
  const sources = listSources(databaseFile);
  const byRegion: CoverageReport["byRegion"] = {};
  const byTopic: CoverageReport["byTopic"] = {};
  for (const source of sources) {
    const region = byRegion[source.region] ?? { total: 0, scanned: 0 };
    region.total += 1;
    if (source.lastSuccessfulScanAt) region.scanned += 1;
    byRegion[source.region] = region;
    for (const topic of source.topics) {
      const value = byTopic[topic] ?? { total: 0, scanned: 0 };
      value.total += 1;
      if (source.lastSuccessfulScanAt) value.scanned += 1;
      byTopic[topic] = value;
    }
  }
  return {
    totalEnabled: sources.length,
    scanned: sources.filter((source) => source.lastSuccessfulScanAt).length,
    neverScanned: sources.filter((source) => !source.lastSuccessfulScanAt).length,
    byRegion,
    byTopic,
    staleP0: sources.filter((source) => source.priority === "P0" && !source.lastSuccessfulScanAt)
      .map(({ id, name, scanTarget }) => ({ id, name, scanTarget })),
  };
}

export async function scanNextCoverageSource(config: AppConfig): Promise<{ source: RegisteredSource; results: SearchResult[] }> {
  const sources = listSources(config.paths.databaseFile);
  const source = sources.find((item) => item.priority === "P0" && !item.lastSuccessfulScanAt)
    ?? sources.find((item) => !item.lastSuccessfulScanAt)
    ?? sources.sort((a, b) => String(a.lastSuccessfulScanAt).localeCompare(String(b.lastSuccessfulScanAt)))[0];
  if (!source) throw new Error("Source Registry 为空");
  const startedAt = new Date().toISOString();
  try {
    const results = await searchWeb(config, source.scanTarget, 10);
    const database = openDatabase(config.paths.databaseFile);
    try {
      const finished = new Date().toISOString();
      database.prepare("UPDATE source_registry SET last_successful_scan_at = ? WHERE id = ?").run(finished, source.id);
      database.prepare(`
        INSERT INTO source_scan_runs (id, source_id, status, result_count, started_at, finished_at)
        VALUES (?, ?, 'COMPLETED', ?, ?, ?)
      `).run(randomUUID(), source.id, results.length, startedAt, finished);
    } finally {
      database.close();
    }
    return { source, results };
  } catch (error) {
    const database = openDatabase(config.paths.databaseFile);
    try {
      database.prepare(`
        INSERT INTO source_scan_runs (id, source_id, status, result_count, error, started_at, finished_at)
        VALUES (?, ?, 'FAILED', 0, ?, ?, ?)
      `).run(randomUUID(), source.id, error instanceof Error ? error.message : String(error), startedAt, new Date().toISOString());
    } finally {
      database.close();
    }
    throw error;
  }
}
