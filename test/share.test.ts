import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/presets';
import { decode, encode, sanitize } from '../src/share';
import { DEFAULT_CONFIG } from '../src/types';
import { LATEST, RELEASES, atLeast } from '../src/versions';

describe('versions', () => {
  it('lists the newest release first', () => {
    for (const r of RELEASES.slice(1)) expect(atLeast(LATEST, r.version)).toBe(true);
    expect(atLeast('v0.2.2', 'v0.3.0')).toBe(false);
    expect(atLeast('v0.10.0', 'v0.9.1')).toBe(true);
    expect(atLeast('v0.3.0', 'v0.3.0')).toBe(true);
  });
});

describe('shared links', () => {
  const office = PRESETS[0];
  const snap = { scenario: office.scenario, config: { ...DEFAULT_CONFIG, ...office.config } };

  it('keep the version they were made with', async () => {
    for (const { version } of RELEASES) {
      expect((await decode(await encode({ ...snap, version }))).version).toBe(version);
    }
  });

  it('open links made before the version selector on the release they ran', () => {
    expect(sanitize(snap).version).toBe('v0.2.2');
  });

  it('fall back to the latest release for an unknown version', () => {
    expect(sanitize({ ...snap, version: 'v9.9.9' }).version).toBe(LATEST);
    expect(sanitize({ ...snap, version: 42 }).version).toBe(LATEST);
  });
});
