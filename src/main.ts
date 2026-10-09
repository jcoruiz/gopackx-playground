import './style.css';
import { generateGo } from './codegen';
import { highlightGo } from './highlight';
import { html, mount, raw } from './html';
import { CATEGORICAL, COLOR_MODES, OTHER, coloring, fmtKg, ramp, type ColorMode } from './palette';
import { PRESETS, item, randomScenario } from './presets';
import { decode, encode, sanitize, type Snapshot } from './share';
import { Cancelled, Solver } from './solver';
import {
  DEFAULT_CONFIG,
  ENGINES,
  MODES,
  STRATEGIES,
  isCatalogMode,
  type BinResult,
  type BinSpec,
  type BuildInfo,
  type EngineName,
  type ItemSpec,
  type Mode,
  type Scenario,
  type SolveRequest,
  type SolveResponse,
  type SolverConfig,
  type StrategyName,
} from './types';
import { summarize, verify, type Check } from './verify';
import { Viewer } from './viewer';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Run {
  req: SolveRequest;
  res: SolveResponse;
  checks: Check[];
}

interface CompareRow {
  solver: string;
  config: SolverConfig;
  run?: Run;
  error?: string;
}

type SortKey = 'rank' | 'solver' | 'engine' | 'strategy' | 'fitted' | 'boxes' | 'fill' | 'cost' | 'time';

const state = {
  preset: 'office',
  scenario: { bins: [], items: [] } as Scenario,
  config: { ...DEFAULT_CONFIG } as SolverConfig,
  run: null as Run | null,
  error: '',
  bin: 0,
  colorMode: 'type' as ColorMode,
  compare: [] as CompareRow[],
  comparing: false,
  sort: { key: 'rank' as SortKey, dir: 1 },
  share: '',
  info: null as BuildInfo | null,
};

const solver = new Solver();
const viewer = new Viewer($('viewer'));

// ---------------------------------------------------------------- formatting

const n1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString('en-US');
const n2 = (v: number) => (Math.round(v * 100) / 100).toLocaleString('en-US');
const dims = (w: number, h: number, d: number) => `${n2(w)} × ${n2(h)} × ${n2(d)}`;
// Browsers coarsen timers to 0.1 ms unless the page is cross-origin isolated.
const time = (ms: number) => (ms < 0.1 ? '< 0.1 ms' : ms < 10 ? `${n2(ms)} ms` : ms < 1000 ? `${n1(ms)} ms` : `${n2(ms / 1000)} s`);
const total = (lines: { qty: number }[]) => lines.reduce((s, l) => s + Math.max(l.qty, 1), 0);
const hasCosts = () => state.scenario.bins.some((b) => b.cost > 0);
const typeColor = (i: number) => CATEGORICAL[i] ?? OTHER;

function toast(msg: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 2200);
}

function banner(msg: string): void {
  const el = $('banner');
  el.textContent = msg;
  el.hidden = !msg;
}

// ---------------------------------------------------------------- scenario

function loadSnapshot(snap: Snapshot, preset: string): void {
  state.scenario = structuredClone(snap.scenario);
  state.config = { ...snap.config };
  state.preset = preset;
  state.compare = [];
  state.colorMode = state.scenario.items.some((s) => s.fragile || s.loadBear > 0) ? 'flags' : 'type';
  $<HTMLSelectElement>('color-mode').value = state.colorMode;
  renderScenario();
  renderSolverBar();
  renderCode();
  renderCompare();
  void run();
}

function loadPreset(key: string): void {
  const p = PRESETS.find((x) => x.key === key) ?? PRESETS[0];
  loadSnapshot({ scenario: p.scenario, config: { ...DEFAULT_CONFIG, ...p.config } }, p.key);
}

function renderScenario(): void {
  const sel = $<HTMLSelectElement>('preset');
  mount(
    sel,
    html`${PRESETS.map((p) => html`<option value="${p.key}">${p.name}</option>`)}${state.preset ? '' : html`<option value="">Custom</option>`}`,
  );
  sel.value = state.preset;
  $('preset-about').textContent = PRESETS.find((p) => p.key === state.preset)?.about ?? 'Your own scenario. Share it with the link button.';
  renderBins();
  renderItems();
}

function renderBins(): void {
  const catalog = isCatalogMode(state.config.mode);
  $('bins-table').classList.toggle('catalog', catalog);
  mount(
    $('bins-table'),
    html`<table class="grid">
      <thead><tr>
        <th>Name</th><th>W</th><th>H</th><th>D</th><th>Max kg</th><th>Cost</th>
        <th class="qty" title="Stock: how many of this box exist. Used by the fixed-box solvers.">Qty</th><th></th>
      </tr></thead>
      <tbody>${state.scenario.bins.map(
        (b, i) => html`<tr data-i="${i}">
          <td class="name"><input data-f="id" value="${b.id}" aria-label="Box name" /></td>
          ${(['w', 'h', 'd', 'maxWeight', 'cost'] as const).map((f) => html`<td>${numInput(f, b[f])}</td>`)}
          <td class="qty">${numInput('qty', b.qty, 'Stock')}</td>
          <td><button type="button" class="del" data-del aria-label="Remove ${b.id}">×</button></td>
        </tr>`,
      )}</tbody>
    </table>`,
  );
  binsHint();
}

function binsHint(): void {
  $('bins-hint').textContent = isCatalogMode(state.config.mode)
    ? `${state.scenario.bins.length} types, opened as needed`
    : `${total(state.scenario.bins)} in stock`;
}

