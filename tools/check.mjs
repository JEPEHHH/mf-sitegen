// Local equivalence check: node tools/check.mjs [--solve path] [--cases path] [--expected path] [--quiet]
// Compares solve.js's answer for every practice case with makefun-site's expected answer, as JSON values
// (objects compared key-order-free, like the scorer), and reports the first difference when a case differs.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const KIT = process.env.SG_KIT ?? '/root/work/sitegen/site-generator-speed-01-run-20261122-kit';
const solvePath = resolve(opt('solve', './solve.js'));
const casesPath = opt('cases', `${KIT}/practice/input/cases.json`);
const expectedPath = opt('expected', `${KIT}/practice/reference/expected.json`);
const quiet = args.includes('--quiet');

const { run } = await import(pathToFileURL(solvePath).href);
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
const byId = new Map(expected.cases.map((c) => [c.id, c.output]));

function firstDiff(a, b, path = '') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${path || '<root>'}: ${JSON.stringify(a)?.slice(0, 120)} !== ${JSON.stringify(b)?.slice(0, 120)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}: length ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return `${path}: ${ka.length} keys !== ${kb.length} (${ka.filter((k) => !(k in b)).join(',')} | ${kb.filter((k) => !(k in a)).join(',')})`;
  for (const k of ka) {
    if (!Object.hasOwn(b, k)) return `${path}: missing key ${JSON.stringify(k)}`;
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

let pass = 0;
const times = [];
for (const c of cases) {
  const t0 = process.cpuUsage();
  const got = run(structuredClone(c.input));
  const dt = process.cpuUsage(t0);
  const cpuMs = (dt.user + dt.system) / 1000;
  times.push(cpuMs);
  const want = byId.get(c.id);
  if (want === undefined) {
    console.log(`${c.id}: NO EXPECTED ANSWER`);
    continue;
  }
  const d = firstDiff(got, want);
  const sameBytes = JSON.stringify(got) === JSON.stringify(want);
  if (d === null) {
    pass++;
    if (!quiet) console.log(`${c.id}: identical (${Object.keys(got).length} files, ${cpuMs.toFixed(0)} ms cpu)${sameBytes ? '' : ' [key order differs, values equal]'}`);
  } else console.log(`${c.id}: DIFFERS at ${d}`);
}
const total = times.reduce((a, b) => a + b, 0);
console.log(`\n${pass}/${cases.length} cases identical; cpu ${total.toFixed(0)} ms (${times.map((t) => t.toFixed(0)).join(', ')})`);
process.exit(pass === cases.length ? 0 : 1);
