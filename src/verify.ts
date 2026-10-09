// Independent checks of a solver result. Nothing here calls the Go code: the
// rules are re-implemented from the library docs so a bug in the solver
// cannot hide behind the same bug in its own validation.

import { isCatalogMode, type BinResult, type PlacedItem, type SolveRequest, type SolveResponse } from './types';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface Check {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
  failures: string[];
}

const EPS = 1e-6;
const MAX_LISTED = 8;

const overlap1D = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

const footprint = (a: PlacedItem, b: PlacedItem) => overlap1D(a.x, a.x + a.w, b.x, b.x + b.w) * overlap1D(a.z, a.z + a.d, b.z, b.z + b.d);

const touches = (a: PlacedItem, b: PlacedItem) =>
  overlap1D(a.x, a.x + a.w, b.x, b.x + b.w) > EPS && overlap1D(a.z, a.z + a.d, b.z, b.z + b.d) > EPS;

/** Share of an item's base resting on the floor or on items right below it. */
export function supportRatio(it: PlacedItem, bin: BinResult): number {
  if (it.y < EPS) return 1;
  const base = it.w * it.d;
  let supported = 0;
  for (const o of bin.items) {
    if (o !== it && Math.abs(o.y + o.h - it.y) <= EPS) supported += footprint(it, o);
  }
  return base > 0 ? supported / base : 0;
}

/** Weight resting on top of an item, each item above shared by contact area. */
export function weightAbove(it: PlacedItem, bin: BinResult): number {
  const top = it.y + it.h;
  let total = 0;
  for (const o of bin.items) {
    if (o === it || Math.abs(o.y - top) > EPS || !touches(it, o)) continue;
    total += o.weight * (footprint(it, o) / (o.w * o.d));
  }
  return total;
}

