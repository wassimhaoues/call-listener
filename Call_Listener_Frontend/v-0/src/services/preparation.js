const SKILL_PATTERNS = [
  "JavaScript", "TypeScript", "Node.js", "React", "Python", "Java", "AWS",
  "Azure", "GCP", "Docker", "Kubernetes", "SQL", "Redis", "PostgreSQL",
  "Git", "Linux", "CI/CD", "Terraform", "LangChain", "LangGraph",
];
const ACTION_PATTERN = /\b(led|built|delivered|improved|reduced|increased|launched|designed|managed|migrated|dirig|développ|amélior|réduit|livr|conçu|migr)/i;
const REQUIREMENT_PATTERN = /\b(required|requirement|must|need|looking for|experience|proficien|knowledge|skills?|responsib|requis|compétence|expérience|maîtrise|recherche)/i;
const STOP_WORDS = new Set(["and", "the", "with", "for", "from", "that", "this", "are", "you", "your", "des", "les", "une", "dans", "avec", "pour", "sur", "the", "and"]);

function unique(items, max = 30) {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))].slice(0, max);
}

function lines(text) {
  return String(text || "").split(/\n|(?<=[.!?])\s+/).map((item) => item.trim().replace(/^[-•*]\s*/, "").trim()).filter(Boolean);
}

function terms(text) {
  return new Set(
    String(text || "").toLowerCase().match(/[\p{L}\p{N}.+#/-]{3,}/gu)?.filter((word) => !STOP_WORDS.has(word)) || []
  );
}

export function extractCandidateFacts(cvText) {
  const cvLines = lines(cvText);
  const lowerCv = String(cvText || "").toLowerCase();
  const skills = unique(
    SKILL_PATTERNS
      .filter((skill) => lowerCv.includes(skill.toLowerCase()))
      .sort((left, right) => lowerCv.indexOf(left.toLowerCase()) - lowerCv.indexOf(right.toLowerCase()))
  );
  const achievements = unique(cvLines.filter((line) => ACTION_PATTERN.test(line) || /\d/.test(line)), 20);
  return { skills, achievements };
}

export function extractJobRequirements(jobDescription) {
  return unique(lines(jobDescription).filter((line) => REQUIREMENT_PATTERN.test(line)), 30);
}

export function buildEvidenceReferences(requirements, candidate) {
  const evidence = [
    ...(candidate.skills || []).map((skill) => ({ text: skill, terms: terms(skill) })),
    ...(candidate.achievements || []).map((achievement) => ({ text: achievement, terms: terms(achievement) })),
  ];
  return (requirements || []).flatMap((requirement) => {
    const requirementTerms = terms(requirement);
    const best = evidence
      .map((item) => ({ ...item, score: [...requirementTerms].filter((term) => item.terms.has(term)).length }))
      .sort((left, right) => right.score - left.score)[0];
    return best?.score ? [{ requirement, evidence: best.text }] : [];
  });
}

export function mergePreparationItems(...itemLists) {
  return unique(itemLists.flat());
}

/**
 * Map the evidence IDs used by the backend preparation brief back to the
 * candidate's approved facts: `A<n>` is the n-th achievement and `E<n>` the
 * n-th requirement-to-evidence reference (1-based, in context order).
 */
export function preparationEvidenceIndex(context) {
  const index = new Map();
  (context?.candidate?.achievements || []).forEach((text, position) => {
    index.set(`A${position + 1}`, { kind: "achievement", text });
  });
  (context?.evidence || []).forEach((item, position) => {
    index.set(`E${position + 1}`, { kind: "evidence", text: `${item.requirement} → ${item.evidence}` });
  });
  return index;
}

const AI_PREPARATION_ERRORS = {
  preparation_budget_reached: "Today's AI preparation budget for this installation is used up. Your local brief is still available.",
  preparation_rate_limited: "Too many AI preparation requests. Wait a minute, then try again.",
  preparation_unavailable: "AI preparation is not available on this server. Your local brief is still available.",
  unsupported_model: "The selected AI model cannot be used for preparation. Choose another model or the server default.",
  invalid_context: "The preparation details were not accepted. Check your name, job title, and fields, then try again.",
  unsupported_context_version: "This app version's preparation data is not supported by the server. Update the app.",
  missing_basics: "Add your name and the job title before improving the brief with AI.",
};

/** Candidate-facing message for an AI preparation error code. */
export function aiPreparationErrorMessage(code) {
  return AI_PREPARATION_ERRORS[code] || "The AI brief could not be generated. Try again later, or keep using your local brief.";
}

/** Build a reviewable preparation brief from candidate-approved facts only. */
export function createPreparationBrief({ candidate, jobOffer }) {
  const skills = candidate.skills || [];
  const achievements = candidate.achievements || [];
  const requirements = jobOffer.requirements || [];
  const name = candidate.name || "I";
  const profile = candidate.profile || "";
  const skillSummary = skills.slice(0, 3).join(", ");
  const introduction = [
    `Start with: “I’m ${name}${profile ? `, ${profile}` : ""}.”`,
    skillSummary ? `For this role, emphasize: ${skillSummary}.` : "Add the skills you want to emphasize.",
  ];
  const questions = [
    `What would success look like in the first 90 days for this ${jobOffer.title || "role"}?`,
    jobOffer.company ? `How does ${jobOffer.company} support this team’s priorities?` : "What are the team’s most important priorities right now?",
  ];
  return {
    introduction,
    starExamples: achievements.map((achievement) => `Use this as a STAR example: ${achievement}`),
    practiceTopics: requirements.length ? requirements : skills,
    questions,
  };
}