const LABELS: Record<string, string> = { w: 'Width', h: 'Height', d: 'Depth', maxWeight: 'Max weight', cost: 'Cost', weight: 'Weight', qty: 'Quantity' };

function numInput(field: string, value: number, label = LABELS[field] ?? field) {
  const bad = (['w', 'h', 'd'].includes(field) && !(value > 0)) || value < 0;
  return html`<input type="number" step="any" min="0" data-f="${field}" value="${value}" aria-label="${label}" class="${bad ? 'invalid' : ''}" />`;
}

function badges(s: ItemSpec) {
  const b: [boolean, string, string][] = [
    [s.upright, 'U', 'Upright'],
    [s.fragile, 'F', 'Fragile'],
    [s.loadBear > 0, 'L', `Holds at most ${s.loadBear} kg`],
    [s.priority > 0, 'P', `Priority ${s.priority}`],
    [!!s.group, 'G', `Group ${s.group}`],
  ];
  const on = b.filter(([x]) => x);
  return on.length ? on.map(([, k, t]) => html`<span class="badge" title="${t}">${k}</span>`) : html`<span aria-hidden="true">⋯</span>`;
}

function renderItems(): void {
  mount(
    $('items-table'),
    html`<table class="grid">
      <thead><tr><th>Name</th><th>W</th><th>H</th><th>D</th><th>kg</th><th>Qty</th><th></th><th></th></tr></thead>
      <tbody>${state.scenario.items.map(
        (s, i) => html`<tr data-i="${i}">
            <td class="name"><span class="name-cell"><span class="swatch" style="--c:${typeColor(i)}"></span><input data-f="id" value="${s.id}" aria-label="Item name" /></span></td>
            ${(['w', 'h', 'd', 'weight', 'qty'] as const).map((f) => html`<td>${numInput(f, s[f])}</td>`)}
            <td><button type="button" class="more" data-more aria-expanded="false" title="Constraints">${badges(s)}</button></td>
            <td><button type="button" class="del" data-del aria-label="Remove ${s.id}">×</button></td>
          </tr>
          <tr class="extra" data-i="${i}" hidden>
            <td colspan="8"><div class="extra-fields">
              <label><input type="checkbox" data-f="upright" ${s.upright ? raw('checked') : ''} /> Upright</label>
              <label><input type="checkbox" data-f="fragile" ${s.fragile ? raw('checked') : ''} /> Fragile</label>
              <label>Holds max ${numInput('loadBear', s.loadBear, 'Load limit')} kg</label>
              <label>Priority <input type="number" min="0" step="1" data-f="priority" value="${s.priority}" /></label>
              <label>Group <input type="text" data-f="group" value="${s.group}" /></label>
            </div></td>
          </tr>`,
      )}</tbody>
    </table>`,
  );
  const lines = state.scenario.items.length;
  $('items-hint').textContent = `${total(state.scenario.items)} items in ${lines} ${lines === 1 ? 'line' : 'lines'}`;
}

function onTableInput(kind: 'bins' | 'items', e: Event): void {
  const t = e.target as HTMLInputElement;
  const f = t.dataset.f;
  const i = Number(t.closest('tr')?.dataset.i);
  if (!f || !Number.isInteger(i)) return;
  const row = (kind === 'bins' ? state.scenario.bins[i] : state.scenario.items[i]) as unknown as Record<string, unknown>;

  if (t.type === 'checkbox') row[f] = t.checked;
  else if (t.type === 'number') {
    const v = parseFloat(t.value);
    row[f] = f === 'qty' ? Math.max(1, Math.round(v) || 1) : f === 'priority' ? Math.max(0, Math.round(v) || 0) : Number.isFinite(v) ? v : 0;
    t.classList.toggle('invalid', (['w', 'h', 'd'].includes(f) && !(v > 0)) || v < 0 || !Number.isFinite(v));
  } else row[f] = t.value.slice(0, 60);

  if (kind === 'items') {
    const more = $('items-table').querySelector(`tr[data-i="${i}"] [data-more]`);
    if (more) mount(more, html`${badges(state.scenario.items[i])}`);
    $('items-hint').textContent = `${total(state.scenario.items)} items in ${state.scenario.items.length} lines`;
  } else binsHint();
  changed(true);
}

function onTableClick(kind: 'bins' | 'items', e: Event): void {
  const t = e.target as HTMLElement;
  const tr = t.closest('tr');
  const i = Number(tr?.dataset.i);
  if (t.closest('[data-del]')) {
    (kind === 'bins' ? state.scenario.bins : state.scenario.items).splice(i, 1);
    kind === 'bins' ? renderBins() : renderItems();
    changed(true);
  } else if (t.closest('[data-more]')) {
    const extra = $('items-table').querySelector<HTMLElement>(`tr.extra[data-i="${i}"]`);
    if (!extra) return;
    extra.hidden = !extra.hidden;
    t.closest('[data-more]')!.setAttribute('aria-expanded', String(!extra.hidden));
  }
}

function addRow(kind: 'bins' | 'items'): void {
  if (kind === 'bins') {
    const n = state.scenario.bins.length + 1;
    state.scenario.bins.push({ id: `Box ${n}`, w: 50, h: 40, d: 40, maxWeight: 30, cost: 0, qty: 2 } satisfies BinSpec);
    renderBins();
  } else {
    state.scenario.items.push(item(`Item ${state.scenario.items.length + 1}`, 20, 15, 20, 1));
    renderItems();
  }
  const rows = $(kind === 'bins' ? 'bins-table' : 'items-table').querySelectorAll<HTMLInputElement>('input[data-f="id"]');
  rows[rows.length - 1]?.select();
  changed(true);
}

