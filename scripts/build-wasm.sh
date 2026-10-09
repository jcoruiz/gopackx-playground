#!/usr/bin/env bash
# Compiles the Go bridge to WebAssembly and copies the wasm_exec.js shipped
# with the same Go toolchain (the two must match).
set -euo pipefail
cd "$(dirname "$0")/.."

GO="${GO:-go}"
out=src/generated
mkdir -p "$out"

(cd wasm && GOOS=js GOARCH=wasm "$GO" build -trimpath -ldflags="-s -w" -o "../$out/gopackx.wasm" .)
cp "$("$GO" env GOROOT)/lib/wasm/wasm_exec.js" "$out/wasm_exec.js"

echo "wasm: $(du -h "$out/gopackx.wasm" | cut -f1) with $("$GO" version | cut -d' ' -f3)"
