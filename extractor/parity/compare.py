#!/usr/bin/env python3
"""Parity check between two match databases (legacy Go parser vs Rust extractor).

Usage: compare.py <legacy.db> <new.db>

Every table is compared row for row. The only things treated as equivalent
rather than identical are the ones the Go parser itself did not produce
deterministically:

* row order (Go iterated maps in random order)
* projectile / inferno ids (random numbers in Go, counters in Rust) - compared
  through a one-to-one mapping that has to hold for every row
* list order inside event metadata that came from Go map iteration
* inferno polygons - equal if their outlines are within 0.01 game units of
  each other (the Go hull library works with an epsilon and drops vertices
  that are almost on a straight edge)
* created_at / parsed_at timestamps

Exit code 0 means parity, 1 means differences were found.
"""
import json
import math
import sqlite3
import sys
from collections import Counter

TOL = 1e-6
failures = []


def fail(table, msg):
    failures.append(table)
    print(f"  DIFF [{table}] {msg}")


def rows(db, sql):
    return db.execute(sql).fetchall()


def norm(v):
    if isinstance(v, float):
        return round(v, 5)
    return v


def norm_json(v, key=None):
    """Canonical form of metadata: floats rounded, unordered lists sorted."""
    if isinstance(v, dict):
        out = {k: norm_json(x, k) for k, x in v.items()}
        if "primary_weapon" in out and "all_weapons" in out:
            # the "primary" pick depended on Go map order when several qualify
            pass
        return out
    if isinstance(v, list):
        items = [norm_json(x) for x in v]
        if key in ("weapon", "all_weapons", "weapons", "weapon_details", "other_players"):
            items = sorted(items, key=lambda x: json.dumps(x, sort_keys=True))
        return items
    if isinstance(v, float):
        return round(v, 5)
    return v


def multiset(table, a, b, show=5):
    ca, cb = Counter(a), Counter(b)
    if ca == cb:
        return True
    only_a = list((ca - cb).elements())
    only_b = list((cb - ca).elements())
    fail(table, f"{len(only_a)} rows only in legacy, {len(only_b)} only in new (of {len(a)}/{len(b)})")
    for r in sorted(only_a, key=repr)[:show]:
        print(f"      legacy: {r}")
    for r in sorted(only_b, key=repr)[:show]:
        print(f"      new:    {r}")
    return False


def seg_dist(p, a, b):
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def outline_dist(points, poly):
    """Largest distance from any of `points` to the outline of `poly`."""
    if len(poly) == 1:
        return max(math.hypot(p[0] - poly[0][0], p[1] - poly[0][1]) for p in points)
    edges = list(zip(poly, poly[1:] + poly[:1]))
    return max(min(seg_dist(p, a, b) for a, b in edges) for p in points)


