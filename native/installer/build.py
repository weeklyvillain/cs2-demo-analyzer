"""Build the Windows installer and the updater feed for it.

    python native/installer/build.py [--exe PATH] [--out DIR] [--makensis PATH]

1. Stages the release build as `CS2 Demo Analyzer.exe` with `resources/` and `bin/win/`.
2. Runs makensis on installer.nsi → `CS2-Demo-Analyzer-Setup-<version>.exe`.
3. Writes `latest.yml` in electron-builder's format, which both the Electron updater
   (users still on 1.0.x) and the native app read from the GitHub release.

The version comes from `native/Cargo.toml` ([workspace.package] version).
"""

import argparse
import base64
import datetime
import hashlib
import re
import shutil
import subprocess
import sys
from pathlib import Path

NATIVE = Path(__file__).resolve().parent.parent
REPO = NATIVE.parent

# Bundled files the native app uses. installer.nsh was the Electron NSIS include; parser.exe
# is linked in now; output.json is a stray dev file.
SKIP_RESOURCES = {"installer.nsh", ".gitkeep"}
BIN_FILES = ["cs2-voice-extractor.exe", "audiowaveform.exe"]


def workspace_version() -> str:
    text = (NATIVE / "Cargo.toml").read_text(encoding="utf8")
    m = re.search(r'\[workspace\.package\][^\[]*?\nversion\s*=\s*"([^"]+)"', text)
    if not m:
        sys.exit("no [workspace.package] version in native/Cargo.toml")
    return m.group(1)


def find_makensis(given: str | None) -> str:
    if given:
        return given
    found = shutil.which("makensis")
    if found:
        return found
    for base in (r"C:\Program Files (x86)\NSIS", r"C:\Program Files\NSIS"):
        p = Path(base) / "makensis.exe"
        if p.exists():
            return str(p)
    sys.exit("makensis not found (install NSIS or pass --makensis)")


def stage(exe: Path, dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    shutil.copy2(exe, dest / "CS2 Demo Analyzer.exe")
    res = dest / "resources"
    res.mkdir()
    for item in (REPO / "resources").iterdir():
        if item.name in SKIP_RESOURCES:
            continue
        if item.is_dir():
            shutil.copytree(item, res / item.name)
        else:
            shutil.copy2(item, res / item.name)
    binw = dest / "bin" / "win"
    binw.mkdir(parents=True)
    for name in BIN_FILES:
        shutil.copy2(REPO / "bin" / "win" / name, binw / name)


def latest_yml(setup: Path, version: str) -> str:
    data = setup.read_bytes()
    sha = base64.b64encode(hashlib.sha512(data).digest()).decode()
    # The GitHub asset name: spaces become dashes on upload, so the file has none.
    name = setup.name
    date = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    return (
        f"version: {version}\n"
        f"files:\n"
        f"  - url: {name}\n"
        f"    sha512: {sha}\n"
        f"    size: {len(data)}\n"
        f"path: {name}\n"
        f"sha512: {sha}\n"
        f"releaseDate: '{date}'\n"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", type=Path, default=NATIVE / "target" / "release" / "cs2-demo-analyzer.exe")
    ap.add_argument("--out", type=Path, default=NATIVE / "target" / "installer")
    ap.add_argument("--makensis")
    args = ap.parse_args()

    if not args.exe.exists():
        sys.exit(f"{args.exe} not found; run `cargo build --release` in native/ first")
    version = workspace_version()
    out = args.out.resolve()
    staged = out / "stage"
    stage(args.exe, staged)

    setup = out / f"CS2-Demo-Analyzer-Setup-{version}.exe"
    cmd = [
        find_makensis(args.makensis),
        "/V2",
        f"/DVERSION={version}",
        f"/DSTAGE={staged}",
        f"/DOUTFILE={setup}",
        str(Path(__file__).parent / "installer.nsi"),
    ]
    subprocess.run(cmd, check=True)
    (out / "latest.yml").write_text(latest_yml(setup, version), encoding="utf8", newline="\n")
    print(f"{setup} ({setup.stat().st_size / 1e6:.1f} MB)")
    print(out / "latest.yml")


if __name__ == "__main__":
    main()
