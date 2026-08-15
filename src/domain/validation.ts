import {
  EVENT_ACTIONS,
  type EventScores,
  type ResearchResult,
  type SourceType,
} from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path} 必须是非空字符串`);
  return value.trim();
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${path} 必须是非空数组`);
  return value.map((item, index) => requireString(item, `${path}[${index}]`));
}

function requireScore(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error(`${path} 必须是 1–10 的整数`);
  }
  return value;
}

function requireHttpUrl(value: unknown, path: string): string {
  const text = requireString(value, path);
  try {
    const url = new URL(text);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${path} 必须是安全的 HTTP/HTTPS URL`);
  }
}

function optionalIsoDate(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = requireString(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T/iu.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new Error(`${path} 必须是 ISO-8601 时间`);
  }
  return text;
}

function parseScores(value: unknown): EventScores {
  if (!isObject(value)) throw new Error("scores 必须是对象");
  return {
    novelty: requireScore(value.novelty, "scores.novelty"),
    importance: requireScore(value.importance, "scores.importance"),
    disruption: requireScore(value.disruption, "scores.disruption"),
    confidence: requireScore(value.confidence, "scores.confidence"),
  };
}

const sourceTypes = new Set<SourceType>(["OFFICIAL", "PAPER", "CODE", "REGULATOR", "NEWS", "SOCIAL", "OTHER"]);
const evidenceLevels = new Set(["PRIMARY", "CORROBORATED", "SECONDARY", "WEAK"]);

export function parseResearchResult(value: unknown): ResearchResult {
  if (!isObject(value)) throw new Error("ResearchResult 必须是对象");
  if (!isObject(value.event)) throw new Error("event 必须是对象");
  if (!isObject(value.event.identity)) throw new Error("event.identity 必须是对象");
  const action = requireString(value.event.identity.action, "event.identity.action");
  if (!(EVENT_ACTIONS as readonly string[]).includes(action)) throw new Error(`不支持的 EventAction：${action}`);

  if (!Array.isArray(value.sources) || value.sources.length === 0) throw new Error("sources 至少需要一项");
  const sources = value.sources.map((source, index) => {
    if (!isObject(source)) throw new Error(`sources[${index}] 必须是对象`);
    const sourceType = requireString(source.sourceType, `sources[${index}].sourceType`) as SourceType;
    if (!sourceTypes.has(sourceType)) throw new Error(`不支持的 SourceType：${sourceType}`);
    const trustTier = source.trustTier;
    if (trustTier !== 1 && trustTier !== 2 && trustTier !== 3 && trustTier !== 4) {
      throw new Error(`sources[${index}].trustTier 必须是 1–4`);
    }
    const parsed = {
      publisher: requireString(source.publisher, `sources[${index}].publisher`),
      url: requireHttpUrl(source.url, `sources[${index}].url`),
      sourceType,
      trustTier: trustTier as 1 | 2 | 3 | 4,
    };
    const publishedAt = optionalIsoDate(source.publishedAt, `sources[${index}].publishedAt`);
    return publishedAt ? { ...parsed, publishedAt } : parsed;
  });

  const facts = Array.isArray(value.facts) ? value.facts.map((fact, index) => {
    if (!isObject(fact)) throw new Error(`facts[${index}] 必须是对象`);
    if (!Array.isArray(fact.sourceIndexes) || fact.sourceIndexes.length === 0) {
      throw new Error(`facts[${index}].sourceIndexes 必须是非空数组`);
    }
    return {
      key: requireString(fact.key, `facts[${index}].key`),
      value: fact.value,
      sourceIndexes: fact.sourceIndexes.map((item) => {
        if (!Number.isInteger(item) || (item as number) < 0 || (item as number) >= sources.length) {
          throw new Error(`facts[${index}] 包含无效 sourceIndexes`);
        }
        return item as number;
      }),
      confidence: requireScore(fact.confidence, `facts[${index}].confidence`),
    };
  }) : [];

  const evidenceLevel = requireString(value.evidenceLevel, "evidenceLevel");
  if (!evidenceLevels.has(evidenceLevel)) throw new Error(`不支持的 evidenceLevel：${evidenceLevel}`);
  const occurredAt = optionalIsoDate(value.event.occurredAt, "event.occurredAt");
  const announcedAt = optionalIsoDate(value.event.announcedAt, "event.announcedAt");

  return {
    event: {
      title: requireString(value.event.title, "event.title"),
      summary: requireString(value.event.summary, "event.summary"),
      whyItMatters: requireString(value.event.whyItMatters, "event.whyItMatters"),
      identity: {
        subjects: requireStringArray(value.event.identity.subjects, "event.identity.subjects"),
        action: action as ResearchResult["event"]["identity"]["action"],
        objects: requireStringArray(value.event.identity.objects, "event.identity.objects"),
      },
      ...(occurredAt ? { occurredAt } : {}),
      ...(announcedAt ? { announcedAt } : {}),
    },
    facts,
    sources,
    conflicts: Array.isArray(value.conflicts) ? value.conflicts.map((item, index) => requireString(item, `conflicts[${index}]`)) : [],
    missingEvidence: Array.isArray(value.missingEvidence) ? value.missingEvidence.map((item, index) => requireString(item, `missingEvidence[${index}]`)) : [],
    scores: parseScores(value.scores),
    evidenceLevel: evidenceLevel as ResearchResult["evidenceLevel"],
  };
}
