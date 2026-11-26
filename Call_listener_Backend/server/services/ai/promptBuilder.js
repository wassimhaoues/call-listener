import { isCandidateInterviewContext, parseInterviewContext } from "../../contracts/interviewContext.js";
import { loggers } from "../../core/logger/index.js";
import { fallbackEvidence, MAX_PROMPT_EVIDENCE } from "../interview/evidenceSelector.js";

const log = loggers.ai;

function buildCandidatePrompt(context, mode, selectedEvidence) {
  const { candidate, jobOffer, settings } = context;
  const english = settings.language === "en";
  const answerFormat = english
    ? settings.answerLength === "short"
      ? "Give a natural answer the candidate can say in no more than three short sentences."
      : settings.answerLength === "detailed"
        ? "Use the headings Answer outline, STAR detail, and Evidence used. Keep every claim grounded in supplied evidence."
        : "Give a concise Answer outline followed by Evidence used."
    : settings.answerLength === "short"
      ? "Donne une réponse naturelle que la candidate ou le candidat peut dire en trois phrases courtes maximum."
      : settings.answerLength === "detailed"
        ? "Utilise les titres Plan de réponse, Détail STAR et Éléments utilisés. Chaque affirmation doit être fondée sur les éléments fournis."
        : "Donne un Plan de réponse concis puis les Éléments utilisés.";
  const base = english
    ? mode === "intro"
      ? "You are a private job-interview assistant for the candidate. Give one concise preparation suggestion grounded only in the supplied candidate and job information. Never invent experience."
      : "You are a private job-interview assistant for the candidate. Help answer the interviewer concisely using only supplied evidence. Never invent experience. If evidence is missing, say so and suggest an honest clarification."
    : mode === "intro"
      ? "Tu es un assistant privé d'entretien d'embauche pour la candidate ou le candidat. Donne une seule suggestion de préparation concise, fondée uniquement sur les informations fournies. N'invente jamais d'expérience."
      : "Tu es un assistant privé d'entretien d'embauche pour la candidate ou le candidat. Aide à répondre brièvement à l'intervieweur uniquement avec les éléments fournis. Si une information manque, indique-le et propose une clarification honnête.";

  const skills = candidate.skills.length ? candidate.skills.join(", ") : "N/A";
  const achievements = candidate.achievements.length
    ? candidate.achievements.map((item) => `- ${item}`).join("\n")
    : "- N/A";
  const requirements = jobOffer.requirements?.length
    ? jobOffer.requirements.map((item) => `- ${item}`).join("\n")
    : "- N/A";
  // Never more than three references, even for the intro or a caller that
  // passes no selection.
  const evidenceItems = selectedEvidence?.length
    ? selectedEvidence.slice(0, MAX_PROMPT_EVIDENCE)
    : fallbackEvidence(context.evidence);
  const evidence = evidenceItems?.length
    ? evidenceItems.map((item) => `- Requirement: ${item.requirement}\n  Candidate evidence: ${item.evidence}`).join("\n")
    : "- N/A";
  return `${base}

Candidate:
- Name: ${candidate.name}
- Profile: ${candidate.profile || "N/A"}
- Skills: ${skills}
- Achievements:
${achievements}

Job offer:
- Title: ${jobOffer.title}
- Company: ${jobOffer.company || "N/A"}
- Description: ${jobOffer.description || "N/A"}
- Requirements:
${requirements}

Candidate evidence references:
${evidence}

Interview settings:
- Language: ${settings.language}
- Transcription language: ${settings.transcriptionLanguage || settings.language}
- Stage: ${settings.stage}
- Preferred answer length: ${settings.answerLength}

Response format:
${answerFormat}`;
}

function buildLegacyPrompt(context, mode) {
  const base =
    mode === "intro"
      ? "Tu es un assistant francophone d'aide à la conversation téléphonique. Sois amical et professionnel. Fournis une seule phrase naturelle pour débuter la conversation."
      : "Tu es un assistant francophone d'aide à la conversation téléphonique. Réponds brièvement et naturellement en un seul paragraphe.";
  return `${base}

Informations sur le client :
- Nom : ${context.caller.name || "N/A"}
- Entreprise : ${context.caller.company || "N/A"}
- Détails : ${context.caller.other || "N/A"}

Informations sur moi :
- Nom : ${context.me.name || "N/A"}
- Entreprise : ${context.me.company || "N/A"}
- Objectifs : ${context.me.objectives || "N/A"}`;
}

/** @param {string} context @param {"intro"|"reply"} mode */
export function buildPrompt(context, mode = "reply", selectedEvidence) {
  log.debug(`Building ${mode} prompt...`);
  const parsed = context ? JSON.parse(context) : {};
  const normalized = parseInterviewContext(parsed);
  return isCandidateInterviewContext(parsed)
    ? buildCandidatePrompt(normalized, mode, selectedEvidence)
    : buildLegacyPrompt(normalized, mode);
}
