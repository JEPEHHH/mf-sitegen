// Differential fuzz: draws sites with the competition's own generator and compares solve.js against
// makefun-site 1.0.0's build, value by value. node tools/fuzz.mjs [--seeds N] [--rounds-per-seed 3]
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const KIT = '/root/work/sitegen/site-generator-speed-01-run-20261122-kit';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const seeds = Number(opt('seeds', 6));
const fixed = opt('seed', null);

const { generate } = await import(pathToFileURL(`${KIT}/program/generator/subject/sites.mjs`).href);
const baseline = await import(pathToFileURL(`${KIT}/baselines/makefun-site/solve.js`).href);
const mine = await import(pathToFileURL('/root/work/sitegen/repo/solve.js').href);
const vfi = await import(pathToFileURL('/root/work/sitegen/repo/solve.js').href);

// the generator's stream: xoshiro128** seeded from sha256 (same as generator/rng.ts)
const rotl = (x, k) => (x << k) | (x >>> (32 - k));
class Rng {
  constructor(key) {
    const v = new DataView(key.buffer, key.byteOffset, 16);
    this.a = v.getUint32(0) | 0; this.b = v.getUint32(4) | 0; this.c = v.getUint32(8) | 0; this.d = v.getUint32(12) | 0;
  }
  u32() {
    const a = this.a, b = this.b;
    const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    let c = this.c ^ a, d = this.d ^ b;
    const nb = b ^ c, na = a ^ d;
    c ^= t; d = rotl(d, 11);
    this.a = na; this.b = nb; this.c = c; this.d = d;
    return result;
  }
  int(lo, hi) {
    const span = hi - lo + 1;
    const limit = Math.floor(2 ** 32 / span) * span;
    let x = this.u32();
    while (x >= limit) x = this.u32();
    return lo + (x % span);
  }
  float() { return this.u32() / 2 ** 32; }
  pick(xs) { return xs[this.int(0, xs.length - 1)]; }
  chance(p) { return this.float() < p; }
}
const streamFor = (seed, label, index) => new Rng(createHash('sha256').update(`makefun/speed-home/rng/v1\n${seed}\n${label}\n${index}`).digest());

function diff(a, b, path = '') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    const A = typeof a === 'string' ? a : JSON.stringify(a);
    const B = typeof b === 'string' ? b : JSON.stringify(b);
    if (typeof a === 'string' && typeof b === 'string') {
      let i = 0; while (i < A.length && A[i] === B[i]) i++;
      return `${path}: strings differ at ${i} (len ${A.length} vs ${B.length}): got ${JSON.stringify(A.slice(Math.max(0, i - 40), i + 60))} want ${JSON.stringify(B.slice(Math.max(0, i - 40), i + 60))}`;
    }
    return `${path}: ${A} !== ${B}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}: length ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = diff(a[i], b[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return `${path}: ${ka.length} keys vs ${kb.length} (only got: ${ka.filter((k) => !(k in b)).slice(0, 3)}, only want: ${kb.filter((k) => !(k in a)).slice(0, 3)})`;
  for (const k of ka) { if (!Object.hasOwn(b, k)) return `${path}: unexpected key ${k}`; const d = diff(a[k], b[k], `${path}.${k}`); if (d) return d; }
  return null;
}

let fails = 0, cases = 0;
for (let s = 0; s < seeds; s++) {
  const seed = fixed ?? randomBytes(32).toString('hex');
  for (let i = 0; i < 3; i++) {
    const input = generate(streamFor(seed, 'case', i), i);
    const want = baseline.run(structuredClone(input));
    const got = vfi.run(structuredClone(input));
    cases++;
    const d = diff(got, want);
    if (d) { fails++; console.log(`seed ${seed.slice(0, 12)} case ${i}: DIFFERS at ${d}`); }
  }
  process.stdout.write(`seed ${seed.slice(0, 12)} done (${cases} cases, ${fails} failing)\n`);
}
console.log(`\n${cases - fails}/${cases} cases identical`);
process.exit(fails === 0 ? 0 : 1);