class Builder {
  failures: string[] = [];
  count = 0;
  fail(msg: string) {
    this.count++;
    if (this.failures.length < MAX_LISTED) this.failures.push(msg);
  }
  done(key: string, label: string, ok: string, bad: (n: number) => string): Check {
    return {
      key,
      label,
      status: this.count === 0 ? 'pass' : 'fail',
      detail: this.count === 0 ? ok : bad(this.count),
      failures: this.failures,
    };
  }
}

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function verify(req: SolveRequest, res: SolveResponse): Check[] {
  const checks: Check[] = [];
  const placed = res.bins.flatMap((b) => b.items.map((it) => ({ it, bin: b })));
  const specOf = (it: { spec: number }) => req.items[it.spec];

  // 1. Every input unit comes back exactly once, placed or not.
  {
    const c = new Builder();
    const ids = new Set<string>();
    const perSpec = new Array<number>(req.items.length).fill(0);
    for (const it of [...placed.map((p) => p.it), ...res.unfitted]) {
      if (ids.has(it.id)) c.fail(`${it.id} appears twice`);
      ids.add(it.id);
      if (it.spec >= 0 && it.spec < perSpec.length) perSpec[it.spec]++;
      else c.fail(`${it.id} does not match any input line`);
    }
    req.items.forEach((s, i) => {
      const want = Math.max(s.qty, 1);
      if (perSpec[i] !== want) c.fail(`${s.id}: ${perSpec[i]} returned, ${want} sent`);
    });
    const total = req.items.reduce((n, s) => n + Math.max(s.qty, 1), 0);
    checks.push(c.done('accounted', 'Every item accounted for', `${plural(total, 'item')}, each returned once`, (n) => `${plural(n, 'problem')}`));
  }

  // 2. Inside the box.
  {
    const c = new Builder();
    for (const { it, bin } of placed) {
      if (it.x < -EPS || it.y < -EPS || it.z < -EPS || it.x + it.w > bin.w + EPS || it.y + it.h > bin.h + EPS || it.z + it.d > bin.d + EPS) {
        c.fail(`${it.id} sticks out of ${bin.id}`);
      }
    }
    checks.push(c.done('bounds', 'Inside its box', `${plural(placed.length, 'placed item')} within bounds`, (n) => `${plural(n, 'item')} out of bounds`));
  }

  // 3. No two items share space.
  {
    const c = new Builder();
    for (const bin of res.bins) {
      const its = bin.items;
      for (let i = 0; i < its.length; i++) {
        const a = its[i];
        for (let j = i + 1; j < its.length; j++) {
          const b = its[j];
          if (
            overlap1D(a.x, a.x + a.w, b.x, b.x + b.w) > EPS &&
            overlap1D(a.y, a.y + a.h, b.y, b.y + b.h) > EPS &&
            overlap1D(a.z, a.z + a.d, b.z, b.z + b.d) > EPS
          ) {
            c.fail(`${a.id} overlaps ${b.id} in ${bin.id}`);
          }
        }
      }
    }
    checks.push(c.done('overlap', 'No overlaps', 'No two items share space', (n) => `${plural(n, 'overlapping pair')}`));
  }

  // 4. Orientation: a rotation of the original, height kept for upright items.
  {
    const c = new Builder();
    const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
    for (const { it } of placed) {
      const s = specOf(it);
      if (!s) continue;
      const want = sorted([s.w, s.h, s.d]);
      const got = sorted([it.w, it.h, it.d]);
      if (want.some((v, k) => Math.abs(v - got[k]) > EPS)) c.fail(`${it.id} is ${it.w}×${it.h}×${it.d}, input was ${s.w}×${s.h}×${s.d}`);
      else if (s.upright && Math.abs(it.h - s.h) > EPS) c.fail(`${it.id} must stay upright but its height is ${it.h} (was ${s.h})`);
    }
    checks.push(c.done('rotation', 'Valid orientation', 'Every item is a rotation of its input; upright items keep their height', (n) => plural(n, 'bad orientation')));
  }

  // 5. Weight limit per box.
  {
    const c = new Builder();
    for (const bin of res.bins) {
      const w = bin.items.reduce((s, it) => s + it.weight, 0);
      if (w > bin.maxWeight + EPS) c.fail(`${bin.id} carries ${fmt(w)} kg, limit ${fmt(bin.maxWeight)} kg`);
    }
    checks.push(c.done('weight', 'Weight limit', 'No box over its weight limit', (n) => plural(n, 'box', 'boxes') + ' overweight'));
  }

  // 6. Nothing rests directly on a fragile item.
  {
    const c = new Builder();
    let fragile = 0;
    for (const bin of res.bins) {
      for (const f of bin.items) {
        if (!specOf(f)?.fragile) continue;
        fragile++;
        for (const o of bin.items) {
          if (o !== f && Math.abs(o.y - (f.y + f.h)) <= EPS && touches(f, o)) c.fail(`${o.id} rests on fragile ${f.id}`);
        }
      }
    }
    checks.push(
      fragile === 0
        ? { key: 'fragile', label: 'Fragile items', status: 'skip', detail: 'No fragile items placed', failures: [] }
        : c.done('fragile', 'Fragile items', `Nothing on top of ${plural(fragile, 'fragile item')}`, (n) => plural(n, 'item') + ' on fragile items'),
    );
  }

  // 7 and 8. Support and load bearing, only enforced with stability on.
  const stable = req.stability > 0;
  {
    const c = new Builder();
    let worst = 1;
    for (const { it, bin } of placed) {
      const r = supportRatio(it, bin);
      worst = Math.min(worst, r);
      if (stable && r < req.stability - EPS) c.fail(`${it.id}: ${Math.round(r * 100)}% of its base supported`);
    }
    const worstPct = `lowest support ${Math.round(worst * 100)}%`;
    checks.push(
      stable
        ? c.done('support', `Support ≥ ${Math.round(req.stability * 100)}%`, `Every item supported (${worstPct})`, (n) => plural(n, 'item') + ' under-supported')
        : { key: 'support', label: 'Support', status: 'skip', detail: `Stability off, items may overhang (${worstPct})`, failures: [] },
    );
  }
  {
    const c = new Builder();
    let limited = 0;
    for (const { it, bin } of placed) {
      const s = specOf(it);
      if (!s || s.loadBear <= 0) continue;
      limited++;
      const load = weightAbove(it, bin);
      if (load > s.loadBear + EPS) c.fail(`${it.id} holds ${fmt(load)} kg, limit ${fmt(s.loadBear)} kg`);
    }
    if (limited === 0) {
      checks.push({ key: 'load', label: 'Load bearing', status: 'skip', detail: 'No items with a load limit placed', failures: [] });
    } else if (!stable) {
      checks.push({
        key: 'load',
        label: 'Load bearing',
        status: 'skip',
        detail: `Only enforced with stability on, as documented${c.count ? `. ${plural(c.count, 'item')} over the limit now` : ''}`,
        failures: c.failures,
      });
    } else {
      checks.push(c.done('load', 'Load bearing', `${plural(limited, 'item')} within their load limit`, (n) => plural(n, 'item') + ' overloaded'));
    }
  }

  // 9. Boxes: stock respected in fixed modes, known type in catalog modes.
  {
    const c = new Builder();
    if (isCatalogMode(req.mode)) {
      for (const b of res.bins) if (!req.bins[b.spec]) c.fail(`${b.id} is not one of the box types`);
    } else {
      const used = new Array<number>(req.bins.length).fill(0);
      for (const b of res.bins) {
        if (req.bins[b.spec]) used[b.spec]++;
        else c.fail(`${b.id} is not one of the boxes in stock`);
      }
      req.bins.forEach((s, i) => {
        if (used[i] > Math.max(s.qty, 1)) c.fail(`${s.id}: ${used[i]} used, ${Math.max(s.qty, 1)} in stock`);
      });
    }
    for (const b of res.bins) {
      const s = req.bins[b.spec];
      if (s && (s.w !== b.w || s.h !== b.h || s.d !== b.d)) c.fail(`${b.id} is ${b.w}×${b.h}×${b.d}, its type is ${s.w}×${s.h}×${s.d}`);
    }
    checks.push(
      c.done('boxes', 'Boxes', isCatalogMode(req.mode) ? 'Every box is one of the types offered' : 'No box type used beyond its stock', (n) => plural(n, 'problem')),
    );
  }

  // 10. Reported stats match the placement.
  {
    const c = new Builder();
    const st = res.stats;
    const total = req.items.reduce((n, s) => n + Math.max(s.qty, 1), 0);
    if (st.totalItems !== total) c.fail(`totalItems ${st.totalItems}, sent ${total}`);
    if (st.fittedItems !== placed.length) c.fail(`fittedItems ${st.fittedItems}, placed ${placed.length}`);
    if (st.unfittedCount !== res.unfitted.length) c.fail(`unfittedCount ${st.unfittedCount}, unfitted ${res.unfitted.length}`);
    if (st.totalBins !== res.bins.length) c.fail(`totalBins ${st.totalBins}, used ${res.bins.length}`);
    if (res.bins.length > 0) {
      const avg = res.bins.reduce((s, b) => s + (b.items.reduce((v, it) => v + it.w * it.h * it.d, 0) / (b.w * b.h * b.d)) * 100, 0) / res.bins.length;
      if (Math.abs(avg - st.volumeUsedPct) > 0.01) c.fail(`volumeUsedPct ${fmt(st.volumeUsedPct)}, computed ${fmt(avg)}`);
    }
    const cost = res.bins.reduce((s, b) => s + b.cost, 0);
    if (Math.abs(cost - st.totalCost) > 1e-3) c.fail(`totalCost ${fmt(st.totalCost)}, computed ${fmt(cost)}`);
    checks.push(c.done('stats', 'Reported stats', 'Counts, fill and cost match the placement', (n) => plural(n, 'mismatch', 'mismatches')));
  }

  return checks;
}

export function summarize(checks: Check[]): { failed: number; passed: number; skipped: number } {
  return {
    failed: checks.filter((c) => c.status === 'fail').length,
    passed: checks.filter((c) => c.status === 'pass').length,
    skipped: checks.filter((c) => c.status === 'skip').length,
  };
}
