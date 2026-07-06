// Research module — compact Groq Compound Mini search context for PRD generation
import { completeWithRetry, MODEL_ENUM } from "./groq.js";

export async function runResearch(prompt, classification) {
  console.log("[Research] Starting combined research query...");

  const content = await completeWithRetry("research_combined", {
    model: MODEL_ENUM[1],
    temperature: 0.1,
    max_completion_tokens: 1600,
    messages: [
      {
        role: "system",
        content:
          "You are an expert product researcher. Use the web search tool to find real, factual information. Do not invent data. Return only valid JSON.",
      },
      {
        role: "user",
        content: `Product: "${classification.summary || prompt.substring(0, 300)}"

Intent: ${classification.intent || "unspecified"}
Target users: ${JSON.stringify(classification.users || [])}
Platforms: ${JSON.stringify(classification.platforms || [])}
Stage: ${classification.stage || "unspecified"}
Data sensitivity: ${classification.data_sensitivity || "unspecified"}
Risk flags: ${JSON.stringify(classification.risk_flags || [])}

Research this product category and return this exact JSON shape:
{
  "use_cases": "3 concise real user pain points/use cases with source URLs or report names.",
  "metrics": "4 concise KPIs or benchmarks with sourced numbers when available.",
  "scope": "Concise must-have MVP features vs later differentiators with sources.",
  "compliance": "Concise real privacy, security, compliance requirements with sources."
}

Each value must be a string. If evidence is unavailable, say "unspecified" inside that string and explain what should be measured or confirmed. Do not add markdown fences or prose outside JSON.`,
      },
    ],
  });

  const researchObj = JSON.parse(content);
  for (const key of ["use_cases", "metrics", "scope", "compliance"]) {
    if (typeof researchObj[key] !== "string" || researchObj[key].trim().length === 0) {
      throw new Error(`research_combined: ${key} must be a non-empty string`);
    }
  }
  console.log("[Research] Combined research complete");
  return researchObj;
}
