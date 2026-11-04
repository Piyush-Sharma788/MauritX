import { z } from "zod";

/**
 * What the AI may return about one WhatsApp message: a proposed intent and
 * the facts the person stated. It's a proposal only; the bot validates each
 * entity with the same deterministic parsers as typed answers and decides
 * what, if anything, to do.
 */
export const AI_INTENTS = [
  "create_request",
  "track_request",
  "cancel_request",
  "register_donor",
  "view_profile",
  "donor_status",
  "update_profile",
  "pause_alerts",
  "resume_alerts",
  "stop_messages",
  "donor_interested",
  "donor_unavailable",
  "more_info",
  "help",
  "greeting",
  "other",
] as const;
export type AiIntent = (typeof AI_INTENTS)[number];

const entities = {
  bloodGroup: z.string().nullable(),
  component: z.string().nullable(),
  units: z.number().nullable(),
  city: z.string().nullable(),
  locality: z.string().nullable(),
  hospitalName: z.string().nullable(),
  requiredBy: z.string().nullable(),
  requestId: z.string().nullable(),
};

/** Sent to the provider as the structured output format: plain types only. */
export const aiOutputFormatSchema = z.object({
  intent: z.enum(AI_INTENTS),
  entities: z.object(entities),
  confidence: z.number(),
  missing_fields: z.array(z.string()),
  requires_confirmation: z.boolean(),
  suggested_response: z.string(),
});

/** What the bot accepts: the same shape with strict bounds. Anything else is rejected. */
export const interpretationSchema = z.strictObject({
  intent: z.enum(AI_INTENTS),
  entities: z.strictObject({
    bloodGroup: z.string().max(20).nullable(),
    component: z.string().max(40).nullable(),
    units: z.number().int().min(1).max(20).nullable(),
    city: z.string().max(60).nullable(),
    locality: z.string().max(80).nullable(),
    hospitalName: z.string().max(120).nullable(),
    requiredBy: z.string().max(60).nullable(),
    requestId: z.string().max(20).nullable(),
  }),
  confidence: z.number().min(0).max(1),
  missing_fields: z.array(z.string().max(40)).max(20),
  requires_confirmation: z.boolean(),
  suggested_response: z.string().max(600),
});

export type Interpretation = z.output<typeof interpretationSchema>;