/** Called after any edit. Scenario edits turn the preset into "Custom". */
function changed(scenarioEdit: boolean): void {
  if (scenarioEdit && state.preset) {
    state.preset = '';
    renderScenarioHead();
  }
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (scenarioEdit && state.compare.length) {
    state.compare = [];
    renderCompare();
  }
  renderCode();
  scheduleRun();
}

function renderScenarioHead(): void {
  const sel = $<HTMLSelectElement>('preset');
  if (!state.preset && !sel.querySelector('option[value=""]')) sel.append(new Option('Custom', ''));
  sel.value = state.preset;
  $('preset-about').textContent = PRESETS.find((p) => p.key === state.preset)?.about ?? 'Your own scenario. Share it with the link button.';
}

// ---------------------------------------------------------------- solver bar

function setupSolverBar(): void {
  const catalog = (Object.keys(MODES) as Mode[]).filter(isCatalogMode);
  const fixed = (Object.keys(MODES) as Mode[]).filter((m) => !isCatalogMode(m));
  mount(
    $('mode'),
    html`<optgroup label="Box catalog: the solver picks the boxes">${catalog.map((m) => html`<option value="${m}">${MODES[m].label}</option>`)}</optgroup>
      <optgroup label="Fixed boxes: Qty is the stock">${fixed.map((m) => html`<option value="${m}">${MODES[m].label}</option>`)}</optgroup>`,
  );
  mount($('engine'), html`${(Object.keys(ENGINES) as EngineName[]).map((e) => html`<option value="${e}">${ENGINES[e].label}</option>`)}`);
  mount(
    $('strategy'),
    html`${(Object.keys(STRATEGIES) as StrategyName[]).map((s) => html`<option value="${s}" title="${STRATEGIES[s]}">${s}</option>`)}`,
  );
  mount($('color-mode'), html`${(Object.keys(COLOR_MODES) as ColorMode[]).map((c) => html`<option value="${c}">${COLOR_MODES[c]}</option>`)}`);

  const bind = (id: string, apply: (el: HTMLInputElement) => void) =>
    $(id).addEventListener('change', (e) => {
      apply(e.target as HTMLInputElement);
      const modeChanged = id === 'mode';
      renderSolverBar();
      if (modeChanged) {
        renderBins();
        state.compare = [];
        renderCompare();
      }
      changed(false);
    });
  bind('mode', (el) => (state.config.mode = el.value as Mode));
  bind('engine', (el) => (state.config.engine = el.value as EngineName));
  bind('strategy', (el) => (state.config.strategy = el.value as StrategyName));
  bind('stability', (el) => (state.config.stability = Math.min(1, Math.max(0, (parseFloat(el.value) || 0) / 100))));
  bind('timeout', (el) => (state.config.timeoutMs = Math.round(Math.min(60, Math.max(0.1, parseFloat(el.value) || 5)) * 1000)));
  bind('lookahead', (el) => (state.config.lookahead = el.checked));
  bind('max-iter', (el) => (state.config.maxIter = Math.max(1, Math.round(parseFloat(el.value) || DEFAULT_CONFIG.maxIter))));
  bind('max-no-improve', (el) => (state.config.maxNoImprove = Math.max(1, Math.round(parseFloat(el.value) || DEFAULT_CONFIG.maxNoImprove))));
  bind('bb-full', (el) => (state.config.bbFull = el.checked));
}

function renderSolverBar(): void {
  const c = state.config;
  const set = (id: string, v: string | boolean) => {
    const el = $<HTMLInputElement>(id);
    if (typeof v === 'boolean') el.checked = v;
    else el.value = v;
  };
  set('mode', c.mode);
  set('engine', c.engine);
  set('strategy', c.strategy);
  set('stability', String(Math.round(c.stability * 100)));
  set('timeout', String(c.timeoutMs / 1000));
  set('lookahead', c.lookahead);
  set('max-iter', String(c.maxIter));
  set('max-no-improve', String(c.maxNoImprove));
  set('bb-full', c.bbFull);

  const show: Record<string, boolean> = {
    engine: c.mode !== 'parallel',
    strategy: c.mode === 'packer' || c.mode === 'trial',
    lookahead: c.mode === 'trial',
    meta: c.mode === 'metaheuristic',
    bbfull: c.mode === 'branchbound',
  };
  document.querySelectorAll<HTMLElement>('[data-show]').forEach((el) => (el.hidden = !show[el.dataset.show!]));

  const engine = c.mode === 'parallel' ? '' : ` Engine: ${ENGINES[c.engine].about}`;
  const support = c.stability > 0 ? ` Each item needs ${Math.round(c.stability * 100)}% of its base supported, and load limits apply.` : '';
  $('mode-about').textContent = MODES[c.mode].about + engine + support;
}

// ---------------------------------------------------------------- running

let runToken = 0;
let debounce = 0;
let busyTimer = 0;
let inFlight = false;

function scheduleRun(): void {
  if (!$<HTMLInputElement>('auto-run').checked || state.comparing) return;
  clearTimeout(debounce);
  debounce = window.setTimeout(() => void run(), 450);
}

