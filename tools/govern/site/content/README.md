# Website content

Part of [super-tools](../../../../README.md).

These pages use the website Markdown contract. Paths in this table are relative to this folder; source documents are under `tools/govern/` unless otherwise noted. Comparison and press content belong to separate lanes.

| Page | Sources |
|---|---|
| `index.md` | `PURPOSE.md`, `SKILL.md`, `REFERENCE.md` |
| `about.md` | `PURPOSE.md`, `README.md`, `ARCHITECTURE.md`, `REFERENCE.md` |
| `purpose.md` | `PURPOSE.md`, preserving section order and meaning |
| `concepts.md` | `SKILL.md`, `REFERENCE.md`, `ARCHITECTURE.md`, `processes/dev.json` |
| `roadmap.md` | `CHANGELOG.md` baseline Unreleased section, `ITERATION.md`, `OPENCLAW-GAP.md`, `OPENCLAW-PARITY.md`, `CONVERSATIONS.md`, `REMOTE.md`; extension status from the assigned lane brief |
| `docs/index.md` | `README.md`, `SKILL.md`, `REFERENCE.md`, repository `bin/govern` manpage |
| `docs/getting-started.md` | `README.md`, `SKILL.md`, `REFERENCE.md`, `processes/dev.json`, repository `bin/govern` manpage |
| `docs/lanes-and-processes.md` | `REFERENCE.md`, `ARCHITECTURE.md`, `processes/dev.json`, `processes/ops.json`, `processes/video.json`, `processes/video/MANUAL.md`, `REMOTE.md` |
| `docs/queue.md` | `SKILL.md`, `REFERENCE.md`, repository `bin/govern` manpage, `schemas/queue-reply.json`, `capabilities/builtin.json` |
| `docs/commands.md` | Repository `bin/govern` MANPAGE synopsis, description, options and exit status |
| `docs/peers.md` | `PEERS.md`, `REFERENCE.md` |
| `docs/remote.md` | `REMOTE.md`, `REFERENCE.md` |
| `docs/business-processes.md` | `BUSINESS.md`, `LIFECYCLE.md`, `ITERATION.md`, `REFERENCE.md`, `examples/purchase.json`, `examples/fulfillment.json`, `examples/supplier-review.json` |
| `docs/architecture.md` | `ARCHITECTURE.md`, `README.md`, `CONVERSATIONS.md`, `LIFECYCLE.md` |

The manpage lives at repository `bin/govern`, not `tools/govern/bin/govern`. The command page keeps flags in a literal reference block so argument-choice pipes and placeholders retain their exact meaning. The two OpenClaw documents are historical research snapshots; current manuals take precedence. No external feature or compatibility claims were independently verified.

The README files are repository documentation, not website pages. Website links intentionally include `/comparison/`, `/press/` and the process-stage image, supplied by other lanes. Build validation requires those lanes to be merged.
