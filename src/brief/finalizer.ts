import { randomUUID } from "node:crypto";
import { rankingScore, compareEvents } from "../dedup/event-dedup.js";
import { openDatabase } from "../database.js";
import { getEventBundle, listWeekEvents, type EventBundle } from "../events/event-repository.js";

export interface FinalizationResult {
  ok: boolean;
  weekId: string;
  issues: string[];
  bundles: EventBundle[];
  markdown: string;
  briefId?: string;
  version?: number;
}

export function renderWeeklyBrief(weekId: string, bundles: EventBundle[]): string {
  const sections = bundles.map((bundle, index) => {
    const event = bundle.event;
    const sources = bundle.sources.map((source) => `[${source.publisher}](${source.url})`).join(" · ");
    return [
      `## ${index + 1}. ${event.title}`,
      "",
      event.summary,
      "",
      `**为什么值得关注：** ${event.whyItMatters}`,
      "",
      `**评分：** 新颖性 ${event.scores.novelty}｜重要性 ${event.scores.importance}｜颠覆性 ${event.scores.disruption}｜可信度 ${event.scores.confidence}`,
      "",
      `**来源：** ${sources}`,
    ].join("\n");
  });
  return [`# AI Weekly Brief · ${weekId}`, "", ...sections.flatMap((section) => [section, "", "---", ""])].join("\n");
}

export function previewWeek(databaseFile: string, weekId: string): FinalizationResult {
  const candidates = listWeekEvents(databaseFile, weekId)
    .filter((event) => (["CANDIDATE", "SHORTLISTED", "SELECTED"] as string[]).includes(event.status) && event.scores.confidence >= 7)
    .sort((a, b) => rankingScore(b) - rankingScore(a));
  const issues: string[] = [];
  if (candidates.length < 10) issues.push(`合格候选不足 10 条：当前 ${candidates.length} 条`);

  const selected = candidates.slice(0, 10);
  for (let left = 0; left < selected.length; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      const a = selected[left];
      const b = selected[right];
      if (!a || !b) continue;
      const decision = compareEvents(a, b);
      if (decision.relation === "SAME_EVENT" && decision.confidence >= 0.85) {
        issues.push(`候选重复：${a.title} / ${b.title}`);
      }
      if (decision.relation === "UNCERTAIN") {
        issues.push(`候选关系不确定，需继续核验：${a.title} / ${b.title}`);
      }
    }
  }
  const bundles = selected.flatMap((event) => {
    const bundle = getEventBundle(databaseFile, event.id);
    if (!bundle) {
      issues.push(`无法加载事件：${event.id}`);
      return [];
    }
    if (bundle.sources.length === 0) issues.push(`事件缺少来源：${event.title}`);
    if (event.evidenceLevel === "WEAK") issues.push(`事件证据等级过低：${event.title}`);
    if (event.evidenceLevel === "SECONDARY" && bundle.sources.length < 2) {
      issues.push(`二手来源事件缺少独立核验：${event.title}`);
    }
    if (bundle.facts.some((fact) => fact.sourceIds.length === 0)) {
      issues.push(`事件存在无法追溯来源的事实：${event.title}`);
    }
    if (bundle.sources.some((source) => {
      try { return !(["http:", "https:"] as string[]).includes(new URL(source.url).protocol); } catch { return true; }
    })) {
      issues.push(`事件包含无效来源链接：${event.title}`);
    }
    return [bundle];
  });
  return {
    ok: selected.length === 10 && issues.length === 0,
    weekId,
    issues,
    bundles,
    markdown: renderWeeklyBrief(weekId, bundles),
  };
}

export function finalizeWeek(databaseFile: string, weekId: string): FinalizationResult {
  const result = previewWeek(databaseFile, weekId);
  if (!result.ok) return result;
  const database = openDatabase(databaseFile);
  try {
    const latestBrief = database.prepare(`
      SELECT id, version, markdown
      FROM briefs
      WHERE week_id = ? AND status = 'FINALIZED'
      ORDER BY version DESC
      LIMIT 1
    `).get(weekId) as { id: string; version: number; markdown: string } | undefined;
    if (latestBrief?.markdown === result.markdown) {
      return { ...result, briefId: latestBrief.id, version: latestBrief.version };
    }

    const latest = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM briefs WHERE week_id = ?").get(weekId) as { version: number };
    const version = latest.version + 1;
    const briefId = randomUUID();
    database.prepare(`
      INSERT INTO briefs (id, week_id, version, status, markdown, created_at, finalized_at)
      VALUES (?, ?, ?, 'FINALIZED', ?, ?, ?)
    `).run(briefId, weekId, version, result.markdown, new Date().toISOString(), new Date().toISOString());
    return { ...result, briefId, version };
  } finally {
    database.close();
  }
}
