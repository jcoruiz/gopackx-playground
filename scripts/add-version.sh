#!/usr/bin/env bash
# Adds a newly released gopackx version to the playground: pins it in
# wasm/versions, lists it first in versions.json (the default) and makes it
# the module version for local development.
#
#   scripts/add-version.sh v0.4.0 [release date, default today]
set -euo pipefail
cd "$(dirname "$0")/.."

v="${1:?usage: scripts/add-version.sh vX.Y.Z [YYYY-MM-DD]}"
released="${2:-$(date +%F)}"

printf 'module github.com/jcoruiz/gopackx-playground/wasm\n\ngo 1.24.0\n\nrequire github.com/jcoruiz/gopackx %s\n' "$v" > "wasm/versions/$v.mod"
(cd wasm && go mod tidy -modfile="versions/$v.mod")
cp "wasm/versions/$v.mod" wasm/go.mod
cp "wasm/versions/$v.sum" wasm/go.sum

node -e '
const fs = require("fs");
const [v, released] = process.argv.slice(1);
const list = JSON.parse(fs.readFileSync("versions.json", "utf8"));
list.versions = [{ version: v, released }, ...list.versions.filter((x) => x.version !== v)];
fs.writeFileSync("versions.json", JSON.stringify(list, null, 2) + "\n");
' "$v" "$released"

echo "added $v; check the bridge still builds: npm run wasm"
