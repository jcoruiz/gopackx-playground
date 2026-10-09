// Colors for the viewer and results. Categorical slots are the validated
// dark-mode order of the dataviz reference palette, assigned in fixed order
// and never cycled: past eight, entries fold into "Other".

import type { BinResult, ItemSpec, PlacedItem } from './types';

export const CATEGORICAL = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
export const OTHER = '#6f6e69';

// Blue ramp, steps 550 → 150: low values recede toward the dark surface.
const RAMP = ['#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6'];

export type ColorMode = 'type' | 'group' | 'flags' | 'weight' | 'support';

export const COLOR_MODES: Record<ColorMode, string> = {
  type: 'Item type',
  group: 'Group',
  flags: 'Constraints',
  weight: 'Weight',
  support: 'Support',
};

export interface LegendEntry {
  color: string;
  label: string;
}

export interface Coloring {
  color(it: PlacedItem): string;
  legend: LegendEntry[];
  /** Set for continuous scales: the legend is a gradient from min to max. */
  scale?: { min: string; max: string };
}

export function ramp(t: number): string {
  const k = Math.round(Math.min(1, Math.max(0, t)) * (RAMP.length - 1));
  return RAMP[k];
}

export function coloring(mode: ColorMode, items: ItemSpec[], bin: BinResult | null): Coloring {
  switch (mode) {
    case 'type': {
      const legend: LegendEntry[] = items.slice(0, CATEGORICAL.length).map((s, i) => ({ color: CATEGORICAL[i], label: s.id }));
      if (items.length > CATEGORICAL.length) legend.push({ color: OTHER, label: `Other (${items.length - CATEGORICAL.length} types)` });
      return { color: (it) => CATEGORICAL[it.spec] ?? OTHER, legend };
    }
    case 'group': {
      const groups = [...new Set(items.map((s) => s.group).filter(Boolean))];
      const slot = new Map(groups.slice(0, CATEGORICAL.length).map((g, i) => [g, CATEGORICAL[i]]));
      const legend: LegendEntry[] = [...slot].map(([g, color]) => ({ color, label: g }));
      legend.push({ color: OTHER, label: groups.length > slot.size ? 'Other groups or none' : 'No group' });
      return { color: (it) => slot.get(items[it.spec]?.group ?? '') ?? OTHER, legend };
    }
    case 'flags': {
      const kind = (s: ItemSpec | undefined) => (s?.fragile ? 0 : s?.upright ? 1 : (s?.loadBear ?? 0) > 0 ? 2 : 3);
      const colors = [CATEGORICAL[1], CATEGORICAL[0], CATEGORICAL[2], OTHER];
      return {
        color: (it) => colors[kind(items[it.spec])],
        legend: [
          { color: colors[0], label: 'Fragile' },
          { color: colors[1], label: 'Upright' },
          { color: colors[2], label: 'Load limit' },
          { color: colors[3], label: 'No constraint' },
        ],
      };
    }
    case 'weight': {
      const ws = bin?.items.map((it) => it.weight) ?? [0];
      const lo = Math.min(...ws);
      const hi = Math.max(...ws);
      return {
        color: (it) => ramp(hi > lo ? (it.weight - lo) / (hi - lo) : 1),
        legend: [
          { color: RAMP[0], label: `${fmtKg(lo)} kg` },
          { color: RAMP[RAMP.length - 1], label: `${fmtKg(hi)} kg` },
        ],
        scale: { min: RAMP[0], max: RAMP[RAMP.length - 1] },
      };
    }
    case 'support':
      return {
        color: (it) => ramp(it.support),
        legend: [
          { color: RAMP[0], label: '0% of base supported' },
          { color: RAMP[RAMP.length - 1], label: '100%' },
        ],
        scale: { min: RAMP[0], max: RAMP[RAMP.length - 1] },
      };
  }
}

export const fmtKg = (n: number) => (Math.round(n * 100) / 100).toString();
