// Runs the Go solver off the main thread. The page terminates and respawns
// this worker to cancel a solve, since a WASM call cannot be interrupted.
import './generated/wasm_exec.js';
import wasmUrl from './generated/gopackx.wasm?url';
import type { BuildInfo, SolveRequest } from './types';

declare const Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> };
declare function gopackxSolve(request: string): string;
declare function gopackxInfo(): string;

export type WorkerIn = { id: number; request: SolveRequest };
export type WorkerOut =
  | { type: 'ready'; info: BuildInfo }
  | { type: 'failed'; message: string }
  | { type: 'result'; id: number; json: string };

const post = (msg: WorkerOut) => self.postMessage(msg);

async function load(): Promise<void> {
  const go = new Go();
  const res = await fetch(wasmUrl);
  if (!res.ok) throw new Error(`could not download the solver (${res.status})`);
  // instantiateStreaming needs Content-Type application/wasm; fall back if a
  // host serves something else.
  const { instance } = res.headers.get('Content-Type')?.startsWith('application/wasm')
    ? await WebAssembly.instantiateStreaming(res, go.importObject)
    : await WebAssembly.instantiate(await res.arrayBuffer(), go.importObject);
  // run() resolves only when Go exits; main() registers its functions and parks.
  void go.run(instance);
}

const ready = load().then(
  () => post({ type: 'ready', info: JSON.parse(gopackxInfo()) as BuildInfo }),
  (err: unknown) => post({ type: 'failed', message: err instanceof Error ? err.message : String(err) }),
);

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  await ready;
  const { id, request } = e.data;
  post({ type: 'result', id, json: gopackxSolve(JSON.stringify(request)) });
};
