# Modular PRD Template: [Product / Feature Name]

[Author / Owner] — [Date]

> Purpose: Product requirements only. Architecture, schema, APIs, infra, tasks, and sprint planning come after PRD approval.
>
> Generation rules: Use `unspecified` when unknown. Never invent evidence, metrics, users, or constraints.

---

## 0. Executive Summary

> Write last after all other sections are complete.

- **What are we building?** [One sentence]
- **Who is it for?** [Primary users]
- **What problem does it solve?** [Core problem]
- **Why now?** [Urgency / signal / timing]
- **What does success look like?** [Top 1–3 outcomes — reference §3 metrics]
- **What is out of scope?** [Major exclusions — reference §4]

---

# 1. Problem & Solution

## Problem Statement

What we are trying to do, our intention and goals, and why.

## Proposed Solution

The product will allow [user] to [main action] so they can [main benefit]. User-facing value only; no implementation details.

---

# 2. Users & Use Cases

<!-- SEARCH_GROUNDED: use_cases -->

## Primary Users

| Persona | Description | Main Goal | Pain Point |
|---|---|---|---|

## Secondary Users

> Only if they meaningfully interact, manage, approve, or support.

| Persona | Description | Role in Product |
|---|---|---|

## Main Use Cases

Write as natural narrative stories, not template fill-ins. Each use case must be grounded in real, documented problems — real forum complaints, user reviews, industry reports, support tickets. Never invent scenarios. Cite the source.

### UC-1: [Name]

[Narrative: who the user is, the real situation they face, what they do today, what they need instead. Free-form prose. Source: (link/report)]

Tasks:
- [Task 1]

> Repeat per use case with stable IDs (UC-2, UC-3…).

---

# 3. Goals, Non-Goals & Metrics

<!-- SEARCH_GROUNDED: metrics -->

## Goals & Metrics

| Type (Business/User) | Goal | Metric | Target | Measurement Method | Timeframe |
|---|---|---|---:|---|---|

> Targets must reference real industry benchmarks found via research, not invented numbers.

## Non-Goals

This product will not:

- [Non-goal 1]

---

# 4. Scope & Phasing

<!-- SEARCH_GROUNDED: scope -->

## MVP Scope

| Area | Included |
|---|---|

> MVP scope should be informed by what competitors and similar products actually ship.

## Out of Scope

| Item | Reason |
|---|---|

---

# 5. Functional Requirements

Each requirement must:

- Have a stable ID (FR-1, FR-2…).
- Describe one observable product behavior, from user/product perspective.
- Avoid implementation details.
- Use `unspecified` when unknown.
- Have priority P0 / P1 / P2.
- Map to a use case or goal.

## Requirements Matrix

| ID | Priority | User / Role | Requirement | Linked Goal / UC |
|---|---|---|---|---|

## Requirement Details

> Only for requirements needing elaboration beyond the matrix row.

---

# 6. Non-Functional Requirements

> Only categories relevant to the product. No generic filler.

| Category (Performance / Reliability / Usability / Accessibility / Maintainability) | ID (NFR-1…) | Requirement | Target |
|---|---|---|---|

---

# 7. Data, Privacy, Security & Compliance

<!-- SEARCH_GROUNDED: compliance -->

## Data Inputs

## Data Outputs

## Privacy Requirements

## Security Requirements

## Compliance Requirements

> Must reference actual regulations, standards, and legal requirements applicable to this product domain. Never invent compliance obligations.

---

# 8. Roles & Permissions

> Conditional: only if multiple roles, admin actions, approval states, or access boundaries exist.

| Role | Can Do | Cannot Do |
|---|---|---|

---

# 9. Analytics & Tracking

> Conditional: only if measurement, monitoring, experimentation, or reporting needed. Metrics live in §3 — here define only tracking specifics.

| Metric (ref §3) | Event / Signal Tracked | Tool / Method |
|---|---|---|

---

# 10. Operations, Support & Rollout

> Conditional: for customer-facing, enterprise, or high-risk launches.

## Documentation Needed

- User guide / Admin guide / FAQ / Release notes / Known limitations

## Rollout Strategy

## Rollback / Pause Criteria

Pause or roll back if:

---

# 11. Risks, Assumptions, Dependencies & Open Questions

## Risks

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|

## Assumptions

- [Assumption 1]

## Dependencies

- [Dependency 1]

## Open Questions

- [Question 1]

---

# 12. Acceptance Criteria

## Rules

- Every P0 requirement: ≥1 criterion. P1: criteria when it affects user behavior or launch readiness.
- Criteria describe observable behavior; no implementation details.

| Req ID | Criterion (Given / When / Then) |
|---|---|
