#!/bin/sh
# Renderer for the Grafana watcher's visual report (grafana-watch.ts --report, GRAFANA_WATCH_RENDER): renders the scene
# $1 (a scene-render document) to the PNG $2 with the scene-render Docker image, validating it first.
# SCENE_RENDER_IMAGE picks the image (default pedroanisio/scene-render:latest).
set -eu
dir=$(cd "$(dirname "$1")" && pwd)
run() { docker run --rm --network none --user "$(id -u):$(id -g)" -v "$dir:/work" -v scene-render-cache:/cache "${SCENE_RENDER_IMAGE:-pedroanisio/scene-render:latest}" "$@"; }
run validate "$(basename "$1")" >&2
run render "$(basename "$1")" --frames 0..1 -o "$(basename "$2")" >&2
[ "$(dirname "$2")" = "$dir" ] || mv "$dir/$(basename "$2")" "$2"
