import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generateGo } from '../src/codegen';
import { PRESETS } from '../src/presets';
import { DEFAULT_CONFIG, ENGINES, MODES, type EngineName, type Mode } from '../src/types';

const hasGo = (() => {
  try {
    execFileSync('go', ['version']);
    return true;
  } catch {
    return false;
  }
})();

// Every mode × engine × stability, plus every preset as configured.
const programs: [string, string][] = [];
for (const mode of Object.keys(MODES) as Mode[]) {
  for (const engine of Object.keys(ENGINES) as EngineName[]) {
    for (const stability of [0, 0.75]) {
      const preset = PRESETS[mode === 'packer' || mode === 'parallel' || mode === 'branchbound' ? 2 : 1];
      programs.push([
        `${mode}_${engine}_${stability}`.replace(/[^a-z0-9_]/gi, '_'),
        generateGo({ ...DEFAULT_CONFIG, mode, engine, stability, strategy: 'Greedy', maxIter: 50, bbFull: true, timeoutMs: 1500, ...preset.scenario }),
      ]);
    }
  }
}
for (const p of PRESETS) programs.push([`preset_${p.key}`, generateGo({ ...DEFAULT_CONFIG, ...p.config, ...p.scenario })]);

describe.skipIf(!hasGo)('generated Go code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gopackx-codegen-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'go.mod'), 'module codegen\n\ngo 1.22\n\nrequire github.com/jcoruiz/gopackx v0.2.2\n');
  for (const [name, src] of programs) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'main.go'), src);
  }

  it('is gofmt-clean', () => {
    expect(execFileSync('gofmt', ['-d', '.'], { cwd: dir }).toString().trim()).toBe('');
  });

  it('compiles and passes go vet', () => {
    execFileSync('go', ['mod', 'tidy'], { cwd: dir, stdio: 'pipe' });
    execFileSync('go', ['vet', './...'], { cwd: dir, stdio: 'pipe' });
  });

  it('runs and packs every item of the office order', () => {
    const office = PRESETS.find((p) => p.key === 'office')!;
    const out = execFileSync('go', ['run', './preset_office'], { cwd: dir }).toString();
    expect(out).toMatch(/^Fitted 17\/17 items in \d+ boxes/);
    expect(out).not.toContain('did not fit');
    expect(office.config.mode).toBe('pack');
  });
});
