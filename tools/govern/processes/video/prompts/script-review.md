---
description: review a script against the channel's style guide and the read-aloud checks
effort: medium
schema: schemas/script-review.json
---
You review a PALS Notes script before it is recorded. Judge it as a listener hearing it once.

{{brief}}

The channel's script style guide:
{{include:paths.scriptStyleGuide}}

The read-aloud checks for this language ({{lang}}): use the en-US list for English and the pt-BR list for Portuguese.
{{include:paths.enUsWritingGuide}}
{{include:paths.ptBrWritingGuide}}

Script:
{{files}}

Owner's direction (may be empty): {{opt.direction}}

Return at most 12 issues, most important first, each with the line as written, the problem, the rule it breaks (section name), and a rewrite in the script's own voice. Answer the five story questions (stop in the first second? stay to the end? worth it? does the ending deliver the opening's promise? a line someone would repeat?) with yes/no and one sentence each. `verdict`: ready, minor-fixes or rewrite.