function setBusy(on: boolean, label = 'Solving…'): void {
  clearTimeout(busyTimer);
  $('busy-label').textContent = label;
  if (on) busyTimer = window.setTimeout(() => ($('busy').hidden = false), 120);
  else $('busy').hidden = true;
  $<HTMLButtonElement>('btn-run').disabled = state.comparing;
}

async function run(): Promise<void> {
  if (state.comparing) return;
  clearTimeout(debounce);
  const token = ++runToken;
  if (inFlight) solver.cancel();
  const req: SolveRequest = structuredClone({ ...state.config, ...state.scenario });
  inFlight = true;
  setBusy(true);
  try {
    const res = await solver.solve(req);
    if (token !== runToken) return;
    setRun(res.ok ? { req, res, checks: verify(req, res) } : null, res.error ?? '');
  } catch (err) {
    if (err instanceof Cancelled || token !== runToken) return;
    setRun(null, err instanceof Error ? err.message : String(err));
  } finally {
    if (token === runToken) {
      inFlight = false;
      setBusy(false);
    }
  }
}

function setRun(r: Run | null, error = ''): void {
  state.run = r;
  state.error = error;
  state.bin = 0;
  renderRun(false);
  void refreshShare();
}

function stop(): void {
  runToken++;
  state.comparing = false;
  solver.cancel();
  inFlight = false;
  setBusy(false);
  renderCompare();
}

// ---------------------------------------------------------------- viewer

function currentBin(): BinResult | null {
  return state.run?.res.bins[state.bin] ?? null;
}

function renderRun(keepCamera: boolean): void {
  const r = state.run;
  const bins = r?.res.bins ?? [];
  const sel = $<HTMLSelectElement>('bin-select');
  mount(
    sel,
    html`${bins.map((b, i) => html`<option value="${i}">${b.id} · ${b.items.length} items · ${n1(b.volumePct)}%</option>`)}`,
  );
  sel.value = String(state.bin);
  sel.disabled = bins.length < 2;
  $<HTMLButtonElement>('bin-prev').disabled = state.bin <= 0;
  $<HTMLButtonElement>('bin-next').disabled = state.bin >= bins.length - 1;
  $('viewer-empty').hidden = bins.length > 0;
  $('viewer-empty').textContent = state.error ? 'No result. See the error below.' : r ? 'Nothing was packed.' : 'Run a solver to see the packing.';

  showBin(keepCamera);
  renderResult();
  renderChecks();
}

function showBin(keepCamera = false): void {
  const bin = currentBin();
  const items = state.run?.req.items ?? [];
  const col = coloring(state.colorMode, items, bin);
  viewer.show(bin, col.color, keepCamera);
  renderLegend();
  const n = bin?.items.length ?? 0;
  const step = $<HTMLInputElement>('step');
  step.max = String(n);
  step.value = String(n);
  stepLabel(n, n);
}

function renderLegend(): void {
  const col = coloring(state.colorMode, state.run?.req.items ?? [], currentBin());
  if (!currentBin()) return mount($('legend'), html``);
  mount(
    $('legend'),
    col.scale
      ? html`<div class="legend-row">${col.legend[0].label}</div>
          <div class="gradient" style="--a:${col.scale.min};--b:${col.scale.max}"></div>
          <div class="legend-row">${col.legend[1].label}</div>`
      : html`${col.legend.map((l) => html`<div class="legend-row"><span class="swatch" style="--c:${l.color}"></span>${l.label}</div>`)}`,
  );
}

function stepLabel(v: number, n: number): void {
  $('step-label').textContent = n ? `${v} of ${n} placed` : '';
}

let playing = 0;
function play(): void {
  const bin = currentBin();
  if (!bin) return;
  cancelAnimationFrame(playing);
  const n = bin.items.length;
  const duration = Math.min(5000, Math.max(1200, n * 90));
  const start = performance.now();
  const step = $<HTMLInputElement>('step');
  const tick = (now: number) => {
    const v = Math.min(n, Math.floor(((now - start) / duration) * (n + 1)));
    step.value = String(v);
    viewer.setVisible(v);
    stepLabel(v, n);
    if (v < n) playing = requestAnimationFrame(tick);
  };
  playing = requestAnimationFrame(tick);
}

viewer.onHover = (it, x, y) => {
  const tip = $('tooltip');
  if (!it || !state.run) return void (tip.hidden = true);
  const s = state.run.req.items[it.spec];
  const bin = currentBin()!;
  const rotated = s && (s.w !== it.w || s.h !== it.h || s.d !== it.d);
  const flags = s ? [s.upright && 'upright', s.fragile && 'fragile', s.loadBear > 0 && `holds max ${s.loadBear} kg`, s.group && `group ${s.group}`].filter(Boolean) : [];
  mount(
    tip,
    html`<div class="tt-head"><span class="swatch" style="--c:${coloring(state.colorMode, state.run.req.items, bin).color(it)}"></span><strong>${it.id}</strong></div>
      <div>${dims(it.w, it.h, it.d)}${rotated ? html` <span class="muted">(rotated from ${dims(s.w, s.h, s.d)})</span>` : ''}</div>
      <div>at x ${n2(it.x)}, y ${n2(it.y)}, z ${n2(it.z)}</div>
      <div>${fmtKg(it.weight)} kg · ${Math.round(it.support * 100)}% supported · ${fmtKg(it.load)} kg on top</div>
      ${flags.length ? html`<div>${flags.join(' · ')}</div>` : ''}
      <div class="muted">placed ${bin.items.indexOf(it) + 1} of ${bin.items.length}</div>`,
  );
  tip.hidden = false;
  const card = tip.parentElement!.getBoundingClientRect();
  const left = Math.min(x + 16, card.width - tip.offsetWidth - 8);
  const top = y + 16 + tip.offsetHeight > card.height - 8 ? y - tip.offsetHeight - 12 : y + 16;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
};

