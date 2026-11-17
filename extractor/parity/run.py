#!/usr/bin/env python3
"""Run the legacy Go parser and the Rust extractor on demos and compare them.

Usage: run.py --legacy <go parser binary> --new <rust parser binary> <demo>...

For every demo both parsers write a database into a temporary directory
(legacy output is cached next to it, keyed by demo name), then compare.py
checks them table by table. The Rust extractor is run with
--legacy-shot-attribution so shots can be compared row for row; see
on_weapon_fire in src/extract.rs for why the default differs.
"""
import argparse
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def run(binary, demo, out, extra=()):
    if os.path.exists(out):
        os.remove(out)
    start = time.perf_counter()
    proc = subprocess.run(
        [binary, "--demo", demo, "--out", out, "--match-id", "parity", *extra],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    elapsed = time.perf_counter() - start
    if proc.returncode != 0:
        tail = proc.stdout.decode("utf-8", "replace").strip().splitlines()[-1:]
        print(f"  {os.path.basename(binary)} failed ({proc.returncode}): {tail}")
        return None
    return elapsed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--legacy", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--workdir", default=os.path.join(tempfile.gettempdir(), "cs2-extractor-parity"))
    ap.add_argument("--quiet", action="store_true", help="only print the verdict per demo")
    ap.add_argument("demos", nargs="+")
    args = ap.parse_args()
    args.legacy = os.path.abspath(args.legacy)
    args.new = os.path.abspath(args.new)
    os.makedirs(args.workdir, exist_ok=True)

    failed = []
    total_old = total_new = 0.0
    for demo in args.demos:
        name = os.path.splitext(os.path.basename(demo))[0]
        old_db = os.path.join(args.workdir, name + ".legacy.db")
        new_db = os.path.join(args.workdir, name + ".new.db")
        timing = old_db + ".time"
        if os.path.exists(old_db) and os.path.exists(timing):
            t_old = float(open(timing).read())
        else:
            t_old = run(args.legacy, demo, old_db)
            if t_old is None:
                failed.append(name)
                continue
            open(timing, "w").write(str(t_old))
        t_new = run(args.new, demo, new_db, ["--legacy-shot-attribution"])
        if t_new is None:
            failed.append(name)
            continue
        total_old += t_old
        total_new += t_new
        cmp = subprocess.run(
            [sys.executable, os.path.join(HERE, "compare.py"), old_db, new_db],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        text = cmp.stdout.decode("utf-8", "replace")
        verdict = "PARITY OK" if cmp.returncode == 0 else "PARITY FAILED"
        size = os.path.getsize(demo) / 1e6
        print(f"{name}: {verdict}  ({size:.0f} MB, legacy {t_old:.2f}s, new {t_new:.2f}s, {t_old / t_new:.1f}x)")
        if cmp.returncode != 0:
            failed.append(name)
        if not args.quiet or cmp.returncode != 0:
            print("  " + text.rstrip().replace("\n", "\n  "))
    if total_new:
        print(f"\ntotal: legacy {total_old:.1f}s, new {total_new:.1f}s, {total_old / total_new:.1f}x faster")
    if failed:
        print("failed:", ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
