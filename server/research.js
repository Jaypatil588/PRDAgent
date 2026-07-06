// Research module — a SINGLE Groq Compound Mini web-search call returns all four
// research sections as one JSON object, which is parsed into sections on return.
// Compound is agentic (web search) and does not support strict json_schema output,
// so we instruct a JSON object and parse it robustly.
import { completeWithRetry, MODEL_ENUM } from "./groq.js";

const SECTIONS = [
  {
    id: "useCases",
    heading: "Use cases & pain points",
    action: "use cases & pain points",
    task: "real, documented use cases and user pain points for this product",
  },
  {
    id: "metrics",
    heading: "Metrics & benchmarks",
    action: "metrics & benchmarks",
    task: "numeric industry benchmarks or KPIs relevant to measuring this product's success",
  },
  {
    id: "scope",
    heading: "Scope & capabilities",
    action: "scope & capabilities",
    task: "common MVP capabilities and later differentiators for products like this",
  },
  {
    id: "compliance",
    heading: "Compliance & privacy",
    action: "compliance & privacy",
    task: "privacy, security, accessibility, and regulatory obligations relevant to this product",
  },
];

const RESEARCH_SYSTEM = `You are a research assistant with live web search. Research the product described and return ONLY a single JSON object — no prose, no explanation, no markdown code fences.

The object MUST have exactly these keys: "useCases", "metrics", "scope", "compliance".
Each value is a markdown string containing exactly 3 concise, sourced bullets. Each bullet is on its own line, starts with "- ", and is under 28 words. Do not add headings inside the values. Do not write PRD requirements.`;

export async function runResearch(prompt, classification, send) {
  console.log("[Research] Starting single-call research (JSON)...");

  const product = classification.summary || prompt.substring(0, 300);
  const context = [
    `Product: ${product}`,
    `Target users: ${JSON.stringify(classification.users || [])}`,
    `Platforms: ${JSON.stringify(classification.platforms || [])}`,
    `Data sensitivity: ${classification.data_sensitivity || "unspecified"}`,
  ].join("\n");

  const task =
    "Produce the JSON object now. Each key must contain 3 bullets covering:\n" +
    SECTIONS.map((s) => `- "${s.id}": ${s.task}.`).join("\n");

  // All four sections enter "generating" — one call fills them together.
  for (const section of SECTIONS) {
    send?.("section", {
      id: section.id,
      status: "generating",
      message: `Researching ${section.action}…`,
    });
  }
  send?.("status", { phase: "generating", message: "Researching real-world context…" });

  const content = await completeWithRetry("research_all", {
    model: MODEL_ENUM[1],
    temperature: 0.1,
    max_completion_tokens: 1800,
    messages: [
      { role: "system", content: RESEARCH_SYSTEM },
      { role: "user", content: `${context}\n\n${task}` },
    ],
  });

  const parsed = parseResearchJson(content);

  const results = [];
  for (const section of SECTIONS) {
    send?.("section", {
      id: section.id,
      status: "awaiting_approval",
      message: `Reviewing ${section.action} findings…`,
    });

    const cleaned = cleanResearchMarkdown(parsed[section.id]);
    if (!cleaned) {
      throw new Error(`research: "${section.id}" missing or empty in model JSON`);
    }

    send?.("section_content", { id: section.id, content: cleaned });
    send?.("section", {
      id: section.id,
      status: "approved",
      message: `Completed ${section.action} research`,
    });

    results.push({ id: section.id, heading: section.heading, content: cleaned });
  }

  console.log("[Research] Single-call research complete");
  return results;
}

function parseResearchJson(content) {
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("research: response did not contain a JSON object");
  }
  const json = stripped.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("research: response JSON must be an object");
  }
  return parsed;
}

function cleanResearchMarkdown(markdown) {
  if (typeof markdown !== "string") return "";
  return markdown
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
