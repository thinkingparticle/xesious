#!/usr/bin/env bash
# Optional setup for the context engine's "meaning" search (context/embed.ts).
# Keyword search needs none of this — it is built into bun:sqlite.
#
#   context/setup.sh            # install transformers.js into context/.deps and fetch the default model
#   context/setup.sh --check    # report what is installed and change nothing
#
# What it installs: @huggingface/transformers (Apache-2.0) with ONNX Runtime
# (MIT), about 60 MB of it used on Linux x64 (the package ships every platform,
# ~490 MB on disk), and multilingual-e5-small (MIT, ~120 MB), cached under
# context/.deps/models. Then set TG_CONTEXT_EMBED=1 in .env and restart.
#
# The lighter alternative, with nothing native loaded into the bridge: run
# llama.cpp's server with an embedding model and point the bridge at it —
#   llama-server -m bge-m3-q8_0.gguf --embedding --port 8091 -t 2
#   TG_CONTEXT_EMBED_URL=http://127.0.0.1:8091  TG_CONTEXT_EMBED=bge-m3
# (bge-m3 is MIT; EmbeddingGemma is better at Persian but under the Gemma terms.)
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
DEPS="$PWD/.deps"
say() { echo "[context-setup] $*"; }

if [ "${1:-}" = "--check" ]; then
  if [ -d "$DEPS/node_modules/@huggingface/transformers" ]; then say "transformers.js: installed in $DEPS"; else say "transformers.js: not installed"; fi
  if ls "$DEPS/models" >/dev/null 2>&1; then say "models cached: $(ls "$DEPS/models" | tr '\n' ' ')"; else say "no models cached yet"; fi
  exit 0
fi

mkdir -p "$DEPS"
[ -f "$DEPS/package.json" ] || echo '{"name":"xesious-context-deps","private":true,"type":"module"}' > "$DEPS/package.json"
say "installing @huggingface/transformers into $DEPS"
(cd "$DEPS" && bun add @huggingface/transformers) || { say "install failed"; exit 1; }
say "fetching the default model (multilingual-e5-small) and checking it works"
MODEL="${TG_CONTEXT_EMBED:-Xenova/multilingual-e5-small}"
[ "$MODEL" = "1" ] && MODEL="Xenova/multilingual-e5-small"
bun -e "
  const { localEmbedder } = await import('$PWD/embed.ts')
  const e = await localEmbedder({ model: '$MODEL', depsDir: '$DEPS', cacheDir: '$DEPS/models' })
  if (!e) { console.error('could not load the model'); process.exit(1) }
  const [v] = await e.embed(['hello'], 'query')
  console.log('[context-setup] ok: ' + e.name + ', ' + v.length + ' dimensions')
" || exit 1
say "done. Set TG_CONTEXT_EMBED=1 (or the model id) in .env and restart the bridge."
