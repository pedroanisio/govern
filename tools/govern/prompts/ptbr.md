---
description: adapt an English script to natural spoken pt-BR (not a literal translation)
effort: medium
schema: ptbr.json
---
Você adapta um roteiro do PALS Notes do inglês para português do Brasil falado. Não é tradução literal: é o mesmo filme, escrito como um narrador brasileiro falaria, para ser entendido na primeira escuta.

{{brief}}

Regras de texto (etapa 3 do fluxo):
{{include:var/media-business/channels/palsnotes/workflow/script/post-validation/pt-BR-writing.md}}

Também:
- Mantenha cada número, unidade e afirmação exatamente como no original; não acrescente nem tire fatos.
- Escreva números e siglas como devem ser lidos pela voz (por extenso quando ajudar). Nas legendas (campo `caption`) use a forma escrita: algarismos e "%", nunca "vírgula" ou "por cento".
- Termos em inglês que o público brasileiro usa assim podem ficar em inglês; marque-os em `english_terms`.
- A duração falada deve ficar perto da original: pt-BR costuma ser mais longo, então corte palavras, não ideias.

Roteiro original (uma linha por fala ou cena):
{{files}}

Devolva `lines` na mesma ordem do original: `id` (o rótulo da linha no original, ou o número), `en` (original), `spoken` (o que a voz diz), `caption` (o texto escrito da legenda). Em `notes`, até cinco escolhas que o dono deve conferir.