// ---------------------------------------------------------------- result tab

function statusTile(checks: Check[]) {
  const s = summarize(checks);
  return html`<button type="button" class="stat" data-goto="checks">
    <div class="k">Independent checks</div>
    <div class="v"><span class="status ${s.failed ? 'bad' : 'good'}"><span class="dot"></span>${s.failed ? `${s.failed} failed` : 'All pass'}</span></div>
    <div class="s">${s.passed} passed${s.skipped ? `, ${s.skipped} not applicable` : ''}</div>
  </button>`;
}

function quad(g: [number, number, number, number]) {
  const cell = (v: number, name: string) => {
    const t = Math.min(1, v / 50);
    return html`<div style="--c:${ramp(t)};--t:${t > 0.55 ? '#121211' : '#f4f3ee'}" title="${name}: ${n1(v)}% of the weight">${Math.round(v)}</div>`;
  };
  return html`<div class="quad" title="Weight per floor quadrant, top view, front row first">
    ${cell(g[0], 'Front left')}${cell(g[1], 'Front right')}${cell(g[2], 'Back left')}${cell(g[3], 'Back right')}
  </div>`;
}

function renderResult(): void {
  const el = $('tab-result');
  if (state.error) {
    return mount(el, html`<div class="error-box"><strong>The solver returned an error.</strong><br />${state.error}</div>`);
  }
  const r = state.run;
  if (!r) return mount(el, html`<p class="muted">No result yet.</p>`);
  const { res, req } = r;
  const st = res.stats;
  const catalog = isCatalogMode(req.mode);
  const costs = req.bins.some((b) => b.cost > 0);

  mount(
    el,
    html`<div class="stats">
        <div class="stat"><div class="k">Items packed</div><div class="v">${st.fittedItems}<span class="muted"> / ${st.totalItems}</span></div>
          <div class="s">${st.unfittedCount ? html`<span class="status warn"><span class="dot"></span>${st.unfittedCount} did not fit</span>` : 'all of them'}</div></div>
        <div class="stat"><div class="k">Boxes used</div><div class="v">${st.totalBins}</div>
          <div class="s">${catalog ? 'chosen from the catalog' : `of ${res.bins.length + res.unusedBins} in stock`}</div></div>
        <div class="stat"><div class="k">Average fill</div><div class="v">${n1(st.volumeUsedPct)}%</div><div class="s">of box volume</div></div>
        <div class="stat"><div class="k">Weight used</div><div class="v">${n1(st.weightUsedPct)}%</div><div class="s">of the boxes' limits</div></div>
        ${costs ? html`<div class="stat"><div class="k">Total cost</div><div class="v">${n2(st.totalCost)}</div><div class="s">sum of box prices</div></div>` : ''}
        <div class="stat"><div class="k">Solve time</div><div class="v">${time(res.elapsedMs)}</div>
          <div class="s">${res.timedOut ? html`<span class="status warn"><span class="dot"></span>time limit hit, best so far</span>` : 'in WebAssembly'}</div></div>
        ${statusTile(r.checks)}
      </div>
      ${
        res.bins.length
          ? html`<table class="list">
          <thead><tr><th>Box</th><th>Size</th><th class="num">Items</th><th>Fill</th><th class="num">Weight</th>${costs ? html`<th class="num">Cost</th>` : ''}<th>Floor weight %</th></tr></thead>
          <tbody>${res.bins.map(
            (b, i) => html`<tr data-bin="${i}" class="${i === state.bin ? 'current' : ''}">
              <td>${b.id}${req.bins[b.spec] && !b.id.startsWith(req.bins[b.spec].id) ? html` <span class="muted">${req.bins[b.spec].id}</span>` : ''}</td>
              <td class="muted">${dims(b.w, b.h, b.d)}</td>
              <td class="num">${b.items.length}</td>
              <td><div class="bar"><div class="track"><div class="fill" style="width:${Math.min(100, b.volumePct)}%"></div></div><span>${n1(b.volumePct)}%</span></div></td>
              <td class="num">${fmtKg(b.weight)} <span class="muted">/ ${fmtKg(b.maxWeight)} kg</span></td>
              ${costs ? html`<td class="num">${n2(b.cost)}</td>` : ''}
              <td>${quad(b.gravity)}</td>
            </tr>`,
          )}</tbody>
        </table>`
          : ''
      }
      ${
        res.unfitted.length
          ? html`<h2 class="section-title">Did not fit (${res.unfitted.length})</h2>
          <div class="chips">${res.unfitted.slice(0, 200).map((u) => html`<span class="chip">${u.id}</span>`)}${res.unfitted.length > 200 ? html`<span class="chip">…</span>` : ''}</div>`
          : ''
      }`,
  );
}

// ---------------------------------------------------------------- checks tab

