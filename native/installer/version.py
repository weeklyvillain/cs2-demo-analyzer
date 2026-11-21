"""The app version, kept in native/Cargo.toml ([workspace.package] version).

    python native/installer/version.py get           # prints 2.0.0
    python native/installer/version.py bump          # next free patch version: 2.0.1
    python native/installer/version.py bump --apply  # also writes it to Cargo.toml and Cargo.lock

`bump` skips any version whose `v<version>` tag already exists, so a tag left by a failed
release can't block later ones. Cargo.lock holds the workspace crates' versions too; it is
updated alongside so `cargo build --locked` keeps working.
"""

import re
import subprocess
import sys
from pathlib import Path

NATIVE = Path(__file__).resolve().parent.parent
TOML = NATIVE / "Cargo.toml"
LOCK = NATIVE / "Cargo.lock"
WORKSPACE_CRATES = ("cs2da", "cs2da-core")
VERSION_RE = re.compile(r'(\[workspace\.package\][^\[]*?\nversion\s*=\s*")([^"]+)(")')


def read(path: Path) -> str:
    # newline="" keeps CRLF/LF as checked out, so a bump changes only the version lines.
    with open(path, encoding="utf8", newline="") as f:
        return f.read()


def get() -> str:
    m = VERSION_RE.search(read(TOML))
    if not m:
        sys.exit("no [workspace.package] version in native/Cargo.toml")
    return m.group(2)


def tag_exists(version: str) -> bool:
    r = subprocess.run(["git", "rev-parse", "-q", "--verify", f"refs/tags/v{version}"],
                       capture_output=True, cwd=NATIVE)
    return r.returncode == 0


def next_patch(version: str) -> str:
    major, minor, patch = (int(p) for p in version.split("."))
    while True:
        patch += 1
        candidate = f"{major}.{minor}.{patch}"
        if not tag_exists(candidate):
            return candidate


def apply(old: str, new: str) -> None:
    text = read(TOML)
    TOML.write_text(VERSION_RE.sub(lambda m: m.group(1) + new + m.group(3), text, count=1),
                    encoding="utf8", newline="")
    lock = read(LOCK)
    for crate in WORKSPACE_CRATES:
        # CRLF on Windows checkouts (core.autocrlf), LF elsewhere.
        pattern = re.compile(rf'(name = "{re.escape(crate)}"\r?\nversion = "){re.escape(old)}(")')
        lock, n = pattern.subn(lambda m: m.group(1) + new + m.group(2), lock, count=1)
        if n != 1:
            sys.exit(f"Cargo.lock has no {crate} {old}")
    LOCK.write_text(lock, encoding="utf8", newline="")


def main() -> None:
    args = sys.argv[1:]
    if args[:1] == ["get"]:
        print(get())
    elif args[:1] == ["bump"]:
        old = get()
        new = next_patch(old)
        if "--apply" in args:
            apply(old, new)
        print(new)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
