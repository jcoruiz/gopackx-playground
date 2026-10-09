# GoPackX Playground

Try [GoPackX](https://github.com/jcoruiz/gopackx), a 3D bin packing library for Go, in your browser: **https://gopackx.than.cl**

The library is compiled to WebAssembly and runs in a Web Worker on your machine. There is no backend: scenarios, results and timings never leave the page.

The latest release runs by default. Older releases stay available, so you can see what changed between them.

## What you can do

- **Pack** a scenario with any solver: `gopackx.Pack`, `Pack` + `Optimize()`, TrialPacking, the VNS metaheuristic, the Packer with any of the 7 strategies, Branch & Bound and Parallel.
- **Pick the GoPackX release** and the placement engine (Pivot Points, Extreme Points, MaxRects, LAFF, LAFF Fast), the minimum support ratio and a time limit.
- **See it in 3D**, box by box, and replay the placement order. Color by item type, group, constraints, weight or support.
- **Check every result independently.** A TypeScript re-implementation of the rules verifies each answer: every item accounted for, inside its box, no overlaps, valid rotations (upright items keep their height), weight limits, nothing on fragile items, the support ratio when stability is on, load limits counting the whole stack, box stock, and the reported statistics.
- **Compare** every engine and strategy on the same scenario, ranked by items packed, boxes (or cost) and fill.
- **Compare releases**: the Versions tab runs the same case on each GoPackX release and checks every result with the same rules.
- **Get the Go code** for the current scenario and settings, ready for `go run`.
- **Share a case** as a link (the scenario is compressed into the URL fragment) or open a GitHub issue with it in one click.

Six scenarios are built in: an office supply order (the README example), cost-aware shipping, a van with fragile, upright and load-limited items, a mixed pallet, a perfect-fit puzzle and a seeded stress test you can scale to 5,000 items. Two more reproduce bugs that fuzzing found in v0.2.2 and v0.3.0 fixed: weight resting on a fragile item, and a load limit exceeded.

## How it works

```
versions.json  GoPackX releases in the playground, newest (the default) first
wasm/          Go bridge: JSON in, JSON out, compiled with GOOS=js GOARCH=wasm
  solve.go       request → gopackx solver/engine/strategy → response
  main_js.go     registers gopackxSolve() for JavaScript
  main_cli.go    same request natively: go run ./wasm < request.json
  versions/      one go.mod and go.sum per release
src/           Vite + TypeScript + Three.js front end
  worker.ts      loads one release's WASM in a Web Worker (Stop = terminate the worker)
  verify.ts      the independent checks
  codegen.ts     scenario → Go program
  viewer.ts      one InstancedMesh per box, so thousands of items stay smooth
test/          Vitest: runs the real WASM builds in Node
```

The same bridge builds against every release: `scripts/build-wasm.sh` compiles it once per entry of `versions.json` with `go build -modfile=versions/<version>.mod`, since one Go binary cannot hold two versions of a module. The page starts a worker per release the first time it runs one, so a visit only downloads the releases it uses.

Two details of running Go in the browser:

- Under `GOOS=js` there is one thread and no preemption, so the timer behind `context.WithTimeout` never fires while a solver is busy. The bridge passes a context whose `Err()` reads the clock, which works because GoPackX polls `ctx.Err()`.
- `wasm_exec.js` has to come from the same Go toolchain that built the binary. `scripts/build-wasm.sh` copies both.

## Development

Requires Go 1.24+ and Node 22.

```bash
npm ci
npm run dev        # builds the WASM, then starts Vite
npm test           # every release × preset × solver × engine through the checks, and the generated Go through gofmt and go vet
npm run build      # production build in dist/
```

Go tests, natively and as WebAssembly, against one release (`wasm/go.mod` is the latest):

```bash
cd wasm
go test -race -modfile=versions/v0.2.2.mod ./...
PATH="$(go env GOROOT)/lib/wasm:$PATH" GOOS=js GOARCH=wasm go test -modfile=versions/v0.2.2.mod ./...
```

To add a new GoPackX release, run `scripts/add-version.sh vX.Y.Z`. It pins the release in `wasm/versions`, makes it the default in `versions.json` and the module version of `wasm/go.mod`. Then run `npm test`.

## Deployment

AWS Amplify Hosting builds `main` on every push with `amplify.yml` (Go 1.27 for the WASM, Node 22 for Vite). `customHttp.yml` sets the security headers, cross-origin isolation (full-resolution timers for the solve times) and long caching for hashed assets.

## License

[MIT](LICENSE)
