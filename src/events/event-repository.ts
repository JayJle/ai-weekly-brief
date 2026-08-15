import { randomUUID } from "node:crypto";
import { openDatabase } from "../database.js";
import { compareEvents } from "../dedup/event-dedup.js";
import type { CandidateEvent, EventFact, EventSource, ResearchResult } from "../domain/types.js";
import { normalizeUrl } from "../fetch/safe-fetch.js";

export interface EventBundle {
  event: CandidateEvent;
  sources: EventSource[];
  facts: EventFact[];
}

export function currentIsoWeek(date = new Date()): string {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function isoWeekInTimezone(timezone: string, date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return currentIsoWeek(new Date(`${values.year}-${values.month}-${values.day}T00:00:00Z`));
}

export function previousIsoWeekInTimezone(timezone: string, date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localDate = new Date(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
  localDate.setUTCDate(localDate.getUTCDate() - 7);
  return currentIsoWeek(localDate);
}

export function saveResearchResult(
  databaseFile: string,
  research: ResearchResult,
  weekId = currentIsoWeek(),
): EventBundle {
  const database = openDatabase(databaseFile);
  const now = new Date().toISOString();
  const eventId = randomUUID();
  const event: CandidateEvent = {
    id: eventId,
    weekId,
    status: research.scores.confidence >= 7 ? "CANDIDATE" : "WATCHING",
    title: research.event.title,
    summary: research.event.summary,
    whyItMatters: research.event.whyItMatters,
    identity: research.event.identity,
    firstSeenAt: now,
    lastCheckedAt: now,
    scores: research.scores,
    evidenceLevel: research.evidenceLevel,
    ...(research.event.occurredAt ? { occurredAt: research.event.occurredAt } : {}),
    ...(research.event.announcedAt ? { announcedAt: research.event.announcedAt } : {}),
  };
  const sources: EventSource[] = research.sources.map((source) => ({
    id: randomUUID(),
    eventId,
    publisher: source.publisher,
    url: source.url,
    canonicalUrl: normalizeUrl(source.url),
    sourceType: source.sourceType,
    trustTier: source.trustTier,
    ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
  }));
  const facts: EventFact[] = research.facts.map((fact) => ({
    id: randomUUID(),
    eventId,
    key: fact.key,
    value: fact.value,
    sourceIds: fact.sourceIndexes.flatMap((index) => sources[index]?.id ? [sources[index].id] : []),
    confidence: fact.confidence,
  }));

  try {
    database.exec("BEGIN;");
    database.prepare(`
      INSERT INTO events (
        id, week_id, status, title, summary, why_it_matters,
        subjects_json, action, objects_json, occurred_at, announced_at,
        scores_json, evidence_level, first_seen_at, last_checked_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.weekId, event.status, event.title, event.summary, event.whyItMatters,
      JSON.stringify(event.identity.subjects), event.identity.action, JSON.stringify(event.identity.objects),
      event.occurredAt ?? null, event.announcedAt ?? null, JSON.stringify(event.scores), event.evidenceLevel,
      event.firstSeenAt, event.lastCheckedAt, now, now,
    );
    const insertSource = database.prepare(`
      INSERT INTO event_sources (
        id, event_id, publisher, url, canonical_url, source_type, trust_tier,
        published_at, content_hash, lineage_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const source of sources) {
      insertSource.run(
        source.id, source.eventId, source.publisher, source.url, source.canonicalUrl,
        source.sourceType, source.trustTier, source.publishedAt ?? null,
        source.contentHash ?? null, source.lineageKey ?? null, now,
      );
    }
    const insertFact = database.prepare(`
      INSERT INTO event_facts (id, event_id, fact_key, value_json, source_ids_json, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const fact of facts) {
      insertFact.run(fact.id, fact.eventId, fact.key, JSON.stringify(fact.value), JSON.stringify(fact.sourceIds), fact.confidence, now);
    }
    database.exec("COMMIT;");
    return { event, sources, facts };
  } catch (error) {
    try { database.exec("ROLLBACK;"); } catch { /* no-op */ }
    throw error;
  } finally {
    database.close();
  }
}

export function saveResearchResultDeduplicated(
  databaseFile: string,
  research: ResearchResult,
  weekId = currentIsoWeek(),
): { bundle: EventBundle; mergedInto?: string } {
  const now = new Date().toISOString();
  const incoming: CandidateEvent = {
    id: "incoming",
    weekId,
    status: research.scores.confidence >= 7 ? "CANDIDATE" : "WATCHING",
    title: research.event.title,
    summary: research.event.summary,
    whyItMatters: research.event.whyItMatters,
    identity: research.event.identity,
    firstSeenAt: now,
    lastCheckedAt: now,
    scores: research.scores,
    evidenceLevel: research.evidenceLevel,
    ...(research.event.occurredAt ? { occurredAt: research.event.occurredAt } : {}),
    ...(research.event.announcedAt ? { announcedAt: research.event.announcedAt } : {}),
  };
  const same = listWeekEvents(databaseFile, weekId).find((existing) => {
    const decision = compareEvents(existing, incoming);
    return decision.relation === "SAME_EVENT" && decision.confidence >= 0.85;
  });
  if (same) {
    return { bundle: addResearchEvidence(databaseFile, same.id, research), mergedInto: same.id };
  }
  return { bundle: saveResearchResult(databaseFile, research, weekId) };
}

export function getEventBundle(databaseFile: string, eventId: string): EventBundle | undefined {
  const database = openDatabase(databaseFile);
  try {
    const row = database.prepare("SELECT * FROM events WHERE id = ?").get(eventId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const event: CandidateEvent = {
      id: String(row.id),
      weekId: String(row.week_id),
      status: String(row.status) as CandidateEvent["status"],
      title: String(row.title),
      summary: String(row.summary),
      whyItMatters: String(row.why_it_matters),
      identity: {
        subjects: JSON.parse(String(row.subjects_json)) as string[],
        action: String(row.action) as CandidateEvent["identity"]["action"],
        objects: JSON.parse(String(row.objects_json)) as string[],
      },
      firstSeenAt: String(row.first_seen_at),
      lastCheckedAt: String(row.last_checked_at),
      scores: JSON.parse(String(row.scores_json)) as CandidateEvent["scores"],
      evidenceLevel: String(row.evidence_level) as CandidateEvent["evidenceLevel"],
      ...(row.occurred_at ? { occurredAt: String(row.occurred_at) } : {}),
      ...(row.announced_at ? { announcedAt: String(row.announced_at) } : {}),
    };
    const sources = database.prepare("SELECT * FROM event_sources WHERE event_id = ? ORDER BY created_at").all(eventId).map((item) => {
      const source = item as Record<string, unknown>;
      return {
        id: String(source.id),
        eventId: String(source.event_id),
        publisher: String(source.publisher),
        url: String(source.url),
        canonicalUrl: String(source.canonical_url),
        sourceType: String(source.source_type) as EventSource["sourceType"],
        trustTier: Number(source.trust_tier) as EventSource["trustTier"],
        ...(source.published_at ? { publishedAt: String(source.published_at) } : {}),
        ...(source.content_hash ? { contentHash: String(source.content_hash) } : {}),
        ...(source.lineage_key ? { lineageKey: String(source.lineage_key) } : {}),
      };
    });
    const facts = database.prepare("SELECT * FROM event_facts WHERE event_id = ? ORDER BY created_at").all(eventId).map((item) => {
      const fact = item as Record<string, unknown>;
      return {
        id: String(fact.id),
        eventId: String(fact.event_id),
        key: String(fact.fact_key),
        value: JSON.parse(String(fact.value_json)) as unknown,
        sourceIds: JSON.parse(String(fact.source_ids_json)) as string[],
        confidence: Number(fact.confidence),
      };
    });
    return { event, sources, facts };
  } finally {
    database.close();
  }
}

export function addResearchEvidence(databaseFile: string, eventId: string, research: ResearchResult): EventBundle {
  const existing = getEventBundle(databaseFile, eventId);
  if (!existing) throw new Error(`事件不存在：${eventId}`);
  const database = openDatabase(databaseFile);
  const now = new Date().toISOString();
  try {
    database.exec("BEGIN;");
    const sourceIdsByIndex: string[] = [];
    for (const source of research.sources) {
      const canonical = normalizeUrl(source.url);
      const found = database.prepare("SELECT id FROM event_sources WHERE event_id = ? AND canonical_url = ?").get(eventId, canonical) as { id: string } | undefined;
      if (found) {
        sourceIdsByIndex.push(found.id);
        continue;
      }
      const id = randomUUID();
      sourceIdsByIndex.push(id);
      database.prepare(`
        INSERT INTO event_sources (id, event_id, publisher, url, canonical_url, source_type, trust_tier, published_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, eventId, source.publisher, source.url, canonical, source.sourceType, source.trustTier, source.publishedAt ?? null, now);
    }
    for (const fact of research.facts) {
      const valueJson = JSON.stringify(fact.value);
      const found = database.prepare("SELECT id FROM event_facts WHERE event_id = ? AND fact_key = ? AND value_json = ?").get(eventId, fact.key, valueJson);
      if (found) continue;
      database.prepare(`
        INSERT INTO event_facts (id, event_id, fact_key, value_json, source_ids_json, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), eventId, fact.key, valueJson,
        JSON.stringify(fact.sourceIndexes.flatMap((index) => sourceIdsByIndex[index] ? [sourceIdsByIndex[index]] : [])),
        fact.confidence, now,
      );
    }
    database.prepare(`
      UPDATE events SET last_checked_at = ?, updated_at = ?, scores_json = ?, evidence_level = ? WHERE id = ?
    `).run(now, now, JSON.stringify(research.scores), research.evidenceLevel, eventId);
    database.exec("COMMIT;");
  } catch (error) {
    try { database.exec("ROLLBACK;"); } catch { /* no-op */ }
    throw error;
  } finally {
    database.close();
  }
  const merged = getEventBundle(databaseFile, eventId);
  if (!merged) throw new Error(`合并证据后无法读取事件：${eventId}`);
  return merged;
}

export function updateEventStatus(
  databaseFile: string,
  eventId: string,
  status: "CANDIDATE" | "WATCHING" | "SHORTLISTED" | "REJECTED",
): CandidateEvent {
  const database = openDatabase(databaseFile);
  try {
    const result = database.prepare(`
      UPDATE events SET status = ?, updated_at = ? WHERE id = ? AND status != 'MERGED'
    `).run(status, new Date().toISOString(), eventId);
    if (result.changes !== 1) throw new Error(`无法更新事件状态：${eventId}`);
  } finally {
    database.close();
  }
  const bundle = getEventBundle(databaseFile, eventId);
  if (!bundle) throw new Error(`更新后无法读取事件：${eventId}`);
  return bundle.event;
}

export function mergeSameEvent(
  databaseFile: string,
  canonicalEventId: string,
  mergedEventId: string,
): EventBundle {
  if (canonicalEventId === mergedEventId) throw new Error("不能把事件合并到自身");
  const canonical = getEventBundle(databaseFile, canonicalEventId);
  const secondary = getEventBundle(databaseFile, mergedEventId);
  if (!canonical || !secondary) throw new Error("待合并事件不存在");
  const decision = compareEvents(canonical.event, secondary.event);
  if (decision.relation !== "SAME_EVENT" || decision.confidence < 0.85) {
    throw new Error(`确定性去重未允许合并：${decision.relation} (${decision.confidence})`);
  }

  const database = openDatabase(databaseFile);
  const now = new Date().toISOString();
  try {
    database.exec("BEGIN;");
    const sourceMapping = new Map<string, string>();
    for (const source of secondary.sources) {
      const existing = database.prepare(`
        SELECT id FROM event_sources WHERE event_id = ? AND canonical_url = ?
      `).get(canonicalEventId, source.canonicalUrl) as { id: string } | undefined;
      if (existing) {
        sourceMapping.set(source.id, existing.id);
        continue;
      }
      const id = randomUUID();
      sourceMapping.set(source.id, id);
      database.prepare(`
        INSERT INTO event_sources (
          id, event_id, publisher, url, canonical_url, source_type, trust_tier,
          published_at, content_hash, lineage_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, canonicalEventId, source.publisher, source.url, source.canonicalUrl,
        source.sourceType, source.trustTier, source.publishedAt ?? null,
        source.contentHash ?? null, source.lineageKey ?? null, now,
      );
    }
    for (const fact of secondary.facts) {
      const valueJson = JSON.stringify(fact.value);
      const existing = database.prepare(`
        SELECT id FROM event_facts WHERE event_id = ? AND fact_key = ? AND value_json = ?
      `).get(canonicalEventId, fact.key, valueJson);
      if (existing) continue;
      database.prepare(`
        INSERT INTO event_facts (id, event_id, fact_key, value_json, source_ids_json, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), canonicalEventId, fact.key, valueJson,
        JSON.stringify(fact.sourceIds.flatMap((id) => sourceMapping.get(id) ? [sourceMapping.get(id)] : [])),
        fact.confidence, now,
      );
    }
    database.prepare(`
      INSERT OR REPLACE INTO event_relations (
        event_a_id, event_b_id, relation, confidence, reason, decided_by, created_at
      ) VALUES (?, ?, 'SAME_EVENT', ?, ?, 'DETERMINISTIC', ?)
    `).run(canonicalEventId, mergedEventId, decision.confidence, decision.reason, now);
    database.prepare("UPDATE events SET status = 'MERGED', updated_at = ? WHERE id = ?").run(now, mergedEventId);
    database.prepare("UPDATE events SET last_checked_at = ?, updated_at = ? WHERE id = ?").run(now, now, canonicalEventId);
    database.exec("COMMIT;");
  } catch (error) {
    try { database.exec("ROLLBACK;"); } catch { /* no-op */ }
    throw error;
  } finally {
    database.close();
  }
  const result = getEventBundle(databaseFile, canonicalEventId);
  if (!result) throw new Error("合并后无法读取主事件");
  return result;
}

export function listWeekEvents(databaseFile: string, weekId = currentIsoWeek()): CandidateEvent[] {
  const database = openDatabase(databaseFile);
  try {
    const rows = database.prepare(`
      SELECT * FROM events WHERE week_id = ? AND status != 'MERGED' ORDER BY created_at DESC
    `).all(weekId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      weekId: String(row.week_id),
      status: String(row.status) as CandidateEvent["status"],
      title: String(row.title),
      summary: String(row.summary),
      whyItMatters: String(row.why_it_matters),
      identity: {
        subjects: JSON.parse(String(row.subjects_json)) as string[],
        action: String(row.action) as CandidateEvent["identity"]["action"],
        objects: JSON.parse(String(row.objects_json)) as string[],
      },
      firstSeenAt: String(row.first_seen_at),
      lastCheckedAt: String(row.last_checked_at),
      scores: JSON.parse(String(row.scores_json)) as CandidateEvent["scores"],
      evidenceLevel: String(row.evidence_level) as CandidateEvent["evidenceLevel"],
      ...(row.occurred_at ? { occurredAt: String(row.occurred_at) } : {}),
      ...(row.announced_at ? { announcedAt: String(row.announced_at) } : {}),
    }));
  } finally {
    database.close();
  }
}
