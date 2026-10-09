import type { WorkerIn, WorkerOut } from './worker';
import type { BuildInfo, SolveRequest, SolveResponse } from './types';

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

type Pending = { resolve: (r: SolveResponse) => void; reject: (e: Error) => void };

/** Client for the solver worker. One solve runs at a time; others queue. */
export class Solver {
  private worker!: Worker;
  private pending = new Map<number, Pending>();
  private seq = 0;
  ready!: Promise<BuildInfo>;

  constructor() {
    this.spawn();
  }

  private spawn(): void {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent<WorkerOut>) => {
        const msg = e.data;
        if (msg.type === 'ready') resolve(msg.info);
        else if (msg.type === 'failed') reject(new Error(msg.message));
        else {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          p?.resolve(JSON.parse(msg.json) as SolveResponse);
        }
      };
      this.worker.onerror = (e) => {
        e.preventDefault();
        const err = new Error(e.message || 'the solver crashed');
        reject(err);
        this.failAll(err);
      };
    });
    // Callers that await ready still see the failure; this only avoids an
    // unhandled rejection for respawns nobody waits on.
    this.ready.catch(() => {});
  }

  solve(request: SolveRequest): Promise<SolveResponse> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, request } satisfies WorkerIn);
    });
  }

  /** Stops whatever is running and starts a fresh worker. */
  cancel(): void {
    this.worker.terminate();
    this.failAll(new Cancelled());
    this.spawn();
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
