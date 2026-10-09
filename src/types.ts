// Shapes shared with the Go bridge (wasm/solve.go). Field names must match
// its JSON tags.

export type Mode = 'pack' | 'optimize' | 'trial' | 'metaheuristic' | 'packer' | 'branchbound' | 'parallel';
export type EngineName = 'pivot' | 'extremepoint' | 'maxrects' | 'laff' | 'laff-fast';
export type StrategyName =
  | 'BestFitDecreasing'
  | 'MinimizeBins'
  | 'BestFit'
  | 'Greedy'
  | 'NextFit'
  | 'WorstFit'
  | 'AlmostWorstFit';

export interface BinSpec {
  id: string;
  w: number;
  h: number;
  d: number;
  maxWeight: number;
  cost: number;
  qty: number;
}

export interface ItemSpec {
  id: string;
  w: number;
  h: number;
  d: number;
  weight: number;
  qty: number;
  upright: boolean;
  fragile: boolean;
  loadBear: number;
  priority: number;
  group: string;
}

export interface SolverConfig {
  mode: Mode;
  engine: EngineName;
  strategy: StrategyName;
  stability: number;
  lookahead: boolean;
  maxIter: number;
  maxNoImprove: number;
  bbFull: boolean;
  timeoutMs: number;
}

export interface Scenario {
  bins: BinSpec[];
  items: ItemSpec[];
}

export type SolveRequest = SolverConfig & Scenario;

export interface PlacedItem {
  id: string;
  spec: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  rotation: number;
  weight: number;
  support: number;
  load: number;
}

export interface BinResult {
  id: string;
  spec: number;
  w: number;
  h: number;
  d: number;
  maxWeight: number;
  cost: number;
  weight: number;
  volumePct: number;
  /** Weight share per floor quadrant: front-left, front-right, back-left, back-right. */
  gravity: [number, number, number, number];
  items: PlacedItem[];
}

export interface Stats {
  totalBins: number;
  totalItems: number;
  fittedItems: number;
  unfittedCount: number;
  volumeUsedPct: number;
  weightUsedPct: number;
  totalCost: number;
}

export interface SolveResponse {
  ok: boolean;
  error?: string;
  elapsedMs: number;
  timedOut: boolean;
  stats: Stats;
  bins: BinResult[];
  unfitted: { id: string; spec: number }[];
  unusedBins: number;
}

export interface BuildInfo {
  library: string;
  goVersion: string;
}

export const CATALOG_MODES: readonly Mode[] = ['pack', 'optimize', 'trial', 'metaheuristic'];

export function isCatalogMode(mode: Mode): boolean {
  return CATALOG_MODES.includes(mode);
}

export const MODES: Record<Mode, { label: string; about: string }> = {
  pack: {
    label: 'Pack',
    about: 'gopackx.Pack: TrialPacking with lookahead picks which box types to open. Fast, good default.',
  },
  optimize: {
    label: 'Pack + Optimize',
    about: 'gopackx.Pack with Optimize(): a VNS metaheuristic moves, swaps and repacks items across boxes to use fewer (or cheaper) ones.',
  },
  trial: {
    label: 'TrialPacking',
    about: 'Simulates each box type on the remaining items and opens the one that fills best. Lookahead also estimates the boxes still needed.',
  },
  metaheuristic: {
    label: 'Metaheuristic',
    about: 'Variable Neighborhood Search seeded by TrialPacking. Every move is revalidated with the real 3D engine.',
  },
  packer: {
    label: 'Packer',
    about: 'Packs into the boxes you have in stock (Qty), with the chosen item order and box selection strategy.',
  },
  branchbound: {
    label: 'Branch & Bound',
    about: 'Exhaustive search per box over item orders (and rotations in Full mode). Exact for small sets: around 12 items, 8 in Full.',
  },
  parallel: {
    label: 'Parallel',
    about: 'Runs five engine/strategy combinations and keeps the best result.',
  },
};

export const ENGINES: Record<EngineName, { label: string; about: string }> = {
  pivot: { label: 'Pivot Points', about: 'Corner-based candidates. Fastest general-purpose engine (default).' },
  extremepoint: { label: 'Extreme Points', about: 'Scored placement with space and support metadata.' },
  maxrects: { label: 'MaxRects', about: 'Tracks maximal free spaces and places into the best one.' },
  laff: { label: 'LAFF', about: 'Largest Area Fit First: builds horizontal levels.' },
  'laff-fast': { label: 'LAFF Fast', about: 'LAFF with 2D-only placement inside each level.' },
};

export const STRATEGIES: Record<StrategyName, string> = {
  BestFitDecreasing: 'Large items first, fullest box that fits (default)',
  MinimizeBins: 'Large items first, first box that fits',
  BestFit: 'Small items first, fullest box that fits',
  Greedy: 'Small items first, first box that fits',
  NextFit: 'Small items first, current box only',
  WorstFit: 'Small items first, emptiest box',
  AlmostWorstFit: 'Small items first, emptiest box skipping nearly empty ones',
};

export const DEFAULT_CONFIG: SolverConfig = {
  mode: 'pack',
  engine: 'pivot',
  strategy: 'BestFitDecreasing',
  stability: 0,
  lookahead: true,
  maxIter: 1000,
  maxNoImprove: 200,
  bbFull: false,
  timeoutMs: 5000,
};
