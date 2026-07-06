// Downstream document templates (System Design, Test Spec, Sprint Backlog).
// Each doc has a FIXED part structure so every generation of a given type has the
// same document structure. Parts are generated separately (to respect the 120b
// token budget) and concatenated. Part 1 owns the document title; later parts do not.

function docSystem(docName, isFirst) {
  const titleNote = isFirst
    ? `\n- Begin with a single H1 title line: "# <product name> — ${docName}".`
    : `\n- Do NOT repeat the document title; start directly with the first section of this part.`;
  return `You are a senior software engineer writing the "${docName}" document for a product. It is grounded in the product's PRD and classification provided by the user.

Rules:
- Fill in ONLY the section outline provided for this part. Keep the section headings and order exactly as given. Replace every [bracketed placeholder] with concrete, specific content grounded in the PRD.
- Where something is unspecified, make a clearly reasonable engineering assumption and label it as an assumption.
- Be concrete and technical. Use markdown tables where the outline asks for them. Keep prose tight.
- Do NOT include HTML comments, outline instructions, or leftover placeholders in your output.
- Return ONLY the finished markdown for this part — no preamble, no commentary, no code fences around the document.${titleNote}`;
}

export const SYSTEM_DESIGN = {
  docId: "systemDesign",
  title: "System Design",
  parts: [
    {
      id: "sd1",
      title: "Context, goals & architecture",
      system: docSystem("System Design", true),
      outline: `## 1. Overview & Context
[What the system is and the problem it solves, 2-3 sentences grounded in the PRD.]

## 2. Goals & Non-Goals
[Bulleted technical goals and explicit non-goals.]

## 3. Architecture Overview
[Describe the high-level architecture and the main runtime components and how a request flows between them. Include a bulleted component list.]

## 4. Key Components & Responsibilities
[For each major component: its responsibility and key technology choice.]

## 5. Data Model
[Core entities as a markdown table: | Entity | Key Fields | Relationships | Notes |. Describe important relationships.]`,
    },
    {
      id: "sd2",
      title: "Interfaces, scaling, security & risks",
      system: docSystem("System Design", false),
      outline: `## 6. APIs & Interfaces
[Key interfaces/endpoints as a markdown table: | Interface | Method/Type | Purpose | Request | Response |.]

## 7. Data Flow & Sequences
[Describe the main end-to-end flows step by step.]

## 8. Scalability & Performance
[Expected load, bottlenecks, caching, scaling strategy, target latencies.]

## 9. Reliability & Availability
[Failure modes, redundancy, backups, SLAs/SLOs.]

## 10. Security & Privacy
[AuthN/AuthZ, data protection, compliance considerations grounded in the PRD's data sensitivity.]

## 11. Observability
[Logging, metrics, tracing, alerting.]

## 12. Deployment & Infrastructure
[Environments, CI/CD, hosting, rollout strategy.]

## 13. Trade-offs, Alternatives & Risks
[Key decisions, alternatives considered, and technical risks with mitigations.]`,
    },
  ],
};

export const TEST_SPEC = {
  docId: "testSpec",
  title: "Test Specification",
  parts: [
    {
      id: "ts1",
      title: "Scope, strategy & environments",
      system: docSystem("Test Specification", true),
      outline: `## 1. Scope & Objectives
[What is and is not covered by testing for this product, grounded in the PRD.]

## 2. Test Strategy & Approach
[Overall approach: levels of testing, automation vs manual, tooling.]

## 3. Test Types
[Cover unit, integration, end-to-end, performance, security, and accessibility testing — what each targets here.]

## 4. Test Environments & Data
[Environments needed and test data strategy.]`,
    },
    {
      id: "ts2",
      title: "Test cases, criteria & traceability",
      system: docSystem("Test Specification", false),
      outline: `## 5. Test Cases
[Concrete test cases as a markdown table covering the key PRD requirements: | ID | Feature | Preconditions | Steps | Expected Result | Priority |. Include at least 8 cases.]

## 6. Entry & Exit Criteria
[Criteria to start and to consider testing complete.]

## 7. Requirements Traceability
[Markdown table mapping PRD requirements to test case IDs: | Requirement | Test Case IDs |.]

## 8. Defect Management
[Severity/priority definitions and the defect workflow.]

## 9. Risks & Mitigations
[Testing risks and mitigations.]`,
    },
  ],
};

export const SPRINT_BACKLOG = {
  docId: "backlog",
  title: "Sprint Backlog",
  parts: [
    {
      id: "sb1",
      title: "Sprint goal & backlog items",
      system: docSystem("Sprint Backlog", true),
      outline: `## 1. Sprint Goal
[One clear, outcome-focused sprint goal grounded in the PRD's MVP scope.]

## 2. Sprint Details
[Sprint duration, team capacity, and roles as a short list.]

## 3. Backlog Items
[Derive user stories from the PRD requirements. Present as a markdown table grouped by epic: | ID | User Story | Epic | Priority | Story Points | Status | Assignee |. User stories in "As a <role>, I want <goal> so that <benefit>" form. Use realistic story points (1,2,3,5,8) and statuses (To Do/In Progress/Done). Include at least 10 items.]`,
    },
    {
      id: "sb2",
      title: "Epics, DoD & retrospective",
      system: docSystem("Sprint Backlog", false),
      outline: `## 4. Epics Overview
[Markdown table: | Epic | Description | # Stories | Total Points |.]

## 5. Definition of Done
[Bulleted, checkable Definition of Done.]

## 6. Dependencies & Risks
[Cross-story dependencies and sprint risks.]

## 7. Sprint Retrospective
[Template with three subsections to fill during the retro: What went well, What could be improved, Action items.]`,
    },
  ],
};

export const DOC_SETS = {
  design: [SYSTEM_DESIGN, TEST_SPEC],
  backlog: [SPRINT_BACKLOG],
};
