#!/usr/bin/env python3
"""Whole-program CPU-time comparison, the way the grader measures: node main.ts in a fresh process,
user+sys CPU, trimmed mean. usage: tools/bench_main.py [--runs 7]"""
import os, resource, statistics, subprocess, sys, tempfile, shutil

KIT = "/root/work/sitegen/site-generator-speed-01-run-20261122-kit"
ENTRIES = {
    "baseline": f"{KIT}/baselines/makefun-site",
    "entry": "/root/work/sitegen/repo",
}
runs = 7
if "--runs" in sys.argv:
    runs = int(sys.argv[sys.argv.index("--runs") + 1])

def one(where, outdir):
    env = dict(os.environ, MAKEFUN_INPUT_DIR=f"{KIT}/practice/input", MAKEFUN_OUTPUT_DIR=outdir)
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    cmd = ([os.environ["BENCH_TASKSET"], "-c", os.environ.get("BENCH_CPU", "5"), "node", "main.ts"]
           if os.environ.get("BENCH_TASKSET") else ["node", "main.ts"])
    p = subprocess.run(cmd, cwd=where, env=env, capture_output=True, text=True)
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    if p.returncode != 0:
        raise SystemExit(f"{where} failed: {p.stderr[-2000:]}")
    cpu = (after.ru_utime - before.ru_utime) + (after.ru_stime - before.ru_stime)
    return cpu

tmp = tempfile.mkdtemp(dir="/root/.hermes/cache/scratch")
samples = {name: [] for name in ENTRIES}
for r in range(runs):
    for name, where in ENTRIES.items():
        outdir = os.path.join(tmp, name)
        os.makedirs(outdir, exist_ok=True)
        samples[name].append(one(where, outdir))
    print(f"round {r+1}: " + "  ".join(f"{n} {samples[n][-1]*1000:.0f}ms" for n in samples), flush=True)
shutil.rmtree(tmp, ignore_errors=True)

print()
for name, xs in samples.items():
    xs = sorted(xs)
    trimmed = xs[1:-1] if len(xs) >= 5 else xs
    print(f"{name}: min {min(xs)*1000:.0f}ms  median {statistics.median(xs)*1000:.0f}ms  trimmed-mean {statistics.fmean(trimmed)*1000:.0f}ms  all {[round(x*1000) for x in xs]}")
