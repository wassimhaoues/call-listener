import { z } from "zod";

const text = (max) => z.string().trim().max(max);

export const CandidateInterviewContextSchema = z.object({
  version: z.literal(1),
  candidate: z.object({
    name: text(120).min(1),
    profile: text(12_000).default(""),
    skills: z.array(text(80).min(1)).max(40).default([]),
    achievements: z.array(text(500).min(1)).max(40).default([]),
  }),
  jobOffer: z.object({
    title: text(160).min(1),
    company: text(160).default(""),
    description: text(16_000).default(""),
    requirements: z.array(text(500).min(1)).max(30).optional(),
  }),
  evidence: z.array(z.object({
    requirement: text(500).min(1),
    evidence: text(500).min(1),
  })).max(30).optional(),
  settings: z.object({
    language: z.enum(["fr", "en"]).default("fr"),
    transcriptionLanguage: z.enum(["fr", "en"]).optional(),
    stage: z.enum(["recruiter", "technical", "behavioral", "final", "other"])
      .default("other"),
    answerLength: z.enum(["short", "standard", "detailed"]).default("standard"),
    // Session-scoped model choice. Allowlist membership is enforced by the
    // message handler because the allowlist is deployment configuration.
    model: z.string().trim().min(1).max(128).optional(),
  }),
});

const LegacyContextSchema = z.object({
  caller: z.object({
    name: text(120).default(""),
    company: text(160).default(""),
    description: text(12_000).default(""),
    other: text(4_000).default(""),
  }).default({}),
  me: z.object({
    name: text(120).default(""),
    company: text(160).default(""),
    description: text(12_000).default(""),
    objectives: text(4_000).default(""),
  }).default({}),
});

export const SUPPORTED_CONTEXT_VERSIONS = Object.freeze([1]);

/** Thrown when a context declares a `version` this server does not implement. */
export class UnsupportedContextVersionError extends Error {
  constructor() {
    super("unsupported_context_version");
    this.name = "UnsupportedContextVersionError";
    this.code = "unsupported_context_version";
  }
}

export function parseInterviewContext(value) {
  // Only legacy payloads omit `version`. Any other declared version must be
  // rejected, never parsed as an empty legacy context.
  if (
    value && typeof value === "object" && !Array.isArray(value) &&
    value.version !== undefined && !SUPPORTED_CONTEXT_VERSIONS.includes(value.version)
  ) {
    throw new UnsupportedContextVersionError();
  }
  const candidateResult = CandidateInterviewContextSchema.safeParse(value);
  if (candidateResult.success) return candidateResult.data;
  if (value && typeof value === "object" && value.version === 1) {
    return CandidateInterviewContextSchema.parse(value);
  }
  return LegacyContextSchema.parse(value);
}

export function isCandidateInterviewContext(value) {
  return CandidateInterviewContextSchema.safeParse(value).success;
}

/**
 * Optional client capabilities advertised at the top level of a context
 * message (`context.capabilities`). They describe the connected client, not
 * the interview, so they are parsed separately and never stored with the
 * context or sent to a model (both context schemas strip the key). Unknown
 * capability names are ignored so newer clients can talk to older servers; a
 * malformed list is rejected.
 */
export const CLIENT_CAPABILITIES = Object.freeze(["stream", "resume", "actions"]);

const ClientCapabilitiesSchema = z.array(text(32).min(1)).max(8).optional();

/** The validated capability names (trimmed); throws on a malformed list. */
export function parseClientCapabilityNames(value) {
  const isObject = value && typeof value === "object" && !Array.isArray(value);
  const raw = isObject ? value.capabilities : undefined;
  return ClientCapabilitiesSchema.parse(raw) ?? [];
}

/**
 * Generation-related capabilities applied by the stream manager. `actions`
 * asks for generation IDs and kinds on non-streamed replies, so a client
 * that does not stream can still target a suggestion with a response action.
 * @returns {{ stream: boolean, actions: boolean }}
 */
export function parseClientCapabilities(value) {
  const names = parseClientCapabilityNames(value);
  return { stream: names.includes("stream"), actions: names.includes("actions") };
}

/**
 * Whether the client opts into resumable sessions (sequenced server messages,
 * replay, and `{ resume }` on reconnect). Session-level, so it is handled by
 * the connection lifecycle rather than the stream manager.
 */
export function requestsSessionResume(value) {
  return parseClientCapabilityNames(value).includes("resume");
}
