#!/usr/bin/env bash
# Compiles the Go bridge to WebAssembly once per gopackx version listed in
# versions.json, each against its pinned module file (wasm/versions/<v>.mod
# and .sum), and copies the wasm_exec.js shipped with the same Go toolchain.
set -euo pipefail
cd "$(dirname "$0")/.."

GO="${GO:-go}"
out=src/generated
mkdir -p "$out"
rm -f "$out"/gopackx*.wasm

versions=$(node -p "require('./versions.json').versions.map(v => v.version).join(' ')")
latest=${versions%% *}

# wasm/go.mod is the module file for local development and tests: keep it
# on the newest version.
if ! cmp -s wasm/go.mod "wasm/versions/$latest.mod"; then
  echo "wasm/go.mod does not match wasm/versions/$latest.mod: run scripts/add-version.sh $latest" >&2
  exit 1
fi

for v in $versions; do
  if [ ! -f "wasm/versions/$v.mod" ]; then
    echo "missing wasm/versions/$v.mod: run scripts/add-version.sh $v" >&2
    exit 1
  fi
  (cd wasm && GOOS=js GOARCH=wasm "$GO" build -trimpath -ldflags="-s -w" -mod=readonly \
    -modfile="versions/$v.mod" -o "../$out/gopackx-$v.wasm" .)
  echo "wasm $v: $(du -h "$out/gopackx-$v.wasm" | cut -f1)"
done

cp "$("$GO" env GOROOT)/lib/wasm/wasm_exec.js" "$out/wasm_exec.js"
echo "built with $("$GO" version | cut -d' ' -f3)"
