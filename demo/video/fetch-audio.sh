#!/usr/bin/env bash
# Fetch the demo's audio. The files are not committed: the music is from HeyGen's library and the
# effects are HyperFrames' bundled Pixabay set, both licensed for use in videos, not for redistribution
# as loose files. Needs a HeyGen credential (HEYGEN_API_KEY or `npx hyperframes auth login`) for the music.
set -euo pipefail
cd "$(dirname "$0")"
SKILLS="${HYPERFRAMES_SKILLS:-$(mktemp -d)/hyperframes}"
[ -d "$SKILLS/skills" ] || git clone --depth 1 https://github.com/heygen-com/hyperframes "$SKILLS"
mkdir -p assets/sfx
for f in whoosh whoosh-short typing error pop ping impact-bass-1; do
  cp "$SKILLS/skills/media-use/audio/assets/sfx/$f.mp3" assets/sfx/
done
cat > /tmp/sandfit-audio-request.json <<'JSON'
{ "lines": [], "bgm": { "mode": "retrieve", "query": "minimal modern tech underscore, subtle pulse building to bright, 110 bpm" } }
JSON
NODE_USE_ENV_PROXY=1 node "$SKILLS/skills/media-use/audio/scripts/audio.mjs" --request /tmp/sandfit-audio-request.json --out /tmp/sandfit-audio-meta.json --only bgm
echo "audio ready in assets/"
