const ACKNOWLEDGEMENT = /^(okay|ok|thanks|thank you|great|got it|i see|perfect|sounds good|d['’]accord|merci|très bien|parfait|je vois|compris)[.!\s]*$/i;
const QUESTION_START = /^(tell me|describe|walk me through|explain|how|why|what|when|where|who|could you|can you|would you|do you|have you|are you|parlez[- ]moi|décrivez|expliquez|comment|pourquoi|quel(?:le|s)?|pouvez[- ]vous|avez[- ]vous|êtes[- ]vous)\b/i;

/** A bounded, language-aware fast-path classifier for completed interviewer turns. */
export function isInterviewerQuestion(text) {
  const normalized = String(text || "").trim();
  if (!normalized || ACKNOWLEDGEMENT.test(normalized)) return false;
  return normalized.includes("?") || QUESTION_START.test(normalized);
}
