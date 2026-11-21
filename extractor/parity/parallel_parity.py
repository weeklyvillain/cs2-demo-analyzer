"""Parallel-vs-sequential parity: parse each demo with `--threads 1` (the original
sequential decoder) and with the default parallel decoder, then compare every table
row for row (order-independent). `meta` timestamps differ by design and are ignored.

    python -I parity/parallel_parity.py <parser.exe> <workdir> <demo.dem> [<demo.dem> ...]

Exit status 1 if any demo differs.
"""
import hashlib
import os
import sqlite3
import subprocess
import sys
import time

IGNORED_META = {"created_at_iso", "parsed_at"}


def parse(parser, demo, out, threads):
    if os.path.exists(out):
        os.remove(out)
    args = [parser, "--demo", demo, "--out", out, "--match-id", "parity", "--position-interval", "4"]
    if threads is not None:
        args += ["--threads", str(threads)]
    t = time.perf_counter()
    subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    return time.perf_counter() - t


def table_digests(path):
    con = sqlite3.connect(path)
    out = {}
    for (table,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        if table == "parser_logs":
            continue
        rows = con.execute(f'SELECT * FROM "{table}"').fetchall()
        if table == "meta":
            rows = [r for r in rows if r[0] not in IGNORED_META]
        # Order-independent: hash each row, sort the hashes.
        h = hashlib.sha256()
        for d in sorted(hashlib.sha256(repr(r).encode()).digest() for r in rows):
            h.update(d)
        out[table] = (len(rows), h.hexdigest()[:16])
    con.close()
    return out


def main():
    parser, workdir, *demos = sys.argv[1:]
    os.makedirs(workdir, exist_ok=True)
    seq_db, par_db = os.path.join(workdir, "seq.sqlite"), os.path.join(workdir, "par.sqlite")
    failures = 0
    total_seq = total_par = 0.0
    for demo in demos:
        t_seq = parse(parser, demo, seq_db, 1)
        t_par = parse(parser, demo, par_db, None)
        total_seq += t_seq
        total_par += t_par
        a, b = table_digests(seq_db), table_digests(par_db)
        diff = [t for t in sorted(set(a) | set(b)) if a.get(t) != b.get(t)]
        rows = sum(n for n, _ in a.values())
        status = "IDENTICAL" if not diff else "DIFF " + ", ".join(f"{t} {a.get(t)} vs {b.get(t)}" for t in diff)
        print(f"{os.path.basename(demo):28} {os.path.getsize(demo) / 1048576:7.1f} MB  {rows:>8} rows  "
              f"seq {t_seq:5.2f}s  par {t_par:5.2f}s  {status}", flush=True)
        failures += bool(diff)
    print(f"{len(demos)} demos, {failures} with differences; total seq {total_seq:.1f}s, par {total_par:.1f}s")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
