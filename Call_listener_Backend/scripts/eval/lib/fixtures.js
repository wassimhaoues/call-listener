import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { z } from "zod";
import { CandidateInterviewContextSchema } from "../../../server/contracts/interviewContext.js";
import { containsTerm } from "./metrics.js";
import { resolveSafeDirectory, safeJoin } from "./safePaths.js";

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
  const caseDef = parseCase(raw, source);
  const evidenceIds = new Set(caseDef.evidence.map((item) => item.id));
  const uniqueEvidence = evidenceIds.size === caseDef.evidence.length ? [] : ["evidence IDs must be unique"];
  throwIfProblems(source, [
    ...settingsProblems(caseDef),
    ...uniqueEvidence,
    ...caseDef.evidence.flatMap(keyTermProblems),
    ...forbiddenClaimProblems(caseDef),
    ...caseDef.questions.flatMap((question) => questionProblems(question, evidenceIds)),
  ]);
  return caseDef;
}

function parseCase(raw, source) {
  const parsed = EvalCaseSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  throw new FixtureError(`${source}: ${issues.join("; ")}`);
}

function throwIfProblems(source, problems) {
  if (problems.length) throw new FixtureError(`${source}: ${problems.join("; ")}`);
}

function settingsProblems(caseDef) {
  const contextResult = CandidateInterviewContextSchema.safeParse(toInterviewContext(caseDef));
  if (!contextResult.success) return ["context is not a valid version 1 candidate interview context"];
  const { settings } = contextResult.data;
  const problems = [];
  if (settings.language !== caseDef.expectations.language) {
    problems.push("expectations.language must equal context.settings.language");
  }
  if (settings.answerLength !== caseDef.expectations.answerLength) {
    problems.push("expectations.answerLength must equal context.settings.answerLength");
  }
  return problems;
}

function keyTermProblems(item) {
  const text = `${item.requirement} ${item.evidence}`;
  return item.keyTerms
    .filter((keyTerm) => !containsTerm(text, keyTerm))
    .map((keyTerm) => `${item.id}: key term "${keyTerm}" does not appear in its evidence`);
}

function forbiddenClaimProblems(caseDef) {
  const ownText = JSON.stringify(caseDef.context) + JSON.stringify(caseDef.evidence);
  return caseDef.expectations.forbiddenClaims
    .filter((claim) => containsTerm(ownText, claim))
    .map((claim) => `forbidden claim "${claim}" appears in the case's own context`);
}

/**
 * Cross-case rules that make context isolation measurable: unique IDs, at
 * least two distinct candidates, both languages, every question type, and no
 * case's evidence key terms present in another case's context.
 */
export function validateSuite(cases) {
  throwIfProblems("suite", [
    ...uniquenessProblems(cases),
    ...coverageProblems(cases),
    ...isolationProblems(cases),
  ]);
  return cases;
}

function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}

function uniquenessProblems(cases) {
  const checks = [
    [cases.map((caseDef) => caseDef.id), "case IDs must be unique"],
    [cases.flatMap((caseDef) => caseDef.questions.map((question) => question.id)), "question IDs must be unique across cases"],
    [cases.flatMap((caseDef) => caseDef.evidence.map((item) => item.id)), "evidence IDs must be unique across cases"],
  ];
  return checks.filter(([values]) => hasDuplicates(values)).map(([, message]) => message);
}

function coverageProblems(cases) {
  const problems = [];
  const candidates = new Set(cases.map((caseDef) => normalizeName(caseDef.context.candidate?.name)));
  if (candidates.size < 2) problems.push("at least two distinct candidates are required for context isolation");
  const languages = new Set(cases.map((caseDef) => caseDef.expectations.language));
  for (const language of ["en", "fr"].filter((entry) => !languages.has(entry))) {
    problems.push(`at least one ${language} case is required`);
  }
  const types = new Set(cases.flatMap((caseDef) => caseDef.questions.map((question) => question.type)));
  for (const type of QUESTION_TYPES.filter((entry) => !types.has(entry))) {
    problems.push(`at least one ${type} question is required`);
  }
  return problems;
}

function crossCaseLeaks(caseDef, other) {
  const otherText = JSON.stringify(other.context) + JSON.stringify(other.evidence.map((item) => item.evidence));
  return caseDef.evidence.flatMap((item) => item.keyTerms
    .filter((keyTerm) => containsTerm(otherText, keyTerm))
    .map((keyTerm) => `${item.id}: key term "${keyTerm}" also appears in case ${other.id}`));
}

function isolationProblems(cases) {
  return cases.flatMap((caseDef) => cases
    .filter((other) => other !== caseDef)
    .flatMap((other) => crossCaseLeaks(caseDef, other)));
}

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

async function readCase(directory, name) {
  const content = await readFile(safeJoin(directory, name), "utf8");
  let raw;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new FixtureError(`${name}: invalid JSON (${error.message})`);
  }
  return {
    caseDef: validateCase(raw, name),
    file: { file: name, sha256: createHash("sha256").update(content).digest("hex") },
  };
}

/**
 * Load, validate, and fingerprint every `*.json` case in `directory`, which
 * must be inside the backend root or the OS temp directory.
 */
export async function loadFixtures(directory) {
  const safeDirectory = await resolveSafeDirectory(directory, "--fixtures");
  const names = (await readdir(safeDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));
  if (!names.length) throw new FixtureError(`${safeDirectory}: no *.json evaluation fixtures found`);
  const loaded = await Promise.all(names.map((name) => readCase(safeDirectory, name)));
  const cases = loaded.map((entry) => entry.caseDef);
  validateSuite(cases);
  return { cases, files: loaded.map((entry) => entry.file) };
}
