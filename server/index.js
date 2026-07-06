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
} from "./groq.js";
import { runResearch } from "./research.js";
import { templateParts } from "./template.js";

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

// ── PRD part system prompts ───────────────────────────────────────────────────

function prdPartSystemPrompt(part, hasResearch) {
  const researchNote = hasResearch
    ? `\n- RESEARCH CONTEXT is provided from real web searches. Use it to ground use cases, metrics, scope, and compliance in real-world data. Cite sources from the research where appropriate.`
    : "";

  const partNote =
    part === 1
      ? `\n- The template's title line says "Modular PRD Template: [Product / Feature Name]" — replace the ENTIRE line with "# <actual product name> — PRD".`
      : `\n- Do not add a document title or executive summary — that exists in an earlier part. Start directly with the first section of your template part.`;

  return `You are a product manager writing ONE PART of a larger PRD. The full PRD is produced in 3 parts by separate calls and concatenated afterwards; you are writing PART ${part} of 3.

Rules:
- Fill in ONLY the template part provided. Follow its structure and section order exactly. Replace every [bracketed placeholder] with concrete content.
- Ground everything in the original prompt, the classification, the user's answers, and any research context provided.${researchNote}
- Where something is unspecified, make a clearly reasonable assumption and mark it as an assumption rather than a fact.
- Use cases must be written as natural narrative stories reflecting real problems — NOT templatey "As a [user], I want [action]" format.
- This document is product requirements only: do NOT include system design, architecture, database schema, API contracts, or sprint tasks.
- Do NOT include template instructions, HTML comments, generation notes, "write last", "SEARCH_GROUNDED", "Conditional:", "Each requirement must", or generic citation placeholders like "[source]" or "【source】".
- Use actual source URLs/report names from research when available. If research lacks a source URL, write "source unavailable" instead of a placeholder.
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
  { label: "generic source placeholder", pattern: /【source】|\[source\]/i },
  {
    label: "unfilled template placeholder",
    pattern:
      /\[(?:Product|Feature|Author|Owner|Date|One sentence|Primary users|Core problem|Urgency|Top|Major|user|main action|main benefit|Name|Task \d|Non-goal|Item|Reason|Assumption|Dependency|Question)[^\]\n]*\]/i,
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
    const content = await completeWithRetry("questions", {
      model: MODEL_ENUM[1],
      temperature: 0.2,
      max_completion_tokens: 1200,
      messages: [
        { role: "system", content: QUESTIONS_SYSTEM_PROMPT },
        {
          role: "user",
          content: `ORIGINAL PROMPT:\n${prompt}\n\nCLASSIFICATION (JSON):\n${JSON.stringify(classification)}`,
        },
      ],
    });
    res.json(assertQuestionsSpec(JSON.parse(content)));
  } catch (err) {
    console.error(`[/api/questions] ${err.message}`);
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

// ── Step 3: Generate PRD (research + SSE stream) ──────────────────────────────

app.post("/api/generate-prd", async (req, res) => {
  const prompt = (req.body.prompt || "").trim();
  const classification = req.body.classification;
  const answers = req.body.answers || {};
  if (!prompt || !classification)
    return res.status(400).json({ error: "Missing prompt or classification" });

  // Set up SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // ── Phase 1: Merge Answers ──────────
    send("status", { phase: "researching", message: "Updating classification context…" });
    const modifiedClassification = await mergeAnswers(prompt, classification, answers);

    // ── Phase 2: Research ──────────
    send("status", { phase: "researching", message: "Researching real-world context…" });
    const rawResearch = await runResearch(prompt, modifiedClassification);
    
    send("status", { phase: "research_done", message: "Research complete" });

    // ── Phase 4: Generate PRD in 3 parts ─────
    const sharedContext =
      `ORIGINAL PROMPT:\n${prompt.substring(0, 3000)}\n\n` +
      `MODIFIED CLASSIFICATION (JSON):\n${JSON.stringify(modifiedClassification)}\n\n`;

    let fullMarkdown = "";

    for (let i = 0; i < templateParts.length; i++) {
      const partNum = i + 1;
      send("status", {
        phase: "generating",
        part: partNum,
        total: 3,
        message: `Writing part ${partNum}/3…`,
      });

      let partResearch = "";
      if (partNum === 1) {
        partResearch = `\n\nRESEARCH FOR THIS SECTION:\n- Use Cases: ${rawResearch.use_cases}\n- Metrics: ${rawResearch.metrics}\n- Scope: ${rawResearch.scope}\n`;
      } else if (partNum === 2) {
        partResearch = `\n\nRESEARCH FOR THIS SECTION:\n- Compliance: ${rawResearch.compliance}\n`;
      }

      const stream = await completeStream(`prd-part-${partNum}`, {
        model: MODEL_PRD,
        reasoning_effort: "low",
        max_completion_tokens: 4500,
        messages: [
          {
            role: "system",
            content: prdPartSystemPrompt(partNum, !!partResearch),
          },
          {
            role: "user",
            content: `${sharedContext}${partResearch}\nTEMPLATE PART ${partNum} OF 3 TO FILL:\n${templateParts[i]}`,
          },
        ],
      });

      let partContent = "";
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          partContent += delta;
        }
      }

      partContent = cleanPrdMarkdown(partContent);
      assertPrdQuality(partContent, `part ${partNum}`);
      send("chunk", { part: partNum, content: partContent });

      if (i < templateParts.length - 1) {
        send("chunk", { part: partNum, content: "\n\n" });
        partContent += "\n\n";
      }

      fullMarkdown += partContent;
      console.log(
        `[generate-prd] part ${partNum}/3 done (${partContent.length} chars)`
      );
    }

    fullMarkdown = cleanPrdMarkdown(fullMarkdown);
    assertPrdQuality(fullMarkdown, "full PRD");
    send("done", {});
    res.end();
  } catch (err) {
    console.error(`[/api/generate-prd] ${err.message}`);
    send("error", { message: err.message });
    res.end();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

async function start() {
  app.listen(PORT, () => {
    console.log(`[server] PRD Agent API running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error(`[server] Startup failed: ${err.message}`);
  process.exit(1);
});
