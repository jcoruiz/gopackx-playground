// Turns the current scenario and solver settings into a runnable Go program
// that does the same thing with the library. The output is gofmt-clean
// (checked in test/codegen.test.ts).

import { isCatalogMode, type BinSpec, type EngineName, type ItemSpec, type SolveRequest, type StrategyName } from './types';

const num = (n: number) => String(n);
const str = (s: string) => JSON.stringify(s);

function engineExpr(engine: EngineName, ratio: number): string {
  const stable = ratio > 0;
  switch (engine) {
    case 'pivot':
      return stable ? `placement.NewPivotEngine(placement.WithStability(${num(ratio)}))` : 'placement.NewPivotEngine()';
    case 'extremepoint':
      return stable ? `placement.NewExtremePointEngine(placement.WithEPStability(${num(ratio)}))` : 'placement.NewExtremePointEngine()';
    case 'maxrects':
      return stable ? `placement.NewMaxRectsEngine(placement.WithMaxRectsStability(${num(ratio)}))` : 'placement.NewMaxRectsEngine()';
    case 'laff':
      return stable ? `placement.NewLAFFEngine(placement.WithLAFFStability(${num(ratio)}))` : 'placement.NewLAFFEngine()';
    case 'laff-fast':
      return stable ? `placement.NewLAFFEngine(placement.LAFFFast(), placement.WithLAFFStability(${num(ratio)}))` : 'placement.NewLAFFEngine(placement.LAFFFast())';
  }
}

function binCall(b: BinSpec, id: string): string {
  const cost = b.cost > 0 ? `, model.BinCost(${num(b.cost)})` : '';
  return `model.NewBin(${id}, ${num(b.w)}, ${num(b.h)}, ${num(b.d)}, ${num(b.maxWeight)}${cost})`;
}

function itemCall(s: ItemSpec, id: string): string {
  const opts: string[] = [];
  if (s.upright) opts.push('model.ItemUpright()');
  if (s.fragile) opts.push('model.ItemFragile()');
  if (s.loadBear > 0) opts.push(`model.ItemLoadBear(${num(s.loadBear)})`);
  if (s.priority > 0) opts.push(`model.ItemPriority(${s.priority})`);
  if (s.group) opts.push(`model.ItemGroup(${str(s.group)})`);
  return `model.NewItem(${id}, ${num(s.w)}, ${num(s.h)}, ${num(s.d)}, ${num(s.weight)}${opts.map((o) => ', ' + o).join('')})`;
}

/** A slice literal when every line is a single unit, appends and loops otherwise. */
function listBlock<T extends { id: string; qty: number }>(
  name: string,
  type: string,
  lines: T[],
  call: (line: T, id: string) => string,
  expand: boolean,
  sep: string,
  needs: Set<string>,
): string[] {
  if (!expand || lines.every((l) => Math.max(l.qty, 1) === 1)) {
    return [`\t${name} := []*model.${type}{`, ...lines.map((l) => `\t\t${call(l, str(l.id))},`), '\t}'];
  }
  needs.add('fmt');
  const out = [`\tvar ${name} []*model.${type}`];
  for (const l of lines) {
    const n = Math.max(l.qty, 1);
    if (n === 1) {
      out.push(`\t${name} = append(${name}, ${call(l, str(l.id))})`);
    } else {
      out.push(
        `\tfor i := 1; i <= ${n}; i++ {`,
        `\t\t${name} = append(${name}, ${call(l, `fmt.Sprint(${str(l.id + sep)}, i)`)})`,
        '\t}',
      );
    }
  }
  return out;
}