function renderChecks(): void {
  const r = state.run;
  const badge = $('checks-badge');
  if (!r) {
    badge.textContent = '';
    return mount($('tab-checks'), html`<p class="muted">${state.error ? 'No result to check.' : 'No result yet.'}</p>`);
  }
  const s = summarize(r.checks);
  mount(badge, html`<span class="status ${s.failed ? 'bad' : 'good'}"><span class="dot"></span>${s.failed ? s.failed : ''}</span>`);
  mount(
    $('tab-checks'),
    html`<p class="intro">Every result is re-checked here in TypeScript, independently of the Go code that produced it: geometry, orientation, weight, fragile items, support and the reported numbers. A failure means the library returned something it should not have.</p>
      <ul class="checks">${r.checks.map(
        (c) => html`<li class="${c.status}">
          <span class="icon" aria-label="${c.status}">${c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '–'}</span>
          <strong>${c.label}</strong>
          <div>${c.detail}${c.failures.length ? html`<ul>${c.failures.map((f) => html`<li>${f}</li>`)}</ul>` : ''}</div>
        </li>`,
      )}</ul>
      <p class="intro">${s.failed ? 'This looks like a bug in GoPackX.' : 'Found a result that looks wrong anyway?'}
        <a id="issue-link" href="${issueUrl()}" target="_blank" rel="noopener">Open an issue on GitHub with this exact case</a>.</p>`,
  );
}

function issueUrl(): string {
  const r = state.run;
  if (!r) return 'https://github.com/jcoruiz/gopackx/issues/new';
  const failed = r.checks.filter((c) => c.status === 'fail');
  const c = r.req;
  const setup = [MODES[c.mode].label, c.mode !== 'parallel' && ENGINES[c.engine].label, (c.mode === 'packer' || c.mode === 'trial') && c.strategy, c.stability > 0 && `support ${Math.round(c.stability * 100)}%`]
    .filter(Boolean)
    .join(' · ');
  const title = failed.length ? `Playground: ${failed.map((f) => f.label.toLowerCase()).join(', ')} check failed` : 'Playground: ';
  const body = [
    `**Case:** ${state.share || location.href}`,
    `**Solver:** ${setup}`,
    `**Library:** gopackx ${state.info?.library ?? '?'} (${state.info?.goVersion ?? '?'}, js/wasm)`,
    `**Result:** ${r.res.stats.fittedItems}/${r.res.stats.totalItems} items in ${r.res.stats.totalBins} boxes`,
    '',
    failed.length ? '**Failed checks:**' : '',
    ...failed.flatMap((f) => [`- ${f.label}: ${f.detail}`, ...f.failures.map((x) => `  - ${x}`)]),
    '',
    '**What I expected:**',
    '',
  ].join('\n');
  return `https://github.com/jcoruiz/gopackx/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

async function shareUrl(): Promise<string> {
  const frag = await encode({ scenario: state.scenario, config: state.config });
  return `${location.origin}${location.pathname}#s=${frag}`;
}

async function refreshShare(): Promise<void> {
  try {
    state.share = await shareUrl();
  } catch {
    state.share = '';
  }
  const link = document.getElementById('issue-link') as HTMLAnchorElement | null;
  if (link) link.href = issueUrl();
}

// ---------------------------------------------------------------- compare tab

function compareRows(base: SolverConfig): CompareRow[] {
  const engines = Object.keys(ENGINES) as EngineName[];
  const rows: CompareRow[] = [];
  if (isCatalogMode(base.mode)) {
    for (const engine of engines) {
      rows.push({ solver: 'Pack', config: { ...base, mode: 'pack', engine } });
      rows.push({ solver: 'Pack + Optimize', config: { ...base, mode: 'optimize', engine } });
      rows.push({ solver: 'TrialPacking, no lookahead', config: { ...base, mode: 'trial', engine, lookahead: false, strategy: 'BestFitDecreasing' } });
    }
  } else {
    for (const engine of engines) {
      for (const strategy of Object.keys(STRATEGIES) as StrategyName[]) rows.push({ solver: 'Packer', config: { ...base, mode: 'packer', engine, strategy } });
    }
    for (const engine of engines) {
      rows.push({ solver: 'Branch & Bound', config: { ...base, mode: 'branchbound', engine, timeoutMs: Math.min(base.timeoutMs, 2000) } });
    }
    rows.push({ solver: 'Parallel', config: { ...base, mode: 'parallel' } });
  }
  return rows;
}

/** Lower is better: more items, then fewer boxes (or lower cost), then fuller boxes. */
function score(r: CompareRow): number[] {
  const st = r.run?.res.stats;
  if (!st) return [Infinity];
  return [-st.fittedItems, hasCosts() ? st.totalCost : st.totalBins, -st.volumeUsedPct];
}

const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (Math.abs(d) > 1e-9) return d;
  }
  return 0;
};

async function runCompare(): Promise<void> {
  if (state.comparing) return;
  clearTimeout(debounce);
  if (inFlight) solver.cancel();
  inFlight = false;
  runToken++;
  state.comparing = true;
  state.compare = compareRows(state.config);
  state.sort = { key: 'rank', dir: 1 };
  const scenario = structuredClone(state.scenario);
  renderCompare();
  for (let i = 0; i < state.compare.length; i++) {
    const row = state.compare[i];
    setBusy(true, `Comparing ${i + 1} of ${state.compare.length}…`);
    const req: SolveRequest = { ...row.config, ...scenario };
    try {
      const res = await solver.solve(req);
      if (!state.comparing) return;
      if (res.ok) row.run = { req, res, checks: verify(req, res) };
      else row.error = res.error;
    } catch (err) {
      if (err instanceof Cancelled) return;
      row.error = err instanceof Error ? err.message : String(err);
    }
    renderCompare();
  }
  state.comparing = false;
  setBusy(false);
  renderCompare();
}

