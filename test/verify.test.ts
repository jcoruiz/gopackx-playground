import { beforeAll, describe, expect, it } from 'vitest';
import { PRESETS, item } from '../src/presets';
import { DEFAULT_CONFIG, ENGINES, MODES, type BinResult, type EngineName, type Mode, type PlacedItem, type SolveRequest, type SolveResponse } from '../src/types';
import { directLoads, keepsDirectLoadLimits, loads, verify } from '../src/verify';
import { LATEST, RELEASES, atLeast, rules } from '../src/versions';
import { loadWasm, type Wasm } from './wasm';

const modes = Object.keys(MODES) as Mode[];
const engines = Object.keys(ENGINES) as EngineName[];

function request(preset: (typeof PRESETS)[number], mode: Mode, engine: EngineName): SolveRequest {
  return {
    ...DEFAULT_CONFIG,
    ...preset.config,
    mode,
    engine,
    // Keep exhaustive searches short so the matrix stays fast.
    timeoutMs: mode === 'branchbound' || mode === 'metaheuristic' || mode === 'optimize' ? 400 : 3000,
    ...preset.scenario,
  };
}

const failing = (req: SolveRequest, res: SolveResponse) =>
  verify(req, res)
    .filter((c) => c.status === 'fail')
    .map((c) => c.key);

for (const { version } of RELEASES) {
  describe(`GoPackX ${version}`, () => {
    let wasm: Wasm;
    beforeAll(async () => {
      wasm = await loadWasm(version);
    });

    it('is the version it was built for', () => {
      expect(wasm.info.library).toBe(version);
    });

    // Releases before v0.3.0 followed an older load rule on purpose: only
    // direct contact counted, and only with stability on.
    const ignored = rules(version).fullStackLoad ? [] : ['load'];

    describe('every preset, mode and engine passes the independent checks', () => {
      for (const preset of PRESETS) {
        if (preset.fixedIn && !atLeast(version, preset.fixedIn)) continue;
        for (const mode of modes) {
          for (const engine of engines) {
            it(`${preset.key} / ${mode} / ${engine}`, () => {
              const req = request(preset, mode, engine);
              const res = wasm.solve(req);
              expect(res.error).toBeUndefined();
              expect(res.ok).toBe(true);
              const failed = verify(req, res).filter((c) => c.status === 'fail' && !ignored.includes(c.key));
              expect(failed.map((c) => `${c.label}: ${c.failures.join('; ')}`)).toEqual([]);
            });
          }
        }
      }
    });
  });
}

describe('the bug cases fail before the release that fixed them and pass from it on', () => {
  const shows: Record<string, string> = { 'fixed-fragile': 'fragile', 'fixed-load': 'load' };
  const cases = PRESETS.filter((p) => p.fixedIn);

  it('covers every bug case', () => {
    expect(cases.map((p) => p.key).sort()).toEqual(Object.keys(shows).sort());
  });

  for (const preset of cases) {
    for (const { version } of RELEASES) {
      const fixed = atLeast(version, preset.fixedIn!);
      it(`${preset.key} ${fixed ? 'passes' : `fails the ${shows[preset.key]} check`} on ${version}`, async () => {
        const req: SolveRequest = { ...DEFAULT_CONFIG, ...preset.config, ...preset.scenario };
        const res = (await loadWasm(version)).solve(req);
        expect(res.ok).toBe(true);
        expect(failing(req, res)).toEqual(fixed ? [] : [shows[preset.key]]);
        if (fixed) expect(res.stats.unfittedCount).toBe(0);
      });
    }
  }
});

describe('the checks catch broken results', () => {
  const office = PRESETS.find((p) => p.key === 'office')!;
  let wasm: Wasm;
  beforeAll(async () => {
    wasm = await loadWasm(LATEST);
  });
  const base = (): [SolveRequest, SolveResponse] => {
    const req = request(office, 'pack', 'pivot');
    return [req, wasm.solve(req)];
  };

  it('passes the untouched result', () => {
    const [req, res] = base();
    expect(failing(req, res)).toEqual([]);
  });

  it('flags overlaps', () => {
    const [req, res] = base();
    const bin = res.bins.find((b) => b.items.length > 1)!;
    Object.assign(bin.items[1], { x: bin.items[0].x, y: bin.items[0].y, z: bin.items[0].z });
    expect(failing(req, res)).toContain('overlap');
  });

  it('flags items outside the box', () => {
    const [req, res] = base();
    res.bins[0].items[0].x = res.bins[0].w;
    expect(failing(req, res)).toContain('bounds');
  });

  it('flags missing and duplicated items', () => {
    const [req, res] = base();
    res.bins[0].items.pop();
    expect(failing(req, res)).toContain('accounted');
    res.unfitted.push({ id: res.bins[0].items[0].id, spec: res.bins[0].items[0].spec });
    expect(failing(req, res)).toContain('accounted');
  });

  it('flags a wrong rotation and a tipped upright item', () => {
    const [req, res] = base();
    res.bins[0].items[0].w += 1;
    expect(failing(req, res)).toContain('rotation');

    const [req2, res2] = base();
    const it = res2.bins[0].items[0];
    req2.items[it.spec] = { ...req2.items[it.spec], upright: true };
    const s = req2.items[it.spec];
    Object.assign(it, { w: s.h, h: s.w, d: s.d });
    expect(failing(req2, res2)).toContain('rotation');
  });

  it('flags overweight boxes and wrong stats, and treats a limit of 0 as none', () => {
    const [req, res] = base();
    res.bins[0].maxWeight = 0.01;
    expect(failing(req, res)).toContain('weight');
    res.bins[0].maxWeight = 0;
    expect(failing(req, res)).not.toContain('weight');
    res.stats.fittedItems += 1;
    expect(failing(req, res)).toContain('stats');
  });
});

