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

  return async function generateReply(systemPrompt, formattedHistory, { signal } = {}) {
    try {
      log?.info("Generating AI reply from Groq...");
      const response = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: formattedHistory },
          ],
        },
        { signal }
      );
      const text = response.choices[0]?.message?.content?.trim() || "";
      log?.info(`Groq reply generated (${text.length} chars)`);
      return text;
    } catch (error) {
      log?.error("Groq API error: %o", error);
      throw error;
    }
  };
}
