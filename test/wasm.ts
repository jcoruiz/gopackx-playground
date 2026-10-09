// Loads the real WebAssembly builds in Node, the same artifacts the page uses.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BuildInfo, SolveRequest, SolveResponse } from '../src/types';

const generated = fileURLToPath(new URL('../src/generated/', import.meta.url));

declare const Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> };

export interface Wasm {
  info: BuildInfo;
  solve(req: SolveRequest): SolveResponse;
}

const loaded = new Map<string, Promise<Wasm>>();

/** Loads the build of one GoPackX release. Several can run side by side. */
export function loadWasm(version: string): Promise<Wasm> {
  let wasm = loaded.get(version);
  if (!wasm) {
    wasm = (async () => {
      await import('../src/generated/wasm_exec.js');
      const go = new Go();
      const { instance } = await WebAssembly.instantiate(readFileSync(`${generated}gopackx-${version}.wasm`), go.importObject);
      void go.run(instance);
      // Every build registers the same globals: keep this one's before the next build replaces them.
      const g = globalThis as unknown as { gopackxSolve(req: string): string; gopackxInfo(): string };
      const solve = g.gopackxSolve;
      return {
        info: JSON.parse(g.gopackxInfo()) as BuildInfo,
        solve: (req) => JSON.parse(solve(JSON.stringify(req))) as SolveResponse,
      };
    })();
    loaded.set(version, wasm);
  }
  return wasm;
}