describe('hand-built placements', () => {
  const placed = (id: string, spec: number, x: number, y: number, z: number, w: number, h: number, d: number, weight: number): PlacedItem => ({
    id,
    spec,
    x,
    y,
    z,
    w,
    h,
    d,
    rotation: 0,
    weight,
    support: 1,
  });
  const binOf = (items: PlacedItem[]): BinResult => ({
    id: 'Box',
    spec: 0,
    w: 10,
    h: 10,
    d: 10,
    maxWeight: 100,
    cost: 0,
    weight: items.reduce((s, it) => s + it.weight, 0),
    volumePct: 0,
    gravity: [25, 25, 25, 25],
    items,
  });
  const caseOf = (items: PlacedItem[], unfitted: { id: string; spec: number }[] = []): SolveResponse => {
    const bin = binOf(items);
    bin.volumePct = (items.reduce((s, it) => s + it.w * it.h * it.d, 0) / 1000) * 100;
    const total = items.length + unfitted.length;
    return {
      ok: true,
      elapsedMs: 0,
      timedOut: false,
      unusedBins: 0,
      unfitted,
      stats: { totalBins: 1, totalItems: total, fittedItems: items.length, unfittedCount: unfitted.length, volumeUsedPct: bin.volumePct, weightUsedPct: 0, totalCost: 0 },
      bins: [bin],
    };
  };

  it('counts the whole stack on an item, overhangs included', () => {
    // A carries B, which carries C and half of D; D overhangs B and E.
    const items = [
      placed('A', 0, 0, 0, 0, 4, 2, 4, 1),
      placed('B', 0, 0, 2, 0, 4, 2, 4, 2),
      placed('C', 0, 0, 4, 0, 4, 2, 2, 3),
      placed('E', 0, 6, 0, 0, 4, 4, 4, 1),
      placed('D', 0, 2, 4, 2, 6, 1, 2, 4),
    ];
    // D rests on B (2 × 2 = 4) and E (2 × 2 = 4): 2 kg each, though a third of its base hangs free.
    const [a, b, c, e, d] = loads(binOf(items));
    expect(d).toBe(0);
    expect(c).toBe(0);
    expect(b).toBeCloseTo(3 + 2);
    expect(a).toBeCloseTo(2 + 5);
    expect(e).toBeCloseTo(2);

    // Before v0.3.0 only direct contact counted, by the share of the upper item's base.
    const [da, db, , de] = directLoads(binOf(items));
    expect(da).toBeCloseTo(2);
    expect(db).toBeCloseTo(3 + 4 / 3);
    expect(de).toBeCloseTo(4 / 3);
  });

  it('flags items stacked on fragile ones and missing support', () => {
    const req: SolveRequest = {
      ...DEFAULT_CONFIG,
      mode: 'packer',
      stability: 0.7,
      bins: [{ id: 'Box', w: 10, h: 10, d: 10, maxWeight: 100, cost: 0, qty: 1 }],
      items: [item('Glass', 10, 5, 10, 1, 1, { fragile: true }), item('Brick', 4, 5, 4, 1)],
    };
    const res = caseOf([placed('Glass', 0, 0, 0, 0, 10, 5, 10, 1), placed('Brick', 1, 8, 5, 8, 4, 5, 4, 1)]);
    // Brick also sticks out of the box (x 8 + 4 > 10).
    expect(failing(req, res)).toEqual(expect.arrayContaining(['fragile', 'support', 'bounds']));
  });

  it('flags load limits with stability off, counting what rests on the items above', () => {
    const req: SolveRequest = {
      ...DEFAULT_CONFIG,
      mode: 'packer',
      bins: [{ id: 'Box', w: 10, h: 10, d: 10, maxWeight: 100, cost: 0, qty: 1 }],
      items: [item('Tray', 10, 2, 10, 1, 1, { loadBear: 5 }), item('Crate', 10, 4, 10, 3), item('Bag', 10, 4, 10, 3)],
    };
    const items = [placed('Tray', 0, 0, 0, 0, 10, 2, 10, 1), placed('Crate', 1, 0, 2, 0, 10, 4, 10, 3)];
    expect(failing(req, caseOf(items, [{ id: 'Bag', spec: 2 }]))).toEqual([]);
    // The bag touches only the crate, but its 3 kg reach the tray too: 6 kg on a 5 kg limit.
    const res = caseOf([...items, placed('Bag', 2, 0, 6, 0, 10, 4, 10, 3)]);
    expect(failing(req, res)).toEqual(['load']);
    // The rule before v0.3.0 ignored load limits without stability, and with it counted only the crate.
    expect(keepsDirectLoadLimits(req, res)).toBe(true);
    expect(keepsDirectLoadLimits({ ...req, stability: 0.5 }, res)).toBe(true);
    req.items[0].loadBear = 2;
    expect(keepsDirectLoadLimits({ ...req, stability: 0.5 }, res)).toBe(false);
  });
});
