import { beforeAll, describe, expect, it } from 'vitest';
import { PRESETS } from '../src/presets';
import { DEFAULT_CONFIG, ENGINES, MODES, type EngineName, type Mode, type SolveRequest, type SolveResponse } from '../src/types';
import { verify } from '../src/verify';
import { loadWasm, solve } from './wasm';

beforeAll(loadWasm);

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

describe('every preset, mode and engine passes the independent checks', () => {
  for (const preset of PRESETS) {
    for (const mode of modes) {
      for (const engine of engines) {
        it(`${preset.key} / ${mode} / ${engine}`, () => {
          const req = request(preset, mode, engine);
          const res = solve(req);
          expect(res.error).toBeUndefined();
          expect(res.ok).toBe(true);
          const failed = verify(req, res).filter((c) => c.status === 'fail');
          expect(failed.map((c) => `${c.label}: ${c.failures.join('; ')}`)).toEqual([]);
        });
      }
    }
  }
});

describe('the checks catch broken results', () => {
  const office = PRESETS.find((p) => p.key === 'office')!;
  const base = (): [SolveRequest, SolveResponse] => {
    const req = request(office, 'pack', 'pivot');
    return [req, solve(req)];
  };
  const failing = (req: SolveRequest, res: SolveResponse) =>
    verify(req, res)
      .filter((c) => c.status === 'fail')
      .map((c) => c.key);

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

  it('flags overweight boxes and wrong stats', () => {
    const [req, res] = base();
    res.bins[0].maxWeight = 0.01;
    expect(failing(req, res)).toContain('weight');
    res.stats.fittedItems += 1;
    expect(failing(req, res)).toContain('stats');
  });

  it('flags items stacked on fragile ones and missing support', () => {
    const req: SolveRequest = {
      ...DEFAULT_CONFIG,
      mode: 'packer',
      stability: 0.7,
      bins: [{ id: 'Box', w: 10, h: 10, d: 10, maxWeight: 100, cost: 0, qty: 1 }],
      items: [
        { id: 'Glass', w: 10, h: 5, d: 10, weight: 1, qty: 1, upright: false, fragile: true, loadBear: 0, priority: 0, group: '' },
        { id: 'Brick', w: 4, h: 5, d: 4, weight: 1, qty: 1, upright: false, fragile: false, loadBear: 0, priority: 0, group: '' },
      ],
    };
    const res: SolveResponse = {
      ok: true,
      elapsedMs: 0,
      timedOut: false,
      unusedBins: 0,
      unfitted: [],
      stats: { totalBins: 1, totalItems: 2, fittedItems: 2, unfittedCount: 0, volumeUsedPct: 58, weightUsedPct: 2, totalCost: 0 },
      bins: [
        {
          id: 'Box',
          spec: 0,
          w: 10,
          h: 10,
          d: 10,
          maxWeight: 100,
          cost: 0,
          weight: 2,
          volumePct: 58,
          gravity: [25, 25, 25, 25],
          items: [
            { id: 'Glass', spec: 0, x: 0, y: 0, z: 0, w: 10, h: 5, d: 10, rotation: 0, weight: 1, support: 1, load: 1 },
            { id: 'Brick', spec: 1, x: 8, y: 5, z: 8, w: 4, h: 5, d: 4, rotation: 0, weight: 1, support: 0.25, load: 0 },
          ],
        },
      ],
    };
    // Brick also sticks out of the box (x 8 + 4 > 10).
    expect(failing(req, res)).toEqual(expect.arrayContaining(['fragile', 'support', 'bounds']));
  });
});
