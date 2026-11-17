# Demo extractor

Parses a CS2 demo and writes the SQLite match database the app reads. It is
started by the Electron main process as `bin/<platform>/parser[.exe]`.

Build it with `npm run build:parser` from the repository root (needs the Rust
toolchain), or directly:

```bash
cargo build --release --manifest-path extractor/Cargo.toml
```

## Command line

```
parser --demo <file.dem> --out <match.sqlite> [--match-id <id>] [--position-interval 4]
parser --demo <file.dem> --mode json --output <events.json> [--steam-ids id1,id2]
```

Progress and log lines are written to stdout as one JSON object per line
(`{"type":"progress",...}`, `{"type":"log",...}`, `{"type":"error",...}`).

## Layout

| File | Purpose |
| --- | --- |
| `src/state.rs` | Game state on top of `source2-demo`: players, projectiles, fires, round start/end, flashes, connects |
| `src/extract.rs` | Turns that state into rows: rounds, players, events, positions, grenades, shots, chat |
| `src/post.rs` | AFK and head-stacking detection over the sampled positions, grief score |
| `src/db.rs` | SQLite schema and the writer thread |
| `src/equipment.rs` | Weapon ids and display names |
| `vendor/source2-demo` | The demo parsing library with one decoder fix, see `vendor/README.md` |

## Where the output format comes from

This replaced a Go parser built on demoinfocs-golang. The database it writes is
meant to be identical to what that parser produced, so several details follow
how demoinfocs derived its events rather than what would be the obvious choice
here: game events are handled before the entity updates of the same packet,
property changes of a new entity are applied once the whole packet is read,
round start and end come from the game rules entity, and so on. Comments in
`src/state.rs` point these out.

Deliberate differences from the Go parser:

* **Shots are attributed to the player who fired.** The Go parser matched the
  `weapon_fire` user id against controller entity ids, which are one higher, so
  every shot went to the player in the neighbouring slot and the shots of the
  player in slot 0 were dropped. `--legacy-shot-attribution` restores the old
  behaviour for comparisons.
* Projectile and fire ids are small counters instead of random 63-bit numbers.
* A failed run removes the database file it created instead of leaving a
  partial one behind.

## Parity check

`parity/run.py` runs a legacy Go parser binary and this extractor on the same
demos and compares the two databases table by table (see the docstring of
`parity/compare.py` for exactly what counts as equal):

```bash
# build the last Go parser from history
git worktree add ../go-parser bdf633e
(cd ../go-parser && go build -o parser-go.exe ./cmd/parser)

python extractor/parity/run.py --quiet \
  --legacy ../go-parser/parser-go.exe \
  --new extractor/target/release/parser.exe \
  path/to/demos/*.dem
```