function renderCompare(): void {
  const el = $('tab-compare');
  const rows = state.compare;
  const catalog = isCatalogMode(state.config.mode);
  const costs = hasCosts();
  const intro = html`<p class="intro">${
    catalog
      ? 'Runs Pack, Pack + Optimize and TrialPacking without lookahead with each of the five placement engines on this scenario.'
      : 'Runs the Packer with every engine and strategy, Branch & Bound with every engine (2 s limit each) and Parallel on this scenario.'
  } Minimum support and the time limit come from the solver settings. Click a row to see it in 3D.</p>`;
  const button = state.comparing
    ? html`<button type="button" class="ghost" data-stop-compare>Stop</button>`
    : html`<button type="button" class="primary" data-run-compare>${rows.length ? 'Run again' : 'Run comparison'}</button>`;
  if (!rows.length) return mount(el, html`${intro}<div class="toolbar">${button}</div>`);

  const done = rows.filter((r) => r.run);
  const best = done.length ? done.map(score).reduce((a, b) => (cmp(a, b) <= 0 ? a : b)) : null;
  const ranked = [...rows].sort((a, b) => cmp(score(a), score(b)));
  const key = state.sort.key;
  const val = (r: CompareRow): number | string => {
    const st = r.run?.res.stats;
    switch (key) {
      case 'rank':
        return ranked.indexOf(r);
      case 'solver':
        return r.solver;
      case 'engine':
        return r.config.mode === 'parallel' ? '' : ENGINES[r.config.engine].label;
      case 'strategy':
        return r.config.mode === 'packer' ? r.config.strategy : '';
      case 'fitted':
        return -(st?.fittedItems ?? -1);
      case 'boxes':
        return st?.totalBins ?? Infinity;
      case 'fill':
        return -(st?.volumeUsedPct ?? -1);
      case 'cost':
        return st?.totalCost ?? Infinity;
      case 'time':
        return r.run?.res.elapsedMs ?? Infinity;
    }
  };
  const sorted = [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * state.sort.dir;
  });
  const th = (k: SortKey, label: string, num = false) =>
    html`<th class="${num ? 'num' : ''}" aria-sort="${key === k ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${k}">${label}${key === k ? (state.sort.dir > 0 ? ' ↓' : ' ↑') : ''}</button></th>`;

  mount(
    el,
    html`${intro}<div class="toolbar">${button}<span class="muted">${done.length} of ${rows.length} done</span></div>
      <div class="table-wrap"><table class="list">
        <thead><tr>${th('rank', 'Rank')}${th('solver', 'Solver')}${th('engine', 'Engine')}${catalog ? '' : th('strategy', 'Strategy')}${th('fitted', 'Items', true)}${th('boxes', 'Boxes', true)}${th('fill', 'Avg fill', true)}${costs ? th('cost', 'Cost', true) : ''}${th('time', 'Time', true)}<th>Checks</th></tr></thead>
        <tbody>${sorted.map((r) => {
          const st = r.run?.res.stats;
          const s = r.run ? summarize(r.run.checks) : null;
          const isBest = best && r.run && cmp(score(r), best) === 0;
          const current = r.run && state.run === r.run;
          return html`<tr data-row="${rows.indexOf(r)}" class="${current ? 'current' : ''}">
            <td>${r.run ? ranked.indexOf(r) + 1 : ''} ${isBest ? html`<span class="tag">best</span>` : ''}</td>
            <td>${r.solver}</td>
            <td>${r.config.mode === 'parallel' ? html`<span class="muted">5 combinations</span>` : ENGINES[r.config.engine].label}</td>
            ${catalog ? '' : html`<td class="muted">${r.config.mode === 'packer' ? r.config.strategy : ''}</td>`}
            ${
              r.error
                ? html`<td colspan="${costs ? 5 : 4}" class="muted">${r.error}</td>`
                : st
                  ? html`<td class="num">${st.fittedItems}/${st.totalItems}</td><td class="num">${st.totalBins}</td><td class="num">${n1(st.volumeUsedPct)}%</td>${costs ? html`<td class="num">${n2(st.totalCost)}</td>` : ''}<td class="num">${time(r.run!.res.elapsedMs)}${r.run!.res.timedOut ? html` <span class="status warn" title="Time limit hit"><span class="dot"></span></span>` : ''}</td>`
                  : html`<td colspan="${costs ? 5 : 4}" class="muted">waiting…</td>`
            }
            <td>${s ? html`<span class="status ${s.failed ? 'bad' : 'good'}"><span class="dot"></span>${s.failed ? `${s.failed} failed` : 'pass'}</span>` : ''}</td>
          </tr>`;
        })}</tbody>
      </table></div>`,
  );
}

// ---------------------------------------------------------------- code tab

function renderCode(): void {
  const code = generateGo({ ...state.config, ...state.scenario });
  mount(
    $('tab-code'),
    html`<p class="intro">The same scenario and settings as a Go program. Install the library with <code class="inline">go get github.com/jcoruiz/gopackx${state.info?.library && state.info.library !== 'unknown' ? '@' + state.info.library : ''}</code>, save this as <code class="inline">main.go</code> and <code class="inline">go run .</code></p>
      <div class="toolbar"><button type="button" class="primary small" data-copy-code>Copy</button><button type="button" class="ghost small" data-download-code>Download main.go</button></div>
      <pre class="code"><code>${raw(highlightGo(code))}</code></pre>`,
  );
}

