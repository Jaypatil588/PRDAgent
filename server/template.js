// Template loading + splitting
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export const prdTemplate = readFileSync(resolve(ROOT, "PRD_template.md"), "utf-8");

export function cleanTemplateForGeneration(template) {
  const cleaned = [];
  let skippingRequirementRules = false;
  let skippingAcceptanceRules = false;

  for (const rawLine of template.split("\n")) {
    const line = rawLine.trim();

    if (/^>\s*$/.test(line)) continue;
    if (/^<!--/.test(line)) continue;
    if (/^>\s*(Purpose:|Generation rules:|Write last|Only if|Only for requirements|Only categories relevant|Targets must|MVP scope should|Must reference|Conditional:)/i.test(line)) {
      continue;
    }
    if (/^>\s*Repeat per use case/i.test(line)) continue;
    if (/Each use case must be grounded in real, documented problems/i.test(line)) continue;
    if (/Source:\s*\(link\/report\)/i.test(line)) {
      cleaned.push(rawLine.replace(/\s*Source:\s*\(link\/report\)/i, ""));
      continue;
    }

    if (/^Each requirement must:/i.test(line)) {
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
      } else {
        continue;
      }
    }

    cleaned.push(rawLine);
  }

  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/**
 * Split template into 3 parts for generation:
 *   Part 1: §0 (exec summary) + §1-§4
 *   Part 2: §5-§7
 *   Part 3: §8-§12
 *
 * Splits at "# 5." and "# 8."
 */
export function splitTemplate(template) {
  const cut5 = template.search(/^# 5\. /m);
  const cut8 = template.search(/^# 8\. /m);
  if (cut5 === -1 || cut8 === -1) {
    throw new Error(
      "PRD_template.md: expected section headers '# 5.' and '# 8.' not found"
    );
  }
  return [
    template.slice(0, cut5),
    template.slice(cut5, cut8),
    template.slice(cut8),
  ];
}

export const templateParts = splitTemplate(cleanTemplateForGeneration(prdTemplate));
