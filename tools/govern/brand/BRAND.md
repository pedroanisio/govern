# govern brand

Back to the [repository README](../../../README.md).

The brand images are scene-render scenes (`scenes/*.scene.xml`) rendered to PNG by the scene-render engine. The PNGs live in `../site/static/brand/` and are committed.

## The mark

A rounded ink tile holds one lane: five stages joined by a line. The first four stages are paper-white. An amber gate, a vertical bar taller than the stages, stands before the fifth stage, which is green. It reads as the dev process in the manual: work moves through stages, and the last step is not reached until the owner opens the gate. The mark has no text and stays legible at 32 px.

## Palette

The scenes declare these once as brand tokens (`<styles><token .../>`) and use them as `var(--name)`.

| Token | Hex | Use |
|---|---|---|
| ink | `#101828` | tile, text, desk |
| paper | `#F7F6F2` | background, stage dots |
| accent | `#1F6F5F` | progress, the last stage, the check mark |
| accent-2 | `#D98A1E` | the gate |
| muted | `#5C6370` | secondary text, lane line |
| rule | `#D9D6CE` | thin rules, empty lane |

## Typeface

All text is an engine text layer set in DejaVu Sans (bold for the word "govern" and headings, regular otherwise). The scenes name `font="DejaVu Sans"`, the face the govern process drawings use. The renderer drew it on this host; `scene-render inspect` does not report fonts, so the face was confirmed from the rendered glyphs only. There is no raster text.

## Images

| File | Pixels | Use |
|---|---|---|
| `logo.png` | 1024×1024 | the mark on its own, for avatars and large placements |
| `favicon.png` | 256×256 | the mark on paper, the site icon source |
| `wordmark.png` | 2400×800 | mark and "govern", for headers and documents |
| `hero.png` | 2400×1200 | home page hero: four lanes moving through five stages, a gate, a desk watching |
| `social-card.png` | 1200×630 | link previews: wordmark and "agent work, in lanes, with gates" |
| `press-banner.png` | 2400×600 | press releases: wordmark and "press release" |
| `process-stages.png` | 2400×1200 | figure of the dev process: plan, build, test, review, done, with the owner's gate before done |

## Re-render

From the repository root:

```
tools/govern/brand/render.sh
```

It validates every scene, then renders each to `tools/govern/site/static/brand/<name>.png`, stops at the first failure, and prints each output's pixel size and bytes. `SCENE_RENDER` names the engine binary (default `/root/src/scene-render/target/release/scene-render`). Each PNG is within 1.5 MB and the seven together within 6 MB.

Engine version used: `scene-render 0.6.0` (`scene-render --version`). Scenes are scene-render document version 1.1 and render with the rasteriser.
