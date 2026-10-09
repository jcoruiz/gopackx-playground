// The GoPackX releases the playground ships, newest first. versions.json is
// also read by scripts/build-wasm.sh, which builds one WASM per release.
import list from '../versions.json';

export interface Release {
  version: string;
  released: string;
}

export const RELEASES: readonly Release[] = list.versions;
export const LATEST = RELEASES[0].version;
export const CHANGELOG = 'https://github.com/jcoruiz/gopackx/blob/main/CHANGELOG.md';

export const isRelease = (v: unknown): v is string => RELEASES.some((r) => r.version === v);

const parts = (v: string) => v.replace(/^v/, '').split('.').map(Number);

/** Whether version a is b or newer. */
export function atLeast(a: string, b: string): boolean {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return true;
}

/** Behavior that changed between releases, for the hints next to the inputs and results. */
export function rules(version: string) {
  const v030 = atLeast(version, 'v0.3.0');
  return {
    /** A Max kg of 0 means no limit. Before v0.3.0 the box could hold nothing. */
    zeroWeightIsUnlimited: v030,
    /** Load limits count the whole stack and apply without minimum support. Before v0.3.0, only the items touching an item counted, and only with minimum support on. */
    fullStackLoad: v030,
  };
}
