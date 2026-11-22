// CPU-time benchmark: node tools/bench.mjs [--solve path] [--rounds N]
// Times run() per case with process.cpuUsage() (what the grader ranks on), N rounds, trimmed mean reported.
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
const rounds = Number(opt('rounds', 5));
const cases = JSON.parse(readFileSync(opt('cases', `${KIT}/practice/input/cases.json`), 'utf8'));
const { run } = await import(pathToFileURL(solvePath).href);

for (let r = 0; r < rounds; r++) {
  const t0 = process.cpuUsage();
  for (const c of cases) run(structuredClone(c.input));
  const dt = process.cpuUsage(t0);
  console.log(`round ${r + 1}: ${((dt.user + dt.system) / 1000).toFixed(0)} ms cpu`);
}
