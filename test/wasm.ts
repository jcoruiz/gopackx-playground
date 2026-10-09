// Loads the real WebAssembly build in Node, the same artifact the page uses.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SolveRequest, SolveResponse } from '../src/types';

const generated = fileURLToPath(new URL('../src/generated/', import.meta.url));

declare const Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> };
declare function gopackxSolve(request: string): string;

let loaded: Promise<void> | undefined;

export function loadWasm(): Promise<void> {
  loaded ??= (async () => {
    await import('../src/generated/wasm_exec.js');
    const go = new Go();
    const { instance } = await WebAssembly.instantiate(readFileSync(generated + 'gopackx.wasm'), go.importObject);
    void go.run(instance);
  })();
  return loaded;
}

export function solve(req: SolveRequest): SolveResponse {
  return JSON.parse(gopackxSolve(JSON.stringify(req))) as SolveResponse;
}
