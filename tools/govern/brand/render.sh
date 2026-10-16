#!/usr/bin/env bash
# Validate, then render, every brand scene to ../site/static/brand/<name>.png with the scene-render engine.
# SCENE_RENDER names the engine binary. Stops at the first failure with the engine's message.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine="${SCENE_RENDER:-/root/src/scene-render/target/release/scene-render}"
out="$here/../site/static/brand"
names=(logo favicon wordmark hero social-card press-banner process-stages)

[ -x "$engine" ] || { echo "render.sh: engine not found or not executable: $engine" >&2; exit 1; }
mkdir -p "$out"

for n in "${names[@]}"; do
  "$engine" validate "$here/scenes/$n.scene.xml" || { echo "render.sh: $n does not validate" >&2; exit 1; }
done
for n in "${names[@]}"; do
  "$engine" render -f 0 "$here/scenes/$n.scene.xml" -o "$out/$n.png" || { echo "render.sh: $n failed to render" >&2; exit 1; }
done
for n in "${names[@]}"; do
  echo "$(file -b "$out/$n.png" | cut -d, -f1-2) $(du -b "$out/$n.png" | cut -f1) bytes  $out/$n.png"
done
