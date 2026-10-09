import type { BinSpec, ItemSpec, Scenario, SolverConfig } from './types';

export interface Preset {
  key: string;
  name: string;
  about: string;
  scenario: Scenario;
  config: Partial<SolverConfig>;
}

const bin = (id: string, w: number, h: number, d: number, maxWeight: number, qty = 1, cost = 0): BinSpec => ({
  id,
  w,
  h,
  d,
  maxWeight,
  cost,
  qty,
});

export const item = (id: string, w: number, h: number, d: number, weight: number, qty = 1, extra: Partial<ItemSpec> = {}): ItemSpec => ({
  id,
  w,
  h,
  d,
  weight,
  qty,
  upright: false,
  fragile: false,
  loadBear: 0,
  priority: 0,
  group: '',
  ...extra,
});

export const PRESETS: Preset[] = [
  {
    key: 'office',
    name: 'Office supply order',
    about: 'A real e-commerce order: pick the fewest boxes from a catalog of four sizes. This is the example in the library README.',
    scenario: {
      bins: [
        bin('Mailer bag', 43, 34.5, 5, 1, 2),
        bin('Small box', 25, 20, 20, 5, 2),
        bin('Medium box', 30, 30, 25, 10, 2),
        bin('Large box', 40, 40, 30, 20, 3),
      ],
      items: [
        item('Ring binder', 27, 8.5, 35.2, 0.395, 3),
        item('Folder', 27, 9, 30.5, 0.415, 5),
        item('Notebook', 28.5, 6.8, 29.4, 0.534, 4),
        item('Paper ream', 23.5, 6, 34.5, 2.78, 3),
        item('Bond paper', 28, 5, 22, 2.5, 2),
      ],
    },
    config: { mode: 'pack' },
  },
  {
    key: 'costs',
    name: 'Cheapest boxes',
    about: 'Each box has a price. With costs set, the solvers minimize total cost instead of box count.',
    scenario: {
      bins: [
        bin('XS', 20, 15, 10, 3, 4, 1.2),
        bin('S', 30, 25, 20, 10, 4, 2.5),
        bin('M', 40, 35, 30, 20, 4, 4),
        bin('L', 60, 50, 40, 30, 4, 6.5),
      ],
      items: [
        item('Shoe box', 33, 12, 20, 1.1, 3),
        item('Mug', 12, 12, 12, 0.5, 4),
        item('Book', 24, 4, 17, 0.6, 5),
        item('Hoodie', 30, 8, 25, 0.7, 2),
        item('Speaker', 18, 25, 18, 1.8),
        item('Board game', 30, 8, 30, 1.4, 2),
      ],
    },
    config: { mode: 'optimize' },
  },
  {
    key: 'constraints',
    name: 'Fragile, upright, load limits',
    about: 'A moving van: TVs and lamps stay upright, nothing goes on glassware, crates hold at most 30 kg on top. Stability is on (70% support).',
    scenario: {
      bins: [bin('Van', 120, 100, 150, 400, 2)],
      items: [
        item('TV', 20, 60, 90, 12, 2, { upright: true }),
        item('Glassware', 30, 25, 30, 4, 4, { fragile: true }),
        item('Crate', 40, 30, 40, 18, 6, { loadBear: 30 }),
        item('Books', 30, 20, 40, 15, 5, { priority: 1, group: 'office' }),
        item('Lamp', 25, 70, 25, 3, 2, { upright: true, fragile: true }),
      ],
    },
    config: { mode: 'packer', engine: 'extremepoint', stability: 0.7 },
  },
  {
    key: 'pallet',
    name: 'Mixed pallet',
    about: 'Cartons and drums on two pallets, 80% of each base must be supported. Parallel tries five engine and strategy combinations.',
    scenario: {
      bins: [bin('Pallet', 120, 160, 100, 1000, 2)],
      items: [
        item('Carton A', 40, 30, 30, 9, 20),
        item('Carton B', 60, 40, 40, 16, 8),
        item('Carton C', 30, 20, 20, 4, 24),
        item('Drum', 50, 80, 50, 60, 2, { upright: true }),
      ],
    },
    config: { mode: 'parallel', stability: 0.8 },
  },
  {
    key: 'puzzle',
    name: 'Perfect-fit puzzle',
    about: 'Eight pieces that fill a 60 cm cube exactly. Greedy engines often leave one out; compare them with Branch & Bound.',
    scenario: {
      bins: [bin('Cube', 60, 60, 60, 100, 1)],
      items: [item('Slab', 60, 20, 60, 6), item('Beam', 20, 20, 60, 2, 3), item('Tile', 30, 20, 30, 1.5, 4)],
    },
    config: { mode: 'branchbound', bbFull: false },
  },
  {
    key: 'stress',
    name: 'Stress test',
    about: 'Random items from a fixed seed. Change the size or seed under "Generate" to test your own load.',
    scenario: randomScenario({ items: 300, skus: 8, seed: 42 }),
    config: { mode: 'pack' },
  },
];

export interface RandomOptions {
  items: number;
  skus: number;
  seed: number;
}

// mulberry32: small, fast and reproducible across browsers.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomScenario({ items, skus, seed }: RandomOptions): Scenario {
  const rand = rng(seed);
  const between = (lo: number, hi: number) => Math.round(lo + rand() * (hi - lo));
  const lines = Math.max(1, Math.min(skus, items));
  const base = Math.floor(items / lines);

  const out: ItemSpec[] = [];
  for (let i = 0; i < lines; i++) {
    const w = between(6, 36);
    const h = between(4, 30);
    const d = between(6, 36);
    // Cardboard-ish density: 0.15 to 0.45 kg per litre.
    const weight = Math.round(((w * h * d) / 1000) * (0.15 + rand() * 0.3) * 100) / 100;
    const qty = base + (i < items % lines ? 1 : 0);
    out.push(item(`SKU ${String(i + 1).padStart(2, '0')}`, w, h, d, Math.max(weight, 0.05), qty));
  }

  const totalVolume = out.reduce((s, it) => s + it.w * it.h * it.d * it.qty, 0);
  // Enough stock for the fixed-box modes, within the playground limit of 500 boxes.
  const stock = (vol: number) => Math.min(150, Math.max(2, Math.ceil((totalVolume / vol) * 1.5)));

  return {
    bins: [
      bin('Small', 40, 30, 30, 15, stock(40 * 30 * 30), 3),
      bin('Medium', 60, 40, 40, 30, stock(60 * 40 * 40), 5),
      bin('Large', 80, 60, 60, 60, stock(80 * 60 * 60), 8),
    ],
    items: out,
  };
}
