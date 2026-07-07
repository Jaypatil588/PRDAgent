// Groq client wrapper — thin OpenAI SDK pointing at Groq
import OpenAI from "openai";
import "dotenv/config";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const MODEL_JSON = requiredEnv("MODEL_JSON");
export const MODEL_PRD = requiredEnv("MODEL_PRD");
export const MODEL_SEARCH = requiredEnv("MODEL_SEARCH");
export const MODEL_ENUM = requiredEnv("MODEL_ENUM")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Resilience fallback: when a primary model's quota is exhausted (daily/long
// 429) or a request is too large (413), transparently retry on this smaller,
// separately-budgeted model (llama-3.1-8b-instant has a 131k context window).
export const MODEL_FALLBACK = process.env.MODEL_FALLBACK?.trim() || "llama-3.1-8b-instant";

// Ceiling on prompt (input) tokens per request. Grounding context is trimmed to
// fit under this so we don't blow the primary model's per-minute token limit.
export const MAX_INPUT_TOKENS = Number(process.env.MAX_INPUT_TOKENS) || 7500;

// Rough token estimate (~4 chars/token) — good enough for budgeting, no tokenizer.
export function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

// Trim a grounding string so it fits within a token budget (keeps the head,
// which carries the most important context, and marks the truncation).
export function capTokens(text, maxTokens) {
  const str = String(text || "");
  const maxChars = maxTokens * 4;
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars).trimEnd() + "\n…(truncated to fit token budget)";
}

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

/**
 * Parse retry-after seconds from a Groq 429 error message.
 * Handles both "try again in 12.5s" and "try again in 20m15.648s".
 */
function retrySeconds(message) {
  const m = message.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
  if (!m) return 30;
  const minutes = m[1] ? parseInt(m[1], 10) : 0;
  return Math.ceil(minutes * 60 + parseFloat(m[2])) + 2;
}

/**
 * A daily (TPD) or otherwise long rate limit can't be waited out inside a
 * request — fail fast with the clear message instead of hanging on retries.
 */
function isUnretryableRateLimit(message, waitSeconds) {
  return /per day|tokens per day|\bTPD\b|requests per day|\bRPD\b/i.test(message) || waitSeconds > 90;
}

/**
 * Rewrite request params to run on the fallback model. llama-3.1-8b-instant
 * does not support `reasoning_effort` and cannot do strict-mode structured
 * decoding, so drop the former and relax `strict` on json_schema outputs.
 */
function adaptForFallback(params) {
  const next = { ...params, model: MODEL_FALLBACK };
  delete next.reasoning_effort;
  if (next.response_format?.json_schema?.strict === true) {
    next.response_format = {
      ...next.response_format,
      json_schema: { ...next.response_format.json_schema, strict: false },
    };
  }
  return next;
}

/**
 * Chat completion with automatic 429 retry + schema-validation 400 retry.
 * Returns the raw content string.
 */
export async function completeWithRetry(label, params, maxAttempts = 4) {
  let lastErr = "";
  let activeParams = params;
  let usingFallback = params.model === MODEL_FALLBACK;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const completion = await groq.chat.completions.create(activeParams);
      const choice = completion.choices[0];
      const usage = completion.usage;
      console.log(
        `[${label}] model=${activeParams.model} finish=${choice.finish_reason} ` +
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

      // 429 rate limit — wait and retry, unless it's a daily/long limit.
      if (status === 429 && attempt < maxAttempts) {
        const wait = retrySeconds(message);
        if (isUnretryableRateLimit(message, wait)) {
          // Quota exhausted on the primary model — switch to the fallback and
          // retry immediately rather than failing the whole request.
          if (!usingFallback) {
            console.log(
              `[${label}] quota reached on ${activeParams.model} — switching to fallback ${MODEL_FALLBACK}`
            );
            activeParams = adaptForFallback(activeParams);
            usingFallback = true;
            continue;
          }
          throw new Error(`${label}: Groq quota reached — ${message}`);
        }
        console.log(
          `[${label}] 429 — waiting ${wait}s (attempt ${attempt}/${maxAttempts})`
        );
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      // 413 request too large — the primary model's TPM/context ceiling was hit.
      // The fallback has a 131k context, so switch to it and retry.
      if (status === 413 && !usingFallback && attempt < maxAttempts) {
        console.log(
          `[${label}] 413 request too large on ${activeParams.model} — switching to fallback ${MODEL_FALLBACK}`
        );
        activeParams = adaptForFallback(activeParams);
        usingFallback = true;
        continue;
      }
      // 400 structured-output validation failure — regenerate. Groq reports this
      // as either "does not match the expected schema" or the constrained-decoding
      // variant "Failed to validate JSON" (code json_validate_failed). Both are
      // non-deterministic model failures that a fresh generation usually clears.
      const code = err.code || err.error?.code || "";
      if (
        status === 400 &&
        (message.includes("does not match the expected schema") ||
          message.includes("Failed to validate JSON") ||
          code === "json_validate_failed") &&
        attempt < maxAttempts
      ) {
        console.log(
          `[${label}] structured-output 400 — regenerating (attempt ${attempt}/${maxAttempts})`
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
  let activeParams = params;
  let usingFallback = params.model === MODEL_FALLBACK;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const stream = await groq.chat.completions.create({
        ...activeParams,
        stream: true,
      });
      console.log(`[${label}] model=${activeParams.model} stream=start`);
      return stream;
    } catch (err) {
      const message = err.message || String(err);
      lastErr = message;
      const status = err.status || err.statusCode;
      if (status === 429 && attempt < maxAttempts) {
        const wait = retrySeconds(message);
        if (isUnretryableRateLimit(message, wait)) {
          // Quota exhausted on the primary model — switch to the fallback and
          // retry immediately rather than failing the whole request.
          if (!usingFallback) {
            console.log(
              `[${label}] quota reached on ${activeParams.model} — switching to fallback ${MODEL_FALLBACK}`
            );
            activeParams = adaptForFallback(activeParams);
            usingFallback = true;
            continue;
          }
          throw new Error(`${label}: Groq quota reached — ${message}`);
        }
        console.log(
          `[${label}] 429 — waiting ${wait}s (attempt ${attempt}/${maxAttempts})`
        );
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      // 413 request too large — switch to the larger-context fallback and retry.
      if (status === 413 && !usingFallback && attempt < maxAttempts) {
        console.log(
          `[${label}] 413 request too large on ${activeParams.model} — switching to fallback ${MODEL_FALLBACK}`
        );
        activeParams = adaptForFallback(activeParams);
        usingFallback = true;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label} stream failed after ${maxAttempts} attempts: ${lastErr}`);
}

export default groq;
