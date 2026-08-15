import { Type } from "typebox";
import { EVENT_ACTIONS } from "../domain/types.js";

const strictObjectOptions = { additionalProperties: false } as const;

const nonEmptyString = (description: string) => Type.String({ minLength: 1, description });
const score = (description: string) => Type.Integer({ minimum: 1, maximum: 10, description });

const eventActionSchema = Type.Union(
  EVENT_ACTIONS.map((action) => Type.Literal(action)),
  { description: "The real-world action that defines this event." },
);

const sourceTypeSchema = Type.Union([
  Type.Literal("OFFICIAL"),
  Type.Literal("PAPER"),
  Type.Literal("CODE"),
  Type.Literal("REGULATOR"),
  Type.Literal("NEWS"),
  Type.Literal("SOCIAL"),
  Type.Literal("OTHER"),
]);

const evidenceLevelSchema = Type.Union([
  Type.Literal("PRIMARY"),
  Type.Literal("CORROBORATED"),
  Type.Literal("SECONDARY"),
  Type.Literal("WEAK"),
]);

/**
 * The model-facing contract for the Research Agent's terminating tool.
 * Domain validation still runs after this structural validation so URL,
 * timestamp and cross-field rules have one authoritative implementation.
 */
export const researchResultSchema = Type.Object({
  event: Type.Object({
    title: nonEmptyString("Concise Chinese event title."),
    summary: nonEmptyString("Concise Chinese factual summary, without hype."),
    whyItMatters: nonEmptyString("Concise Chinese explanation of material importance."),
    identity: Type.Object({
      subjects: Type.Array(nonEmptyString("A real-world subject."), { minItems: 1 }),
      action: eventActionSchema,
      objects: Type.Array(nonEmptyString("The object affected by the action."), { minItems: 1 }),
    }, strictObjectOptions),
    occurredAt: Type.Optional(Type.String({ description: "ISO-8601 timestamp, or omit when unknown." })),
    announcedAt: Type.Optional(Type.String({ description: "ISO-8601 timestamp, or omit when unknown." })),
  }, strictObjectOptions),
  facts: Type.Array(Type.Object({
    key: nonEmptyString("Stable concise fact key."),
    value: Type.Unknown({ description: "A JSON-compatible fact value." }),
    sourceIndexes: Type.Array(Type.Integer({ minimum: 0 }), {
      minItems: 1,
      description: "Zero-based indexes into sources supporting this fact.",
    }),
    confidence: score("Confidence in this individual fact."),
  }, strictObjectOptions)),
  sources: Type.Array(Type.Object({
    publisher: nonEmptyString("Source publisher or organization."),
    url: nonEmptyString("Direct HTTP or HTTPS source URL."),
    sourceType: sourceTypeSchema,
    trustTier: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4)]),
    publishedAt: Type.Optional(Type.String({ description: "ISO-8601 timestamp, or omit when unknown." })),
  }, strictObjectOptions), { minItems: 1 }),
  conflicts: Type.Array(nonEmptyString("A material unresolved source conflict.")),
  missingEvidence: Type.Array(nonEmptyString("Evidence that could not be established.")),
  scores: Type.Object({
    novelty: score("Novelty score."),
    importance: score("Importance score."),
    disruption: score("Potential disruption score."),
    confidence: score("Overall evidence confidence score."),
  }, strictObjectOptions),
  evidenceLevel: evidenceLevelSchema,
}, strictObjectOptions);
