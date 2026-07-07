/**
 * PRD Agent backend — Node.js / Express
 *
 * Pipeline:
 *   POST /api/classify       → gpt-oss-20b (structured JSON)
 *   POST /api/questions      → groq/compound-mini (structured JSON)
 *   POST /api/generate-prd   → research (groq/compound + groq/compound-mini) + 3-part PRD (gpt-oss-120b, SSE streamed)
 *
 * Models use separate TPM budgets on free tier:
 *   groq/compound      — 200 RPM / 200K TPM (built-in web search)
 *   openai/gpt-oss-20b — 30 RPM / 12K TPM (structured JSON)
 *   openai/gpt-oss-120b— 30 RPM / 12K TPM (prose generation)
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import {
  completeWithRetry,
  completeStream,
  MODEL_JSON,
  MODEL_PRD,
  MODEL_SEARCH,
  MODEL_ENUM,
  MAX_INPUT_TOKENS,
  estimateTokens,
  capTokens,
} from "./groq.js";
import { runResearch } from "./research.js";
import { templateParts } from "./template.js";
import { DOC_SETS } from "./docs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Load classifier spec ──────────────────────────────────────────────────────

const classifier = JSON.parse(
  readFileSync(resolve(ROOT, "classifier.json"), "utf-8")
);

// Groq strict structured outputs — strip unsupported constraint keywords
const DROP_KEYS = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minItems", "maxItems", "minLength", "maxLength", "pattern", "format", "default",
]);

function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (!DROP_KEYS.has(k)) out[k] = sanitizeSchema(v);
    }
    return out;
  }
  return node;
}

const classificationSchema = sanitizeSchema(classifier.response_schema);

// ── Questions schema ──────────────────────────────────────────────────────────

const questionsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["needs_clarification", "questions"],
  properties: {
    needs_clarification: {
      type: "boolean",
      description:
        "False when the prompt plus classification already give enough to write a solid PRD.",
    },
    questions: {
      type: "array",
      description:
        "Only questions that materially reduce ambiguity. Empty when needs_clarification is false.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "help", "type", "options", "allow_custom"],
        properties: {
          id: { type: "string", description: "Stable snake_case identifier." },
          label: {
            type: "string",
            description: "The question shown to the user.",
          },
          help: {
            type: "string",
            description: "Short context for why this is asked. May be empty.",
          },
          type: {
            type: "string",
            enum: ["single_select", "multi_select", "text"],
          },
          options: {
            type: "array",
            description:
              "Concrete choices for select types. Empty array for text questions.",
            items: { type: "string" },
          },
          allow_custom: {
            type: "boolean",
            description:
              "True when a free-text answer beyond the listed options should be allowed.",
          },
        },
      },
    },
  },
};

const QUESTIONS_SYSTEM_PROMPT = `You are a PRD intake interviewer. You are given a user's raw product prompt and a structured classification of that prompt. Your job is to produce the MINIMUM set of clarifying questions needed to remove real ambiguity before an enterprise PRD is written.

Rules:
- STRICT IMPORTANCE SCRUTINY: Ask a question ONLY if it is an absolute show-stopper for the PRD. Do not ask nice-to-have questions. If the PRD could be written using reasonable assumptions, DO NOT ask the question.
- YOU MUST NEVER use type "text". ALL questions MUST be either "single_select" or "multi_select" with concrete, mutually-exclusive, domain-appropriate options.
- Use the classification's 'missing_context' array to decide what to ask. Do not ask about things the classification already resolved.
- Set allow_custom to true whenever the listed options may not capture the user's real answer.
- If the prompt and classification are already sufficient to draft an MVP PRD, set needs_clarification to false and return an empty questions array.
- Never generate PRD content, architecture, or recommendations. Only questions.
- Ask as many questions as necessary to resolve the biggest ambiguities, but maintain strict importance scrutiny for each.
- Return only valid JSON. Do not wrap it in markdown or add prose before or after it.
- Every object key and string value MUST be enclosed in double quotes. Array values MUST be double-quoted strings. Never use bare words like iOS app.

The JSON must match this schema exactly (use ONLY the enum values listed):
${JSON.stringify(questionsSchema)}`;

function assertQuestionsSpec(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("questions: response JSON must be an object");
  }
  if (typeof value.needs_clarification !== "boolean") {
    throw new Error("questions: needs_clarification must be boolean");
  }
  if (!Array.isArray(value.questions)) {
    throw new Error("questions: questions must be an array");
  }
  for (const [index, question] of value.questions.entries()) {
    if (!question || typeof question !== "object" || Array.isArray(question)) {
      throw new Error(`questions[${index}] must be an object`);
    }
    for (const key of ["id", "label", "help", "type"]) {
      if (typeof question[key] !== "string") {
        throw new Error(`questions[${index}].${key} must be a string`);
      }
    }
    if (!["single_select", "multi_select"].includes(question.type)) {
      throw new Error(`questions[${index}].type must be single_select or multi_select`);
    }
    if (!Array.isArray(question.options) || question.options.some((option) => typeof option !== "string")) {
      throw new Error(`questions[${index}].options must be a string array`);
    }
    if (question.options.length === 0) {
      throw new Error(`questions[${index}].options must not be empty`);
    }
    if (typeof question.allow_custom !== "boolean") {
      throw new Error(`questions[${index}].allow_custom must be boolean`);
    }
  }
  return value;
}

function extractJsonObject(content) {
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("questions: response did not contain a JSON object");
  }
  return stripped.slice(start, end + 1);
}

function repairQuestionsJson(content) {
  const json = extractJsonObject(content).replace(/,\s*([}\]])/g, "$1");
  const lines = json.split("\n");
  const repaired = [];
  let arrayDepth = 0;

  for (const rawLine of lines) {
    let line = rawLine;
    const trimmed = line.trim();
    if (arrayDepth > 0 && trimmed && !/^[{\[\]}",\d]|^(true|false|null)\b/.test(trimmed)) {
      const match = line.match(/^(\s*)(.+?)(,?)\s*$/);
      if (match) {
        const value = match[2].trim().replace(/^['"]|['"]$/g, "");
        line = `${match[1]}${JSON.stringify(value)}${match[3]}`;
      }
    }
    repaired.push(line);

    const withoutStrings = line.replace(/"(?:\\.|[^"\\])*"/g, "\"\"");
    arrayDepth += (withoutStrings.match(/\[/g) || []).length;
    arrayDepth -= (withoutStrings.match(/\]/g) || []).length;
  }

  return repaired.join("\n").replace(/,\s*([}\]])/g, "$1");
}

function parseQuestionsJson(content) {
  try {
    return JSON.parse(extractJsonObject(content));
  } catch (firstErr) {
    const repaired = repairQuestionsJson(content);
    try {
      console.warn(`[questions] repaired malformed JSON: ${firstErr.message}`);
      return JSON.parse(repaired);
    } catch (secondErr) {
      throw new Error(`questions: JSON correction failed: ${secondErr.message}`);
    }
  }
}

// ── PRD part system prompts ───────────────────────────────────────────────────

function prdPartSystemPrompt(part) {
  const partNote =
    part === 1
      ? `\n- The template's title line says "Modular PRD Template: [Product / Feature Name]" — replace the ENTIRE line with "# <actual product name> — PRD".\n- The author/owner line must be exactly "Jay Patil — <current date>" using YYYY-MM-DD for the date.`
      : `\n- Do not add a document title or executive summary — that exists in an earlier part. Start directly with the first section of your template part.`;

  return `You are a product manager writing ONE PART of a larger PRD. The full PRD is produced in 3 parts by separate calls and concatenated afterwards; you are writing PART ${part} of 3.

Rules:
- Fill in ONLY the template part provided. Follow its structure and section order exactly. Replace every [bracketed placeholder] with concrete content.
- Ground everything in the original prompt, the classification, and the user's answers.
- Where something is unspecified, make a clearly reasonable assumption and mark it as an assumption rather than a fact.
- Use cases must be written as natural narrative stories reflecting real problems — NOT templatey "As a [user], I want [action]" format.
- This document is product requirements only: do NOT include system design, architecture, database schema, API contracts, or sprint tasks.
- Do NOT include template instructions, HTML comments, generation notes, "write last", "SEARCH_GROUNDED", "Conditional:", "Each requirement must", research instructions, source instructions, or generic citation placeholders like "[source]" or "【source】".
- Return only the finished markdown for this part. No preamble, no commentary, no "Part ${part}" headers of your own, no code fences around the document.
- Complete EVERY section in your template part — never stop early.${partNote}`;
}

const PRD_QUALITY_RULES = [
  { label: "HTML comment", pattern: /<!--|-->/ },
  { label: "empty blockquote", pattern: /(^|\n)>\s*(\n|$)/ },
  { label: "SEARCH_GROUNDED marker", pattern: /SEARCH_GROUNDED/i },
  { label: "write-last instruction", pattern: /write last/i },
  { label: "generation-rules instruction", pattern: /Generation rules/i },
  { label: "purpose instruction", pattern: /Purpose:\s*Product requirements/i },
  { label: "requirement instruction", pattern: /Each requirement must/i },
  { label: "conditional instruction", pattern: /Conditional:\s*only if/i },
  { label: "secondary-user instruction", pattern: /Only if they meaningfully interact/i },
  { label: "requirement-detail instruction", pattern: /Only for requirements needing elaboration/i },
  { label: "acceptance-rule instruction", pattern: /Every P0 requirement/i },
  { label: "unspecified instruction", pattern: /Use\s+`?unspecified`?\s+when unknown/i },
  { label: "generic filler instruction", pattern: /No generic filler/i },
  { label: "repeat instruction", pattern: /Repeat per use case/i },
  { label: "research instruction", pattern: /real, documented problems|Cite the source|Research this|RESEARCH FOR THIS SECTION/i },
  { label: "source instruction", pattern: /Source:\s*\(link\/report\)/i },
  { label: "generic source placeholder", pattern: /【source】|\[source\]/i },
  {
    label: "unfilled template placeholder",
    pattern:
      /\[(?:Product\s*\/\s*Feature Name|Author\s*\/\s*Owner|Date|One sentence|Primary users|Core problem|Urgency\s*\/\s*signal\s*\/\s*timing|Top 1[–-]3 outcomes\s*[—-]\s*reference §3 metrics|Major exclusions\s*[—-]\s*reference §4|user|main action|main benefit|Name|Narrative:[^\]\n]*|Task \d+|Non-goal \d+|Assumption \d+|Dependency \d+|Question \d+)\]/i,
  },
];

function cleanPrdMarkdown(markdown) {
  const cleaned = [];
  let skippingRequirementRules = false;
  let skippingAcceptanceRules = false;

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();

    if (/^<!--/.test(line)) continue;
    if (/^>\s*$/.test(line)) continue;
    if (/^>\s*(Purpose:|Generation rules:|Write last|Only if|Only for requirements|Only categories relevant|Targets must|MVP scope should|Must reference|Conditional:)/i.test(line)) {
      continue;
    }
    if (/^>\s*Repeat per use case/i.test(line)) continue;
    if (/^\s*Purpose:\s*Product requirements/i.test(line)) continue;
    if (/^\s*Generation rules:/i.test(line)) continue;
    if (/^\s*Write last/i.test(line)) continue;
    if (/^\s*Conditional:\s*only if/i.test(line)) continue;
    if (/^\s*Only if they meaningfully interact/i.test(line)) continue;
    if (/^\s*Only for requirements needing elaboration/i.test(line)) continue;
    if (/^\s*Every P0 requirement/i.test(line)) continue;
    if (/^\s*Criteria describe observable behavior/i.test(line)) continue;
    if (/^\s*Use\s+`?unspecified`?\s+when unknown/i.test(line)) continue;
    if (/^\s*No generic filler/i.test(line)) continue;
    if (/^\s*Repeat per use case/i.test(line)) continue;
    if (/real, documented problems/i.test(line)) continue;
    if (/Research this/i.test(line)) continue;

    if (/^\s*Each requirement must:/i.test(line)) {
      skippingRequirementRules = true;
      continue;
    }
    if (skippingRequirementRules) {
      if (/^## Requirements Matrix$/i.test(line)) {
        skippingRequirementRules = false;
        cleaned.push(rawLine);
      }
      continue;
    }

    if (/^## Rules$/i.test(line)) {
      skippingAcceptanceRules = true;
      continue;
    }
    if (skippingAcceptanceRules) {
      if (/^\| Req ID \|/i.test(line)) {
        skippingAcceptanceRules = false;
        cleaned.push(rawLine);
      }
      continue;
    }

    cleaned.push(
      rawLine
        .replace(/\s*Source:\s*\(link\/report\)/gi, "")
        .replace(/【source】|\[source\]/gi, "(source unavailable)")
        .replace(/<!--.*?-->/g, "")
    );
  }

  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function assertPrdQuality(markdown, label) {
  for (const rule of PRD_QUALITY_RULES) {
    if (rule.pattern.test(markdown)) {
      throw new Error(`${label}: PRD cleanup failed: ${rule.label}`);
    }
  }
}

function stripMarkdownFences(value) {
  return String(value || "")
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

// Assemble the final document from the independently-generated sections.
// Order: overview (part 1) → research evidence → requirements (part 2) → rollout (part 3).
function assembleDocument(prdParts, researchSections) {
  const researchBlock =
    "# Research & Evidence\n\n" +
    researchSections
      .map((section) => `## ${section.heading}\n\n${section.content.trim()}`)
      .join("\n\n");

  return [prdParts[0], researchBlock, prdParts[1], prdParts[2]]
    .filter(Boolean)
    .join("\n\n");
}

// ── SSE + downstream document generation ──────────────────────────────────────

// Shared SSE scaffold. Writes are guarded so concurrent tracks can't write after
// the response is closed (error / client disconnect).
function openSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  const send = (event, data) => {
    if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const end = () => {
    if (!closed) {
      closed = true;
      res.end();
    }
  };
  return { send, end };
}

// User revision comments folded into the generation prompt.
function formatNotes(notes) {
  const arr = Array.isArray(notes) ? notes : notes ? [notes] : [];
  const clean = arr.map((n) => String(n).trim()).filter(Boolean);
  if (!clean.length) return "";
  return (
    "REVISION INSTRUCTIONS — apply these user-requested changes to the document:\n" +
    clean.map((n) => `- ${n}`).join("\n") +
    "\n\n"
  );
}

// Reserve for the system prompt + section outline + streamed completion so the
// grounding never pushes the whole request past the model's per-minute ceiling.
const CONTEXT_TOKEN_RESERVE = 5200;
const MAX_CONTEXT_TOKENS = Math.max(1000, MAX_INPUT_TOKENS - CONTEXT_TOKEN_RESERVE);

// Bounded grounding context for downstream docs (respects the 120b TPM budget).
function buildDownstreamContext({ prompt, classification, prd, extra = {}, notes }) {
  let ctx =
    `ORIGINAL PROMPT:\n${prompt.substring(0, 1500)}\n\n` +
    `CLASSIFICATION (JSON):\n${JSON.stringify(classification)}\n\n` +
    `PRODUCT PRD (grounding — may be truncated):\n${prd.substring(0, 9000)}\n\n`;
  for (const [key, value] of Object.entries(extra)) {
    if (value) ctx += `${key} (grounding — may be truncated):\n${String(value).substring(0, 5000)}\n\n`;
  }
  return capTokens(ctx + formatNotes(notes), MAX_CONTEXT_TOKENS);
}

// Compact a markdown doc down to its "important parts": headings plus the first
// couple of content lines under each. Used to squeeze upstream docs into a tiny
// grounding budget without dropping structure.
function compactMarkdown(markdown, maxTokens) {
  const out = [];
  let sinceHeading = 0;
  for (const raw of String(markdown || "").split("\n")) {
    const line = raw.trimEnd();
    if (/^#{1,4}\s/.test(line)) {
      out.push(line);
      sinceHeading = 0;
      continue;
    }
    if (!line.trim()) continue;
    if (sinceHeading < 2) {
      out.push(line);
      sinceHeading++;
    }
  }
  return capTokens(out.join("\n"), maxTokens);
}

// The sprint backlog only needs a compact skeleton of the PRD + System Design.
// Combined grounding is held under BACKLOG_GROUNDING_TOKENS so the request stays
// well within the model's TPM ceiling. Test spec is intentionally excluded.
const BACKLOG_GROUNDING_TOKENS = 2000;
function buildBacklogContext({ prompt, classification, prd, systemDesign, notes }) {
  const half = Math.floor(BACKLOG_GROUNDING_TOKENS / 2);
  const prdCompact = compactMarkdown(prd, half);
  const designCompact = compactMarkdown(systemDesign, BACKLOG_GROUNDING_TOKENS - estimateTokens(prdCompact));
  const ctx =
    `ORIGINAL PROMPT:\n${prompt.substring(0, 800)}\n\n` +
    `CLASSIFICATION (JSON):\n${JSON.stringify(classification)}\n\n` +
    `PRD (compacted — key sections only):\n${prdCompact}\n\n` +
    `SYSTEM DESIGN (compacted — key sections only):\n${designCompact}\n\n` +
    formatNotes(notes);
  return capTokens(ctx, MAX_CONTEXT_TOKENS);
}

// Generate one document by streaming its fixed parts as live sections, then
// emit the assembled document via a `replace` event tagged with its docId.
async function streamDocParts(send, doc, sharedContext) {
  const partContents = [];
  for (const part of doc.parts) {
    const id = part.id;
    const action = part.title.toLowerCase();
    send("section", { id, doc: doc.docId, title: part.title, status: "generating", message: `Drafting ${action}…` });
    send("status", { phase: "generating", message: `Drafting ${action} for ${doc.title}…` });

    const stream = await completeStream(`${doc.docId}-${id}`, {
      model: MODEL_PRD,
      reasoning_effort: "low",
      max_completion_tokens: 4500,
      messages: [
        { role: "system", content: part.system },
        {
          role: "user",
          content: `${sharedContext}\nSECTION OUTLINE TO FILL (output only the finished markdown, complete every section):\n${part.outline}`,
        },
      ],
    });

    let content = "";
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        content += delta;
        send("section_delta", { id, delta });
      }
    }

    content = cleanPrdMarkdown(content);
    if (content.trim().length < 50) {
      throw new Error(`${doc.docId}/${id}: model returned near-empty content`);
    }
    send("section_content", { id, content });
    send("section", { id, doc: doc.docId, title: part.title, status: "done", message: `Completed ${action}` });
    console.log(`[${doc.docId}] ${id} approved (${content.length} chars)`);
    partContents.push(content);
  }
  const full = partContents.join("\n\n");
  send("replace", { docId: doc.docId, title: doc.title, content: full });
  return full;
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, models: { json: MODEL_JSON, prd: MODEL_PRD, search: MODEL_SEARCH, researchEnum: MODEL_ENUM } });
});

// ── Step 1: Classify ──────────────────────────────────────────────────────────

app.post("/api/classify", async (req, res) => {
  const prompt = (req.body.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  try {
    const content = await completeWithRetry("classify", {
      model: MODEL_JSON,
      temperature: classifier.temperature,
      reasoning_effort: "low",
      messages: [
        {
          role: "system",
          content: `${classifier.system_prompt}\n\nThe JSON must match this schema exactly (use ONLY the enum values listed):\n${JSON.stringify(classificationSchema)}`,
        },
        {
          role: "user",
          content: classifier.user_prompt_template.replace(
            "{{USER_PROMPT}}",
            prompt
          ),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "prd_classification",
          strict: true,
          schema: classificationSchema,
        },
      },
    });
    res.json(JSON.parse(content));
  } catch (err) {
    console.error(`[/api/classify] ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// ── Step 2: Questions ─────────────────────────────────────────────────────────

app.post("/api/questions", async (req, res) => {
  const prompt = (req.body.prompt || "").trim();
  const classification = req.body.classification;
  if (!prompt || !classification)
    return res.status(400).json({ error: "Missing prompt or classification" });

  try {
    const content = await completeWithRetry("questions-json", {
      model: MODEL_ENUM[1],
      temperature: 0.1,
      max_completion_tokens: 1200,
      messages: [
        { role: "system", content: QUESTIONS_SYSTEM_PROMPT },
        {
          role: "user",
          content: `ORIGINAL PROMPT:\n${prompt}\n\nCLASSIFICATION (JSON):\n${JSON.stringify(classification)}`,
        },
      ],
    });
    res.json(assertQuestionsSpec(parseQuestionsJson(content)));
  } catch (err) {
    console.error(`[/api/questions] ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// ── Targeted selection revision (no full regeneration) ────────────────────────

app.post("/api/revise-selection", async (req, res) => {
  const doc = String(req.body.doc || "").trim();
  const selectedText = String(req.body.selectedText || "").trim();
  const instruction = String(req.body.instruction || "").trim();
  const docTitle = String(req.body.docTitle || "Document").trim();

  if (!doc || !selectedText || !instruction) {
    return res.status(400).json({ error: "Missing doc, selectedText, or instruction" });
  }

  try {
    const content = await completeWithRetry("revise-selection", {
      model: MODEL_PRD,
      reasoning_effort: "low",
      temperature: 0.1,
      max_completion_tokens: 900,
      messages: [
        {
          role: "system",
          content:
            "You revise a SINGLE selected excerpt inside a larger markdown document. " +
            "Return ONLY the revised replacement text for the selected excerpt in markdown. " +
            "Do not rewrite other parts of the document. Do not add headings, notes, or code fences.",
        },
        {
          role: "user",
          content:
            `DOCUMENT TITLE:\n${docTitle}\n\n` +
            `FULL DOCUMENT (for context):\n${doc.substring(0, 24000)}\n\n` +
            `SELECTED EXCERPT TO REVISE:\n${selectedText}\n\n` +
            `REVISION INSTRUCTION:\n${instruction}\n\n` +
            "Output only the revised replacement text for the selected excerpt.",
        },
      ],
    });

    const replacement = stripMarkdownFences(content);
    if (!replacement) {
      return res.status(502).json({ error: "Revision model returned empty content" });
    }
    res.json({ replacement });
  } catch (err) {
    console.error(`[/api/revise-selection] ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// ── Step 2.5: Update Classification ───────────────────────────────────────────

// ── Shared Utils ──────────────────────────────────────────────────────────────

async function mergeAnswers(prompt, classification, answers) {
  if (!answers || Object.keys(answers).length === 0) return classification;
  
  console.log("[Merge] Merging user answers into classification JSON...");
  const content = await completeWithRetry("merge-answers", {
    model: MODEL_JSON,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: "You are an AI assistant. Update the provided classification JSON by incorporating the user's answers. Modify fields (like summary, users, stage, etc.) to reflect the new information, and remove items from 'missing_context' that the answers have resolved. Output ONLY the updated JSON matching the exact schema provided.",
      },
      {
        role: "user",
        content: `ORIGINAL PROMPT:\n${prompt}\n\nORIGINAL CLASSIFICATION:\n${JSON.stringify(classification)}\n\nUSER ANSWERS:\n${JSON.stringify(answers)}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "prd_classifier",
        strict: true,
        schema: classificationSchema,
      },
    },
  });
  
  const merged = JSON.parse(content);
  console.log("[Merge] Modified Classification:", JSON.stringify(merged));
  return merged;
}

// ── Step 3: Generate PRD (SSE stream + section-merged research) ───────────────

app.post("/api/generate-prd", async (req, res) => {
  const prompt = (req.body.prompt || "").trim();
  const classification = req.body.classification;
  const answers = req.body.answers || {};
  const notes = req.body.notes;
  if (!prompt || !classification)
    return res.status(400).json({ error: "Missing prompt or classification" });

  // Set up SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Guard writes: research and PRD tracks run concurrently, so once the response
  // is closed (error, client disconnect) the still-running track must not write.
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const end = () => {
    if (closed) return;
    closed = true;
    res.end();
  };

  // Per-part status wording — describes the action in progress, no "N/3".
  const partMeta = [
    {
      generating: "Drafting overview — problem, users, goals & scope",
      done: "Completed overview",
    },
    {
      generating: "Drafting requirements & compliance",
      done: "Completed requirements & compliance",
    },
    {
      generating: "Drafting rollout, risks & acceptance criteria",
      done: "Completed rollout, risks & acceptance",
    },
  ];

  try {
    // ── Phase 1: Merge answers into classification ──────────
    send("status", { phase: "researching", message: "Updating classification context…" });
    const modifiedClassification = await mergeAnswers(prompt, classification, answers);

    // ── Phase 2: Research + PRD run concurrently on separate TPM budgets ──────────
    // (research: groq/compound-mini · PRD: openai/gpt-oss-120b)
    send("status", { phase: "generating", message: "Researching and drafting your PRD…" });

    const sharedContext =
      `ORIGINAL PROMPT:\n${prompt.substring(0, 3000)}\n\n` +
      `MODIFIED CLASSIFICATION (JSON):\n${JSON.stringify(modifiedClassification)}\n\n` +
      formatNotes(notes);

    const runPrdParts = async () => {
      const parts = [];
      for (let i = 0; i < templateParts.length; i++) {
        const partNum = i + 1;
        const id = `prdPart${partNum}`;

        send("section", { id, status: "generating", message: partMeta[i].generating });
        send("status", { phase: "generating", message: partMeta[i].generating });

        const stream = await completeStream(`prd-part-${partNum}`, {
          model: MODEL_PRD,
          reasoning_effort: "low",
          max_completion_tokens: 4500,
          messages: [
            { role: "system", content: prdPartSystemPrompt(partNum) },
            {
              role: "user",
              content: `${sharedContext}\nTEMPLATE PART ${partNum} OF 3 TO FILL:\n${templateParts[i]}`,
            },
          ],
        });

        let partContent = "";
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            partContent += delta;
            send("section_delta", { id, delta });
          }
        }

        partContent = cleanPrdMarkdown(partContent);
        assertPrdQuality(partContent, `part ${partNum}`);

        send("section_content", { id, content: partContent });
        send("section", { id, status: "done", message: partMeta[i].done });
        console.log(`[generate-prd] ${id} approved (${partContent.length} chars)`);
        parts.push(partContent);
      }
      return parts;
    };

    const [researchSections, prdParts] = await Promise.all([
      runResearch(prompt, modifiedClassification, send),
      runPrdParts(),
    ]);

    // ── Phase 3: Assemble + validate the final document ──────────
    let fullMarkdown = assembleDocument(prdParts, researchSections);
    fullMarkdown = cleanPrdMarkdown(fullMarkdown);
    assertPrdQuality(fullMarkdown, "full PRD");

    send("status", { phase: "done", message: "PRD ready" });
    send("replace", { docId: "prd", title: "PRD", content: fullMarkdown });
    send("done", {});
    end();
  } catch (err) {
    console.error(`[/api/generate-prd] ${err.message}`);
    send("error", { message: err.message });
    end();
  }
});

// ── Step 4: System Design + Test Spec (SSE, yellow stage) ─────────────────────

app.post("/api/generate-design", async (req, res) => {
  const prompt = (req.body.prompt || "").trim();
  const classification = req.body.classification;
  const prd = (req.body.prd || "").trim();
  const notes = req.body.notes;
  if (!prompt || !classification || !prd)
    return res.status(400).json({ error: "Missing prompt, classification, or prd" });

  const { send, end } = openSse(res);
  try {
    const sharedContext = buildDownstreamContext({ prompt, classification, prd, notes });
    send("status", { phase: "generating", message: "Designing the system…" });
    for (const doc of DOC_SETS.design) {
      await streamDocParts(send, doc, sharedContext);
    }
    send("status", { phase: "done", message: "System design & test spec ready" });
    send("done", {});
    end();
  } catch (err) {
    console.error(`[/api/generate-design] ${err.message}`);
    send("error", { message: err.message });
    end();
  }
});

// ── Step 5: Sprint Backlog (SSE, green stage) ─────────────────────────────────

app.post("/api/generate-backlog", async (req, res) => {
  const prompt = (req.body.prompt || "").trim();
  const classification = req.body.classification;
  const prd = (req.body.prd || "").trim();
  const systemDesign = (req.body.systemDesign || "").trim();
  const testSpec = (req.body.testSpec || "").trim();
  const notes = req.body.notes;
  if (!prompt || !classification || !prd)
    return res.status(400).json({ error: "Missing prompt, classification, or prd" });

  const { send, end } = openSse(res);
  try {
    const sharedContext = buildBacklogContext({ prompt, classification, prd, systemDesign, notes });
    console.log(`[/api/generate-backlog] grounding ≈ ${estimateTokens(sharedContext)} input tokens`);
    send("status", { phase: "generating", message: "Planning the sprint backlog…" });
    for (const doc of DOC_SETS.backlog) {
      await streamDocParts(send, doc, sharedContext);
    }
    send("status", { phase: "done", message: "Sprint backlog ready" });
    send("done", {});
    end();
  } catch (err) {
    console.error(`[/api/generate-backlog] ${err.message}`);
    send("error", { message: err.message });
    end();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

async function start() {
  app.listen(PORT, () => {
    console.log(`[server] PRD Agent API running on http://localhost:${PORT}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((err) => {
    console.error(`[server] Startup failed: ${err.message}`);
    process.exit(1);
  });
}
