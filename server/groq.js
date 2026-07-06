// Groq client wrapper — thin OpenAI SDK pointing at Groq
import OpenAI from "openai";

export const MODEL_JSON = "openai/gpt-oss-20b";
export const MODEL_PRD = "openai/gpt-oss-120b";
export const MODEL_SEARCH = "groq/compound";
export const MODEL_ENUM = [
  "groq/compound",
  "groq/compound-mini",
];

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

/**
 * Parse retry-after seconds from a Groq 429 error message.
 */
function retrySeconds(message) {
  const m = message.match(/try again in ([\d.]+)s/i);
  return m ? Math.ceil(parseFloat(m[1])) + 2 : 30;
}

/**
 * Chat completion with automatic 429 retry + schema-validation 400 retry.
 * Returns the raw content string.
 */
export async function completeWithRetry(label, params, maxAttempts = 4) {
  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const completion = await groq.chat.completions.create(params);
      const choice = completion.choices[0];
      const usage = completion.usage;
      console.log(
        `[${label}] model=${params.model} finish=${choice.finish_reason} ` +
          `tokens=${usage?.prompt_tokens ?? "?"}p+${usage?.completion_tokens ?? "?"}c`
      );
      if (choice.finish_reason === "length") {
        throw new Error(
          `${label}: output truncated (finish_reason=length) — hit token cap`
        );
      }
      const content = choice.message?.content;
      if (!content) throw new Error(`Empty response for ${label}`);
      return content;
    } catch (err) {
      const message = err.message || String(err);
      lastErr = message;
      const status = err.status || err.statusCode;

      // 429 rate limit — wait and retry
      if (status === 429 && attempt < maxAttempts) {
        const wait = retrySeconds(message);
        console.log(
          `[${label}] 429 — waiting ${wait}s (attempt ${attempt}/${maxAttempts})`
        );
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      // 400 schema validation — retry once
      if (
        status === 400 &&
        message.includes("does not match the expected schema") &&
        attempt < maxAttempts
      ) {
        console.log(
          `[${label}] schema validation 400 — regenerating (attempt ${attempt}/${maxAttempts})`
        );
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label} failed after ${maxAttempts} attempts: ${lastErr}`);
}

/**
 * Streaming chat completion with automatic 429 retry.
 * Returns an async iterable of content deltas.
 */
export async function completeStream(label, params, maxAttempts = 4) {
  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const stream = await groq.chat.completions.create({
        ...params,
        stream: true,
      });
      console.log(`[${label}] model=${params.model} stream=start`);
      return stream;
    } catch (err) {
      const message = err.message || String(err);
      lastErr = message;
      const status = err.status || err.statusCode;
      if (status === 429 && attempt < maxAttempts) {
        const wait = retrySeconds(message);
        console.log(
          `[${label}] 429 — waiting ${wait}s (attempt ${attempt}/${maxAttempts})`
        );
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label} stream failed after ${maxAttempts} attempts: ${lastErr}`);
}

export default groq;
