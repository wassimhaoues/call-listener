import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CandidateInterviewContextSchema } from "../../../server/contracts/interviewContext.js";
import { containsTerm } from "./metrics.js";

export const QUESTION_TYPES = Object.freeze(["behavioral", "technical", "multipart", "follow-up", "no-evidence"]);

const id = z.string().regex(/^[A-Za-z0-9][\w-]{0,63}$/);
const term = z.string().trim().min(2).max(80);

const EvalCaseSchema = z.strictObject({
  version: z.literal(1),
  id,
  description: z.string().min(1).max(500),
  // The production context without `evidence`; evidence lives below with IDs.
  context: z.looseObject({ evidence: z.never().optional() }),
  evidence: z.array(z.strictObject({
    id,
    requirement: z.string().trim().min(1).max(500),
    evidence: z.string().trim().min(1).max(500),
    keyTerms: z.array(term).min(1).max(5),
  })).min(4).max(30),
  expectations: z.strictObject({
    language: z.enum(["en", "fr"]),
    answerLength: z.enum(["short", "standard", "detailed"]),
    forbiddenClaims: z.array(term).min(1).max(40),
  }),
  questions: z.array(z.strictObject({
    id,
    type: z.enum(QUESTION_TYPES),
    text: z.string().trim().min(3).max(500),
    history: z.array(z.strictObject({
      speaker: z.enum(["interviewer", "candidate"]),
      text: z.string().trim().min(1).max(500),
    })).max(10).default([]),
    expectedEvidenceIds: z.array(id).max(3),
  })).min(1).max(20),
});

export class FixtureError extends Error {
  constructor(message) {
    super(message);
    this.name = "FixtureError";
  }
}

/** The production context payload: fixture context plus ID-less evidence. */
export function toInterviewContext(caseDef) {
  return {
    ...caseDef.context,
    evidence: caseDef.evidence.map(({ requirement, evidence }) => ({ requirement, evidence })),
  };
}

function questionProblems(question, evidenceIds) {
  const problems = [];
  const expected = question.expectedEvidenceIds;
  for (const evidenceId of expected) {
    if (!evidenceIds.has(evidenceId)) problems.push(`${question.id}: unknown evidence ID ${evidenceId}`);
  }
  if ((question.type === "no-evidence") !== (expected.length === 0)) {
    problems.push(`${question.id}: only no-evidence questions may have no expected evidence`);
  }
  if (question.type === "multipart" && expected.length < 2) {
    problems.push(`${question.id}: a multipart question needs at least two expected evidence IDs`);
  }
  if (question.type === "follow-up" && !question.history.some((turn) => turn.speaker === "interviewer")) {
    problems.push(`${question.id}: a follow-up question needs a preceding interviewer turn`);
  }
  return problems;
}

/** Validate one parsed fixture object; returns the normalized case. */
export function validateCase(raw, source = "fixture") {
  const parsed = EvalCaseSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new FixtureError(`${source}: ${issues.join("; ")}`);
  }
  const caseDef = parsed.data;
  const problems = [];
  const contextResult = CandidateInterviewContextSchema.safeParse(toInterviewContext(caseDef));
  if (!contextResult.success) {
    problems.push("context is not a valid version 1 candidate interview context");
  } else {
    const { settings } = contextResult.data;
    if (settings.language !== caseDef.expectations.language) {
      problems.push("expectations.language must equal context.settings.language");
    }
    if (settings.answerLength !== caseDef.expectations.answerLength) {
      problems.push("expectations.answerLength must equal context.settings.answerLength");
    }
  }
  const evidenceIds = new Set(caseDef.evidence.map((item) => item.id));
  if (evidenceIds.size !== caseDef.evidence.length) problems.push("evidence IDs must be unique");
  for (const item of caseDef.evidence) {
    for (const keyTerm of item.keyTerms) {
      if (!containsTerm(`${item.requirement} ${item.evidence}`, keyTerm)) {
        problems.push(`${item.id}: key term "${keyTerm}" does not appear in its evidence`);
      }
    }
  }
  const ownText = JSON.stringify(caseDef.context) + JSON.stringify(caseDef.evidence);
  for (const claim of caseDef.expectations.forbiddenClaims) {
    if (containsTerm(ownText, claim)) problems.push(`forbidden claim "${claim}" appears in the case's own context`);
  }
  for (const question of caseDef.questions) {
    problems.push(...questionProblems(question, evidenceIds));
  }
  if (problems.length) throw new FixtureError(`${source}: ${problems.join("; ")}`);
  return caseDef;
}

/**
 * Cross-case rules that make context isolation measurable: unique IDs, at
 * least two distinct candidates, both languages, every question type, and no
 * case's evidence key terms present in another case's context.
 */
export function validateSuite(cases) {
  const problems = [];
  const caseIds = new Set(cases.map((caseDef) => caseDef.id));
  if (caseIds.size !== cases.length) problems.push("case IDs must be unique");
  const questionIds = cases.flatMap((caseDef) => caseDef.questions.map((question) => question.id));
  if (new Set(questionIds).size !== questionIds.length) problems.push("question IDs must be unique across cases");
  const evidenceIds = cases.flatMap((caseDef) => caseDef.evidence.map((item) => item.id));
  if (new Set(evidenceIds).size !== evidenceIds.length) problems.push("evidence IDs must be unique across cases");
  const candidates = new Set(cases.map((caseDef) => normalizeName(caseDef.context.candidate?.name)));
  if (candidates.size < 2) problems.push("at least two distinct candidates are required for context isolation");
  for (const language of ["en", "fr"]) {
    if (!cases.some((caseDef) => caseDef.expectations.language === language)) {
      problems.push(`at least one ${language} case is required`);
    }
  }
  const types = new Set(cases.flatMap((caseDef) => caseDef.questions.map((question) => question.type)));
  for (const type of QUESTION_TYPES) {
    if (!types.has(type)) problems.push(`at least one ${type} question is required`);
  }
  for (const caseDef of cases) {
    for (const other of cases) {
      if (other === caseDef) continue;
      const otherText = JSON.stringify(other.context) + JSON.stringify(other.evidence.map((item) => item.evidence));
      for (const item of caseDef.evidence) {
        for (const keyTerm of item.keyTerms) {
          if (containsTerm(otherText, keyTerm)) {
            problems.push(`${item.id}: key term "${keyTerm}" also appears in case ${other.id}`);
          }
        }
      }
    }
  }
  if (problems.length) throw new FixtureError(`suite: ${problems.join("; ")}`);
  return cases;
}

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

/** Load, validate, and fingerprint every `*.json` case in `directory`. */
export async function loadFixtures(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort((a, b) => a.localeCompare(b));
  if (!names.length) throw new FixtureError(`${directory}: no *.json evaluation fixtures found`);
  const cases = [];
  const files = [];
  for (const name of names) {
    const content = await readFile(path.join(directory, name), "utf8");
    let raw;
    try {
      raw = JSON.parse(content);
    } catch (error) {
      throw new FixtureError(`${name}: invalid JSON (${error.message})`);
    }
    cases.push(validateCase(raw, name));
    files.push({ file: name, sha256: createHash("sha256").update(content).digest("hex") });
  }
  validateSuite(cases);
  return { cases, files };
}
