import Groq from "groq-sdk";

/** Create the legacy Groq adapter behind the shared reply-generator contract. */
export function createGroqReplyGenerator({
  apiKey,
  model = "openai/gpt-oss-120b",
  GroqClient = Groq,
  log,
} = {}) {
  if (!apiKey) throw new TypeError("Groq apiKey is required");
  const client = new GroqClient({ apiKey });

  // Per-request `model` overrides are OpenRouter-only; the rollback adapter
  // always uses its configured model.
  // An optional per-request `maxOutputTokens` (the end-of-interview debrief)
  // becomes `max_tokens`; other requests are sent exactly as before.
  return async function generateReply(systemPrompt, formattedHistory, { signal, onModel, maxOutputTokens } = {}) {
    try {
      log?.info("Generating AI reply from Groq...");
      const body = {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: formattedHistory },
        ],
      };
      if (Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) body.max_tokens = maxOutputTokens;
      const response = await client.chat.completions.create(body, { signal });
      const text = response.choices[0]?.message?.content?.trim() || "";
      onModel?.({ selected: model, actual: typeof response.model === "string" ? response.model : null });
      log?.info(`Groq reply generated (${text.length} chars)`);
      return text;
    } catch (error) {
      log?.error("Groq API error: %o", error);
      throw error;
    }
  };
}