def same_outline(pa, pb, tol=0.01):
    if not pa or not pb:
        return pa == pb
    return outline_dist(pa, pb) <= tol and outline_dist(pb, pa) <= tol


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    A = sqlite3.connect(sys.argv[1])
    B = sqlite3.connect(sys.argv[2])

    def both(sql):
        return rows(A, sql), rows(B, sql)

    # --- simple tables ---------------------------------------------------
    for table, sql in [
        ("matches", "select id, map, tick_rate, started_at, source from matches"),
        ("meta", "select key, value from meta where key not in ('created_at_iso', 'parsed_at')"),
        ("players", "select steamid, name, team, color, connected_midgame, permanent_disconnect, first_connect_round, disconnect_round from players"),
        ("rounds", "select round_index, start_tick, freeze_end_tick, end_tick, t_wins, ct_wins, winner from rounds"),
        ("chat_messages", "select round_index, tick, steamid, name, team, message, is_team_chat from chat_messages"),
        ("shots", "select round_index, tick, steamid, weapon_name, x, y, z, yaw, pitch, team from shots"),
        ("player_scores", "select steamid, team_kills, team_damage, team_flash_seconds, afk_seconds, body_block_seconds, economy_grief_count, grief_score from player_scores"),
        ("player_positions", "select round_index, tick, steamid, x, y, z, yaw, view_dir_x, view_dir_y, team, health, armor, weapon from player_positions"),
    ]:
        a, b = both(sql)
        ok = multiset(table, [tuple(map(norm, r)) for r in a], [tuple(map(norm, r)) for r in b])
        print(f"{'ok  ' if ok else 'FAIL'} {table}: {len(a)} / {len(b)} rows")

    # --- events ----------------------------------------------------------
    def ev(db):
        out = []
        for r in rows(db, "select round_index, type, start_tick, end_tick, actor_steamid, victim_steamid, severity, confidence, meta_json from events"):
            meta = json.dumps(norm_json(json.loads(r[8])), sort_keys=True) if r[8] else None
            out.append(tuple(map(norm, r[:8])) + (meta,))
        return out

    a, b = ev(A), ev(B)
    ok = multiset("events", a, b, show=8)
    print(f"{'ok  ' if ok else 'FAIL'} events: {len(a)} / {len(b)} rows")
    for t, n in sorted(Counter(r[1] for r in a).items()):
        nb = sum(1 for r in b if r[1] == t)
        print(f"       {t}: {n} / {nb}")

    # --- projectile ids --------------------------------------------------
    def gp(db):
        return rows(db, "select round_index, tick, projectile_id, grenade_name, x, y, z, thrower_steamid, thrower_name, thrower_team from grenade_positions")

    a, b = gp(A), gp(B)
    id_map = {}
    bad = 0

    def strip(r):
        return tuple(map(norm, r[:2] + r[3:]))

    by_key_b = {}
    for r in b:
        by_key_b.setdefault(strip(r), []).append(r[2])
    for r in a:
        cands = by_key_b.get(strip(r))
        if not cands:
            bad += 1
            continue
        known = id_map.get(r[2])
        if known is None:
            if len(cands) == 1:
                id_map[r[2]] = cands[0]
        elif known not in cands:
            bad += 1
    ok = bad == 0 and len(a) == len(b) and len(set(id_map.values())) == len(id_map)
    if not ok:
        fail("grenade_positions", f"{bad} rows without a consistent counterpart ({len(a)} / {len(b)} rows, {len(id_map)} ids mapped)")
        multiset("grenade_positions(no ids)", [strip(r) for r in a], [strip(r) for r in b])
    print(f"{'ok  ' if ok else 'FAIL'} grenade_positions: {len(a)} / {len(b)} rows, {len(id_map)} projectiles")

    # --- inferno ids + polygons ------------------------------------------
    def inf(db):
        return rows(db, "select tick, entity_id, polygon, thrower_steam_id, thrower_name, thrower_team from inferno_positions order by tick")

    a, b = inf(A), inf(B)
    by_tick_b = {}
    for r in b:
        by_tick_b.setdefault(r[0], []).append(r)
    inf_map = {}
    bad = exact = equivalent = 0
    examples = []
    for r in a:
        pa = json.loads(r[2])
        match = None
        for c in by_tick_b.get(r[0], []):
            if inf_map.get(r[1], c[1]) != c[1] or tuple(r[3:]) != tuple(c[3:]):
                continue
            pb = json.loads(c[2])
            if all(math.isclose(x, y, abs_tol=TOL) for p, q in zip(pa, pb) for x, y in zip(p, q)) and len(pa) == len(pb):
                match = (c, True)
                break
            if same_outline(pa, pb):
                match = (c, False)
                break
        if match is None:
            bad += 1
            if len(examples) < 3:
                examples.append((r, by_tick_b.get(r[0], [])))
            continue
        inf_map[r[1]] = match[0][1]
        if match[1]:
            exact += 1
        else:
            equivalent += 1
    ok = bad == 0 and len(a) == len(b) and len(set(inf_map.values())) == len(inf_map)
    if not ok:
        fail("inferno_positions", f"{bad} rows without counterpart ({len(a)} / {len(b)} rows)")
        for r, cands in examples:
            print(f"      legacy: {r}")
            for c in cands[:2]:
                print(f"      new:    {c}")
    print(f"{'ok  ' if ok else 'FAIL'} inferno_positions: {len(a)} / {len(b)} rows ({exact} identical polygons, {equivalent} same outline within 0.01 units)")

    # --- grenade events (ids translated) ---------------------------------
    def ge(db, translate):
        out = []
        for r in rows(db, "select round_index, tick, event_type, projectile_id, grenade_name, x, y, z, thrower_steamid, thrower_name, thrower_team from grenade_events"):
            pid = r[3]
            if translate:
                if r[2].startswith("inferno"):
                    pid = inf_map.get(pid, ("legacy-inferno", pid))
                elif not r[2].endswith("_expire"):
                    pid = id_map.get(pid, ("unseen", r[2]))
            elif not r[2].startswith("inferno") and not r[2].endswith("_expire") and pid not in id_map.values():
                pid = ("unseen", r[2])
            elif r[2].startswith("inferno") and pid not in inf_map.values():
                pid = ("legacy-inferno", "?")
            out.append(tuple(map(norm, r[:3])) + (pid if not isinstance(pid, tuple) or pid[0] == "unseen" else ("inferno-unsampled",),) + tuple(map(norm, r[4:])))
        return out

    a, b = ge(A, True), ge(B, False)
    ok = multiset("grenade_events", a, b, show=8)
    print(f"{'ok  ' if ok else 'FAIL'} grenade_events: {len(a)} / {len(b)} rows")

    print()
    if failures:
        print("PARITY FAILED:", ", ".join(sorted(set(failures))))
        return 1
    print("PARITY OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