function download(name: string, text: string, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- wiring

function selectTab(name: string): void {
  document.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll<HTMLElement>('.tab-panel').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
}

function selectBin(i: number): void {
  const bins = state.run?.res.bins ?? [];
  state.bin = Math.max(0, Math.min(bins.length - 1, i));
  renderRun(false);
}

function wire(): void {
  $('preset').addEventListener('change', (e) => {
    const key = (e.target as HTMLSelectElement).value;
    if (key) {
      history.replaceState(null, '', `#p=${key}`);
      loadPreset(key);
    }
  });
  for (const kind of ['bins', 'items'] as const) {
    const el = $(`${kind}-table`);
    el.addEventListener('change', (e) => onTableInput(kind, e));
    el.addEventListener('click', (e) => onTableClick(kind, e));
  }
  $('add-bin').addEventListener('click', () => addRow('bins'));
  $('add-item').addEventListener('click', () => addRow('items'));

  $('btn-generate').addEventListener('click', (e) => {
    const form = $('generate-form');
    form.hidden = !form.hidden;
    (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!form.hidden));
  });
  $('generate-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    const opt = (k: string, def: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(f.get(k)) || def)));
    const scenario = randomScenario({ items: opt('items', 300, 1, 5000), skus: opt('skus', 8, 1, 300), seed: opt('seed', 42, 0, 2 ** 31) });
    history.replaceState(null, '', location.pathname);
    loadSnapshot({ scenario, config: state.config }, '');
  });

  $('btn-export').addEventListener('click', () =>
    download('gopackx-scenario.json', JSON.stringify({ scenario: state.scenario, config: state.config }, null, 2), 'application/json'),
  );
  $('btn-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      loadSnapshot(sanitize(JSON.parse(await file.text())), '');
      toast(`Imported ${file.name}`);
    } catch {
      toast('That file is not a scenario exported from here.');
    }
  });
  $('btn-share').addEventListener('click', async () => {
    const url = await shareUrl();
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied to the clipboard');
    } catch {
      toast('Link is in the address bar');
    }
  });

  $('btn-run').addEventListener('click', () => void run());
  $('btn-stop').addEventListener('click', stop);
  $('auto-run').addEventListener('change', (e) => (e.target as HTMLInputElement).checked && scheduleRun());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void run();
    }
  });

  $('bin-select').addEventListener('change', (e) => selectBin(Number((e.target as HTMLSelectElement).value)));
  $('bin-prev').addEventListener('click', () => selectBin(state.bin - 1));
  $('bin-next').addEventListener('click', () => selectBin(state.bin + 1));
  $('color-mode').addEventListener('change', (e) => {
    state.colorMode = (e.target as HTMLSelectElement).value as ColorMode;
    viewer.recolor(coloring(state.colorMode, state.run?.req.items ?? [], currentBin()).color);
    renderLegend();
  });
  $('btn-fit').addEventListener('click', () => viewer.fit());
  $('btn-play').addEventListener('click', play);
  $('step').addEventListener('input', (e) => {
    cancelAnimationFrame(playing);
    const v = Number((e.target as HTMLInputElement).value);
    viewer.setVisible(v);
    stepLabel(v, currentBin()?.items.length ?? 0);
  });

  document.querySelector('.tabs')!.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab;
    if (tab) selectTab(tab);
  });
  $('tab-result').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-goto]')) return selectTab('checks');
    const row = t.closest<HTMLElement>('[data-bin]');
    if (row) selectBin(Number(row.dataset.bin));
  });
  $('tab-compare').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-run-compare]')) return void runCompare();
    if (t.closest('[data-stop-compare]')) return stop();
    const sort = t.closest<HTMLElement>('[data-sort]')?.dataset.sort as SortKey | undefined;
    if (sort) {
      state.sort = { key: sort, dir: state.sort.key === sort ? -state.sort.dir : 1 };
      return renderCompare();
    }
    const row = state.compare[Number(t.closest<HTMLElement>('[data-row]')?.dataset.row)];
    if (row?.run) {
      state.config = { ...row.config };
      renderSolverBar();
      renderCode();
      setRun(row.run);
      renderCompare();
    }
  });
  $('tab-code').addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const code = generateGo({ ...state.config, ...state.scenario });
    if (t.closest('[data-copy-code]')) {
      await navigator.clipboard.writeText(code);
      toast('Copied');
    } else if (t.closest('[data-download-code]')) download('main.go', code, 'text/x-go');
  });
}

async function boot(): Promise<void> {
  setupSolverBar();
  wire();

  solver.ready.then(
    (info) => {
      state.info = info;
      mount(
        $('footer'),
        html`<span>gopackx ${info.library} · ${info.goVersion} compiled to WebAssembly</span>
          <a href="https://github.com/jcoruiz/gopackx-playground" target="_blank" rel="noopener">Playground source</a>
          <a href="https://github.com/jcoruiz/gopackx/issues" target="_blank" rel="noopener">Report an issue</a>
          <span>MIT licensed</span>`,
      );
      renderCode();
    },
    (err: Error) => banner(`The solver could not start in this browser: ${err.message}. WebAssembly and Web Workers are required.`),
  );

  const hash = new URLSearchParams(location.hash.slice(1));
  const shared = hash.get('s');
  if (shared) {
    try {
      return loadSnapshot(await decode(shared), '');
    } catch {
      banner('That shared link is damaged or incomplete, so the default example is shown instead.');
    }
  }
  loadPreset(hash.get('p') ?? 'office');
}

void boot();
