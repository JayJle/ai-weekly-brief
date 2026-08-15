export const EVENT_ACTIONS = [
  "RELEASE",
  "ANNOUNCE",
  "OPEN_SOURCE",
  "GENERAL_AVAILABILITY",
  "PRICE_CHANGE",
  "FUNDING",
  "ACQUISITION",
  "PARTNERSHIP",
  "POLICY_CHANGE",
  "LEGAL_ACTION",
  "RESEARCH_RESULT",
  "BENCHMARK_RESULT",
  "SECURITY_INCIDENT",
  "SERVICE_CHANGE",
  "SHUTDOWN",
  "OTHER",
] as const;

export type EventAction = typeof EVENT_ACTIONS[number];
export type EventStatus = "CANDIDATE" | "WATCHING" | "SHORTLISTED" | "SELECTED" | "REJECTED" | "MERGED";
export type EvidenceLevel = "PRIMARY" | "CORROBORATED" | "SECONDARY" | "WEAK";
export type SourceType = "OFFICIAL" | "PAPER" | "CODE" | "REGULATOR" | "NEWS" | "SOCIAL" | "OTHER";
export type EventRelation = "SAME_EVENT" | "UPDATE" | "RELATED" | "DISTINCT" | "UNCERTAIN";

export interface EventScores {
  novelty: number;
  importance: number;
  disruption: number;
  confidence: number;
}

export interface EventIdentity {
  subjects: string[];
  action: EventAction;
  objects: string[];
}

export interface CandidateEvent {
  id: string;
  weekId: string;
  status: EventStatus;
  title: string;
  summary: string;
  whyItMatters: string;
  identity: EventIdentity;
  occurredAt?: string;
  announcedAt?: string;
  firstSeenAt: string;
  lastCheckedAt: string;
  scores: EventScores;
  evidenceLevel: EvidenceLevel;
}

export interface EventSource {
  id: string;
  eventId: string;
  publisher: string;
  url: string;
  canonicalUrl: string;
  sourceType: SourceType;
  trustTier: 1 | 2 | 3 | 4;
  publishedAt?: string;
  contentHash?: string;
  lineageKey?: string;
}

export interface EventFact {
  id: string;
  eventId: string;
  key: string;
  value: unknown;
  sourceIds: string[];
  confidence: number;
}

export interface ResearchSourceInput {
  publisher: string;
  url: string;
  sourceType: SourceType;
  trustTier: 1 | 2 | 3 | 4;
  publishedAt?: string;
}

export interface ResearchFactInput {
  key: string;
  value: unknown;
  sourceIndexes: number[];
  confidence: number;
}

export interface ResearchResult {
  event: {
    title: string;
    summary: string;
    whyItMatters: string;
    identity: EventIdentity;
    occurredAt?: string;
    announcedAt?: string;
  };
  facts: ResearchFactInput[];
  sources: ResearchSourceInput[];
  conflicts: string[];
  missingEvidence: string[];
  scores: EventScores;
  evidenceLevel: EvidenceLevel;
}
