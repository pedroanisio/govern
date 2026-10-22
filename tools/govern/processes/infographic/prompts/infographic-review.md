---
description: inspect the actual candidate images and verify their editorial claims
effort: high
repairs: 1
schema: ../schemas/review.json
---
ARCHITECTURAL REQUIREMENT: LLMs will always produce some form of error.
Absence of output verification is a design defect, not a runtime bug.
All LLM output must be treated as untrusted and validated explicitly.

{{brief}}

Candidate manifest, operator brief, plan and authoritative evidence:
{{files}}

Inspect the three attached images: full resolution, half-size and quarter-size. If an
image is missing, inaccessible or not inspected, set that inspected flag false and
verdict revise. Never infer image quality from source code or a successful render.
Copy candidateSha256 from the attached manifest, never invent it. Identify yourself in
reviewer. Judge this exact frame, not the author's intent.

Score fidelity, narrative clarity, originality and visual finish from 0 to 10, citing
specific labels, regions and source locators as evidence for every score. Check
quantities, units, proportions, uncertainty, assumptions, color semantics and sources.
Check the main message, entry point, reading order, explicit relationships and conclusion.
Check text at reduced sizes, contrast, margins, clipping, overlaps, density and ambiguous
leaders. Every decorative effect must earn its place by helping explanation.

Ready requires no unresolved issues, each score >=8.5, fidelity >=9 and mean >=9.
Do not round a failing mean upward. These are editorial judgements, not objective
measurements. If any criterion fails, list concrete fixes and return revise. Quality
claims and a filled checklist do not replace inspecting the supplied pixels.
The operator's final approval is separate; never claim or record it here.
