---
description: write Short hook options (first 2–3 s) and pick one, with the reason
effort: medium
schema: schemas/hooks.json
rules: rules/hooks.json
---
You write the opening line of a PALS Notes Short. Viewers decide in the first 2–3 seconds whether to stay.

{{brief}}

Rules (WORKFLOW.md, "The first seconds"):
- The hook is said in the first 2–3 s: at most 8 words, word for word as narrated.
- Open on a use or on something the viewer recognises, with a short sentence, a bold claim or a direct promise the Short keeps.
- Never "in this video", "did you know", the channel's name, or context before the claim.
- It must be true to the material below; no claim the script or sources do not support.
- Write in {{lang}}. Siblings from the same film must not share an opening, so make the options differ in approach, not wording.

Material:
{{files}}

Extra direction from the owner (may be empty): {{opt.direction}}

Return 5 options in `hooks` (text, approach, on_screen: what the first frame shows, risk: what could make a viewer swipe), the index of the best in `chosen`, and `reason`: one or two sentences.