export function generateGo(req: SolveRequest): string {
  const imports = new Set<string>(['context', 'fmt', 'time', 'github.com/jcoruiz/gopackx/pkg/model']);
  const catalog = isCatalogMode(req.mode);
  const body: string[] = [];
  const strategyName = (s: StrategyName) => {
    imports.add('github.com/jcoruiz/gopackx/pkg/strategy');
    return `strategy.${s}`;
  };

  const seconds = req.timeoutMs / 1000;
  body.push(
    Number.isInteger(seconds)
      ? `\tctx, cancel := context.WithTimeout(context.Background(), ${seconds}*time.Second)`
      : `\tctx, cancel := context.WithTimeout(context.Background(), ${req.timeoutMs}*time.Millisecond)`,
    '\tdefer cancel()',
    '',
  );

  if (catalog) {
    body.push('\t// Box types: the solver opens as many of each as it needs.');
    body.push(...listBlock('boxes', 'Bin', req.bins, binCall, false, '', imports));
  } else {
    body.push('\t// Boxes in stock.');
    body.push(...listBlock('boxes', 'Bin', req.bins, binCall, true, ' #', imports));
  }
  body.push('');
  body.push(...listBlock('items', 'Item', req.items, itemCall, true, '-', imports));
  body.push('');

  const defaultEngine = req.engine === 'pivot' && req.stability <= 0;
  const usesFactory = req.mode !== 'packer' && req.mode !== 'parallel' && !(defaultEngine && (req.mode === 'pack' || req.mode === 'optimize'));
  if (usesFactory) {
    imports.add('github.com/jcoruiz/gopackx/pkg/placement');
    body.push('\tnewEngine := func() placement.Engine {', `\t\treturn ${engineExpr(req.engine, req.stability)}`, '\t}', '');
  }

  switch (req.mode) {
    case 'pack':
    case 'optimize': {
      imports.add('github.com/jcoruiz/gopackx');
      const opts: string[] = [];
      if (!defaultEngine) opts.push('gopackx.WithEngine(newEngine)');
      if (req.mode === 'optimize') opts.push('gopackx.Optimize()');
      body.push(`\tresult, err := gopackx.Pack(ctx, boxes, items${opts.map((o) => ', ' + o).join('')})`);
      break;
    }
    case 'trial': {
      imports.add('github.com/jcoruiz/gopackx/pkg/solver');
      const opts: string[] = [];
      if (req.lookahead) opts.push('solver.WithLookahead()');
      if (req.strategy !== 'BestFitDecreasing') opts.push(`solver.TrialItemSort(${strategyName(req.strategy)})`);
      body.push(`\tresult, err := solver.NewTrialPacking(newEngine${opts.map((o) => ', ' + o).join('')}).Solve(ctx, boxes, items)`);
      break;
    }
    case 'metaheuristic': {
      imports.add('github.com/jcoruiz/gopackx/pkg/solver');
      const opts: string[] = [];
      if (req.maxIter > 0 && req.maxIter !== 1000) opts.push(`solver.MetaMaxIter(${req.maxIter})`);
      if (req.maxNoImprove > 0 && req.maxNoImprove !== 200) opts.push(`solver.MetaMaxNoImprove(${req.maxNoImprove})`);
      body.push(`\tresult, err := solver.NewMetaheuristic(newEngine${opts.map((o) => ', ' + o).join('')}).Solve(ctx, boxes, items)`);
      break;
    }
    case 'packer': {
      imports.add('github.com/jcoruiz/gopackx/pkg/packer');
      imports.add('github.com/jcoruiz/gopackx/pkg/placement');
      const opts = [`packer.WithPlacementEngine(${engineExpr(req.engine, req.stability)})`];
      if (req.strategy !== 'BestFitDecreasing') opts.unshift(`packer.WithStrategy(${strategyName(req.strategy)})`);
      body.push(
        '\tp := packer.NewPacker(',
        ...opts.map((o) => `\t\t${o},`),
        '\t)',
        '\tfor _, b := range boxes {',
        '\t\tp.AddBin(b)',
        '\t}',
        '\tfor _, it := range items {',
        '\t\tp.AddItem(it)',
        '\t}',
        '\tresult, err := p.Pack(ctx)',
      );
      break;
    }
    case 'branchbound': {
      imports.add('github.com/jcoruiz/gopackx/pkg/solver');
      body.push(`\tresult, err := solver.NewBranchBound(newEngine${req.bbFull ? ', solver.BBFull()' : ''}).Solve(ctx, boxes, items)`);
      break;
    }
    case 'parallel': {
      imports.add('github.com/jcoruiz/gopackx/pkg/solver');
      if (req.stability <= 0) {
        body.push('\t// Tries the library default set of engine and strategy combinations.');
        body.push('\tresult, err := solver.NewParallel().Solve(ctx, boxes, items)');
      } else {
        imports.add('github.com/jcoruiz/gopackx/pkg/placement');
        const combos: [EngineName, StrategyName][] = [
          ['pivot', 'BestFitDecreasing'],
          ['pivot', 'MinimizeBins'],
          ['extremepoint', 'BestFitDecreasing'],
          ['laff', 'BestFitDecreasing'],
          ['laff-fast', 'BestFitDecreasing'],
        ];
        body.push('\tresult, err := solver.NewParallel(');
        for (const [e, s] of combos) {
          body.push(
            '\t\tsolver.WithConfig(func() placement.Engine {',
            `\t\t\treturn ${engineExpr(e, req.stability)}`,
            `\t\t}, ${strategyName(s)}),`,
          );
        }
        body.push('\t).Solve(ctx, boxes, items)');
      }
      break;
    }
  }

  body.push(
    '\tif err != nil {',
    '\t\tfmt.Println("stopped early:", err)',
    '\t}',
    '\tif result == nil {',
    '\t\treturn',
    '\t}',
    '',
    '\tfmt.Printf("Fitted %d/%d items in %d boxes, %.1f%% average fill\\n",',
    '\t\tresult.Stats.FittedItems, result.Stats.TotalItems, result.Stats.TotalBins, result.Stats.VolumeUsedPct)',
  );
  if (req.bins.some((b) => b.cost > 0)) body.push('\tfmt.Printf("Total cost: %.2f\\n", result.Stats.TotalCost)');
  body.push(
    '\tfor _, bin := range result.Bins {',
    '\t\tif len(bin.Items) == 0 {',
    '\t\t\tcontinue',
    '\t\t}',
    '\t\tfmt.Printf("%s: %d items, %.1f%% full, %.2f kg\\n", bin.ID, len(bin.Items), bin.VolumeUsedPct(), bin.TotalWeight())',
    '\t\tfor _, it := range bin.Items {',
    '\t\t\td := it.Dimension()',
    '\t\t\tfmt.Printf("  %s at (%g, %g, %g) size %gx%gx%g\\n", it.ID, it.Position[0], it.Position[1], it.Position[2], d[0], d[1], d[2])',
    '\t\t}',
    '\t}',
    '\tfor _, it := range result.UnfittedItems {',
    '\t\tfmt.Println("did not fit:", it.ID)',
    '\t}',
  );

  const std = [...imports].filter((i) => !i.includes('.')).sort();
  const ext = [...imports].filter((i) => i.includes('.')).sort();
  return [
    '// Generated by the GoPackX Playground: https://gopackx.than.cl',
    'package main',
    '',
    'import (',
    ...std.map((i) => `\t"${i}"`),
    '',
    ...ext.map((i) => `\t"${i}"`),
    ')',
    '',
    'func main() {',
    ...body,
    '}',
    '',
  ].join('\n');
}
