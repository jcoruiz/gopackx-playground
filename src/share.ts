// Scenario + settings <-> compact URL fragment, and the sanitizing that any
// imported or shared state goes through before it touches the app.

import {
  DEFAULT_CONFIG,
  ENGINES,
  MODES,
  STRATEGIES,
  type BinSpec,
  type EngineName,
  type ItemSpec,
  type Mode,
  type Scenario,
  type SolverConfig,
  type StrategyName,
} from './types';

export interface Snapshot {
  scenario: Scenario;
  config: SolverConfig;
}

const MAX_LINES = 300;
const MAX_NAME = 60;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encode(s: Snapshot): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(s));
  return b64url(await pipe(bytes, new CompressionStream('deflate-raw')));
}

export async function decode(fragment: string): Promise<Snapshot> {
  const bytes = await pipe(fromB64url(fragment), new DecompressionStream('deflate-raw'));
  return sanitize(JSON.parse(new TextDecoder().decode(bytes)));
}

const num = (v: unknown, def = 0, lo = 0, hi = 1e9) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
const int = (v: unknown, def: number, lo: number, hi: number) => Math.round(num(v, def, lo, hi));
const text = (v: unknown, def = '') => (typeof v === 'string' ? v.slice(0, MAX_NAME) : def);
const oneOf = <T extends string>(v: unknown, options: Record<T, unknown>, def: T): T => (typeof v === 'string' && v in options ? (v as T) : def);
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.slice(0, MAX_LINES).filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [];

export function sanitize(input: unknown): Snapshot {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const sc = (o.scenario ?? {}) as Record<string, unknown>;
  const cf = (o.config ?? {}) as Record<string, unknown>;

  const bins: BinSpec[] = list(sc.bins).map((b, i) => ({
    id: text(b.id, `Box ${i + 1}`),
    w: num(b.w),
    h: num(b.h),
    d: num(b.d),
    maxWeight: num(b.maxWeight),
    cost: num(b.cost),
    qty: int(b.qty, 1, 1, 500),
  }));
  const items: ItemSpec[] = list(sc.items).map((it, i) => ({
    id: text(it.id, `Item ${i + 1}`),
    w: num(it.w),
    h: num(it.h),
    d: num(it.d),
    weight: num(it.weight),
    qty: int(it.qty, 1, 1, 5000),
    upright: it.upright === true,
    fragile: it.fragile === true,
    loadBear: num(it.loadBear),
    priority: int(it.priority, 0, 0, 1000),
    group: text(it.group),
  }));

  const config: SolverConfig = {
    mode: oneOf<Mode>(cf.mode, MODES, DEFAULT_CONFIG.mode),
    engine: oneOf<EngineName>(cf.engine, ENGINES, DEFAULT_CONFIG.engine),
    strategy: oneOf<StrategyName>(cf.strategy, STRATEGIES, DEFAULT_CONFIG.strategy),
    stability: num(cf.stability, 0, 0, 1),
    lookahead: cf.lookahead !== false,
    maxIter: int(cf.maxIter, DEFAULT_CONFIG.maxIter, 1, 100_000),
    maxNoImprove: int(cf.maxNoImprove, DEFAULT_CONFIG.maxNoImprove, 1, 100_000),
    bbFull: cf.bbFull === true,
    timeoutMs: int(cf.timeoutMs, DEFAULT_CONFIG.timeoutMs, 100, 60_000),
  };
  return { scenario: { bins, items }, config };
}
