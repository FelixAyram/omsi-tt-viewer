#!/usr/bin/env python3
"""Copia un subset de OMSI 2 (Test_Lat30) para pruebas Selenium en el navegador."""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "docs" / "e2e" / "fixture"
MANIFEST = ROOT / "docs" / "e2e" / "manifest.json"

OMSI_DEFAULT = Path(r"F:\SteamLibrary\steamapps\common\OMSI 2")
MAP_NAME = "Test_Lat30"
MAP_DIR = f"maps/{MAP_NAME}"

SLI_RE = re.compile(r"Splines[^\r\n]*\.sli", re.I)
SCO_RE = re.compile(r"Sceneryobjects[^\r\n]*\.sco|[^\r\n]*bus_stop[^\r\n]*\.sco", re.I)
TILE_RE = re.compile(r"^tile_-?\d+_-?\d+\.map$", re.I)


def omsi_root() -> Path | None:
    env = Path(os.environ["OMSI_ROOT"]) if "OMSI_ROOT" in os.environ else None
    candidates = [env, OMSI_DEFAULT, Path.home() / "SteamLibrary/steamapps/common/OMSI 2"]
    for p in candidates:
        if p and (p / "maps" / MAP_NAME / "global.cfg").is_file():
            return p
    return None


def norm_rel(path: Path, base: Path) -> str:
    return path.relative_to(base).as_posix()


def copy_file(src: Path, dest: Path, copied: set[str]) -> None:
    if not src.is_file():
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        shutil.copy2(src, dest)
    copied.add(dest.relative_to(FIXTURE).as_posix())


def read_omsi_text(path: Path) -> str:
    raw = path.read_bytes()
    if len(raw) >= 2 and raw[0] == 0xFF and raw[1] == 0xFE:
        return raw.decode("utf-16-le")
    if len(raw) >= 2 and raw[0] == 0xFE and raw[1] == 0xFF:
        return raw.decode("utf-16-be")
    return raw.decode("utf-8", errors="replace")


def collect_asset_refs(tile_text: str) -> tuple[set[str], set[str]]:
    slis, scos = set(), set()
    for m in SLI_RE.finditer(tile_text):
        slis.add(m.group(0).replace("\\", "/"))
    for m in SCO_RE.finditer(tile_text):
        scos.add(m.group(0).replace("\\", "/"))
    return slis, scos


def main() -> int:
    omsi = omsi_root()
    if not omsi:
        print("SKIP: no se encontró OMSI 2 con maps/Test_Lat30 (define OMSI_ROOT)", file=sys.stderr)
        return 0

    map_src = omsi / "maps" / MAP_NAME
    if FIXTURE.exists():
        shutil.rmtree(FIXTURE)
    FIXTURE.mkdir(parents=True)

    copied: set[str] = set()
    slis: set[str] = set()
    scos: set[str] = set()

    copy_file(map_src / "global.cfg", FIXTURE / MAP_DIR / "global.cfg", copied)

    for f in sorted(map_src.iterdir()):
        if f.is_file() and TILE_RE.match(f.name):
            copy_file(f, FIXTURE / MAP_DIR / f.name, copied)
            text = read_omsi_text(f)
            s, c = collect_asset_refs(text)
            slis |= s
            scos |= c

    ttdata = map_src / "TTData"
    if ttdata.is_dir():
        for f in ttdata.rglob("*"):
            if f.is_file():
                rel = norm_rel(f, map_src)
                copy_file(f, FIXTURE / MAP_DIR / rel, copied)

    for rel in sorted(slis | scos):
        rel = rel.replace("\\", "/")
        src = omsi / rel
        if not src.is_file():
            for alt in (omsi / rel.replace("Splines/", "splines/"), omsi / rel.replace("Sceneryobjects/", "sceneryobjects/")):
                if alt.is_file():
                    src = alt
                    break
        if src.is_file():
            copy_file(src, FIXTURE / rel, copied)

    manifest = {
        "mapDir": MAP_DIR,
        "omsiLabel": "E2E OMSI 2",
        "files": sorted(copied),
        "source": str(omsi),
    }
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"OK fixture: {len(copied)} archivos -> {FIXTURE}")
    print(f"   tiles: {sum(1 for f in copied if TILE_RE.search(Path(f).name))}")
    print(f"   global.cfg: {'maps/Test_Lat30/global.cfg' in copied}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
