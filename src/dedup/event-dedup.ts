import type { CandidateEvent, EventRelation } from "../domain/types.js";

export interface RelationDecision {
  relation: EventRelation;
  confidence: number;
  reason: string;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function overlap(left: string[], right: string[]): number {
  const a = new Set(left.map(normalize));
  const b = new Set(right.map(normalize));
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const item of a) if (b.has(item)) common += 1;
  return common / Math.min(a.size, b.size);
}

function dateDistanceDays(left?: string, right?: string): number | undefined {
  if (!left || !right) return undefined;
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return Math.abs(a - b) / 86_400_000;
}

const updatePairs = new Set([
  "ANNOUNCE:GENERAL_AVAILABILITY",
  "ANNOUNCE:RELEASE",
  "RELEASE:GENERAL_AVAILABILITY",
]);

function pair(left: string, right: string): string {
  return [left, right].sort().join(":");
}

export function compareEvents(left: CandidateEvent, right: CandidateEvent): RelationDecision {
  if (left.id === right.id) return { relation: "SAME_EVENT", confidence: 1, reason: "Same event ID." };
  const subjectOverlap = overlap(left.identity.subjects, right.identity.subjects);
  const objectOverlap = overlap(left.identity.objects, right.identity.objects);
  const actionSame = left.identity.action === right.identity.action;
  const distance = dateDistanceDays(
    left.occurredAt ?? left.announcedAt,
    right.occurredAt ?? right.announcedAt,
  );

  if (subjectOverlap === 1 && objectOverlap === 1 && actionSame && (distance === undefined || distance <= 2)) {
    return {
      relation: "SAME_EVENT",
      confidence: distance === undefined ? 0.88 : 0.97,
      reason: "Same normalized subject, action and object within the event time window.",
    };
  }
  if (subjectOverlap >= 0.5 && objectOverlap >= 0.5 && !actionSame) {
    if (updatePairs.has(pair(left.identity.action, right.identity.action))) {
      return {
        relation: "UPDATE",
        confidence: 0.86,
        reason: "Same subject and object, but the actions describe announcement/release/availability progression.",
      };
    }
    return {
      relation: "RELATED",
      confidence: 0.88,
      reason: "Same subject and object but materially different actions.",
    };
  }
  if (subjectOverlap >= 0.5 && objectOverlap >= 0.5 && actionSame) {
    return {
      relation: "UNCERTAIN",
      confidence: 0.55,
      reason: "Identity is similar, but time or normalized entity evidence is insufficient for an automatic merge.",
    };
  }
  return {
    relation: "DISTINCT",
    confidence: 0.9,
    reason: "Subjects, objects or actions do not identify the same real-world event.",
  };
}

export function rankingScore(event: CandidateEvent): number {
  const base = 0.25 * event.scores.novelty + 0.45 * event.scores.importance + 0.3 * event.scores.disruption;
  return base * (0.5 + 0.5 * event.scores.confidence / 10);
}
