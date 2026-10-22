---
generated_by: Codex via ChatGPT Work
version: 1.0.0
---

# Infographic lane

Part of [super-tools](../../../../README.md).

Produce one self-contained editorial infographic from the operator's content. Default:
3840 × 2160; requested portrait: 2160 × 3840. Recompose for portrait. No animation,
voice-over or explanatory chat is necessary to understand the delivered image.

## Configure once

Use Python 3.11 or later. Install the current sr-core checkout with its validation extra, the Python requirements
in this folder, and a compatible scene-render binary. Inspect both repositories before
using their APIs; the tested baseline is sr-core 1.7.0 and scene-render 0.6.0. Use
`sr_core.scene.describe()` and the engine capability manifest instead of guessing APIs.

Set `paths.infographicPipeline` in the existing workspace config to the absolute path
of `pipeline.py`. Preserve other config values. Set `GOVERN_PYTHON` to the Python interpreter
in the environment containing these dependencies. Put `scene-render` on PATH or export
`SCENE_RENDER_BIN`. Render on the host selected for this lane, using its command override
when needed; never silently change hosts.

```bash
python -m pip install -e '/path/to/sr-core[validate]'
python -m pip install -r /path/to/super-tools/tools/govern/processes/infographic/requirements.txt
govern new graphics/topic --process infographic --lang pt-BR --title 'Topic'
govern manual infographic
```

## Intake and evidence

Write `brief.json` in the lane using [schemas/brief.json](schemas/brief.json): version,
title, content, audience and language; orientation is optional and defaults to landscape. The operator can supply a URL, PDF,
dataset or text in content. See [the cosmology brief](examples/brief.json) for an input example. A URL alone is not evidence: retrieve and read the complete
relevant material, preserving its version and locators under `sources/`. Cite the operator
as the source when the content is their own assertion; do not turn it into an externally
verified fact. Missing or contradictory evidence is reported, not invented.

```bash
govern run graphics/topic input
govern advance graphics/topic
govern ask graphics/topic infographic-plan --file brief.json --file sources/article.txt
```

`ask` writes its verified result under `govern/ask/`. Place that returned JSON at
`plan.json`, then run the semantic check before using it. Do not repair an ask failure
by silently editing it into a claimed verified result. A corrected input requires a new
checked call. Sources carry SHA-256 plus precise locators; claims reference known sources.

```bash
govern run graphics/topic plan
govern advance graphics/topic
```

## Design and build

Use [IDENTITY.md](IDENTITY.md) as the lane's visual identity, not as a repeated layout.
Choose a composition for the subject. Build `source/build.py` with `sr_core.scene`; it
runs with `source/` as its current working directory and writes `source/scene.xml`.
Keep all fonts, assets, data and support modules beneath `source/`. Use portable relative
paths and installed Python packages. Do not import a sibling checkout or reference an
absolute asset path. The canonical VPKG packer verifies dependency portability.

Use an explicit pinned font policy; every text asset has a fontAsset and size >=24 px
at 4K. Aim for >=40 px body copy, >=28 px source labels. This minimum is only a mechanical
floor: reduced-size visual review decides whether it is readable. Define a project
safeArea with `enforce="error"` and each inset >=0.02. Do not use safeAreaForce. Build
intentional backgrounds to the frame edge; text and semantic labels stay inside margins.

```python
from sr_core.scene import Scene, describe
scene = Scene(version='auto')
scene.add_project(width=3840, height=2160, fps='30', duration=1,
                  background='#090F17', quality='final', fontPolicy='pinned',
                  safeArea='editorial')
scene.add_safeAreas().add_safeArea(id='editorial', preset='custom',
                                 top=.02, bottom=.02, left=.02, right=.02,
                                 enforce='error')
# Author assets, geometry, relationships and text with the real SDK API.
# This fragment is an API reference, not a completed composition.
```

The process does not run an open-ended LLM loop. A session authors one candidate and
calls the bounded renderer; `govern run --bg` and `govern wait` own long jobs.

```bash
govern run graphics/topic render --bg
govern wait graphics/topic
govern advance graphics/topic
```

Each render reserves one immutable `generated/infographic/rNNN/` attempt, including
failures. It snapshots sources, builds, checks the SDK/XSD/Schematron and safe margins,
runs strict frame-0 rendering, decodes the PNG, generates half/quarter-size review images,
and creates/verifies a portable VPKG. There are four attempts per lane. Exhaustion blocks
and is reported with the last candidate; do not delete attempts or claim success. An
operator-directed new lane is a new request, not an automatic retry loop.

The returned candidate manifest carries file hashes, versions and an aggregate SHA-256.
The check binds the images to input, source code, assets and engine reports. Changes to
those inputs require a new candidate and a new review. Review is a separate step from
operator approval. A renderer exit code cannot establish editorial excellence.

## Review, corrections and approval

Inspect `frame.png`, `half.png` and `thumbnail.png` from the current revision. For a
verified one-shot review, supply all three as `--image` and include the manifest, plan,
brief and relevant source snapshots:

```bash
govern ask graphics/topic infographic-review --file generated/infographic/candidate.json --file brief.json --file plan.json --file sources/article.txt --image generated/infographic/r001/frame.png --image generated/infographic/r001/half.png --image generated/infographic/r001/thumbnail.png
```

Place the returned result in `review.json`. A session reviewing images directly can also
write this same strict report, honestly identifying its reviewer and inspection; do not
call it an independent review. Score fidelity, narrative, originality and finish with
pixel/source-specific evidence. Every score >=8.5, fidelity >=9, unrounded mean >=9,
all views inspected and zero unresolved issues are required. If a check fails, fix the
source and render again within the remaining budget, then inspect the new images.

```bash
govern run graphics/topic review
govern advance graphics/topic
```

At approval, show the complete PNG and source package. The owner records approval
through Govern in their own permitted terminal/session. Their actual words must include
the full candidate SHA-256. Do not invent a quote or approve for them. The final delivery
check matches this hash, so approval of an older revision cannot authorize a new one.
After approval, advancing runs the native gate; advancing the delivery stage validates
again and writes `generated/infographic/delivery-<hash>/frame.png` and
`reproduce.vpkg.zip`, with review and a checksum receipt. Repeating delivery is idempotent
only while the approved evidence is unchanged. No upload/publication is performed.

## Validation boundary

Checks enforce structure, source identity, reference validity, dimensions, fonts,
portability, revision bounds and exact-artifact binding. Source correctness, semantic
proportions, contrast and editorial excellence require inspection and judgment. The
scores are recorded assessments, never proof generated by a checklist. Supply sources
inside the image and keep model/tool provenance in package metadata.
