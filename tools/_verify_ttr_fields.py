"""Verifica campos TTR contra .sli/.sco reales (Test_Lat30)."""
from __future__ import annotations

import os
import sys


def _default_sdk() -> str:
    env = os.environ.get("OMSI_SDK", "").strip()
    if env and os.path.isdir(env):
        return env
    for path in (
        r"F:\SteamLibrary\steamapps\common\OMSI 2\SDK",
        os.path.expanduser(r"~\SteamLibrary\steamapps\common\OMSI 2\SDK"),
    ):
        if os.path.isdir(path):
            return path
    return path


def _default_omsi() -> str:
    env = os.environ.get("OMSI_ROOT", "").strip()
    if env and os.path.isdir(env):
        return env
    for path in (
        r"F:\SteamLibrary\steamapps\common\OMSI 2",
        os.path.expanduser(r"~\SteamLibrary\steamapps\common\OMSI 2"),
    ):
        if os.path.isdir(path):
            return path
    return path


SDK = _default_sdk()
sys.path.insert(0, SDK)
from movimiento_calle.path_graph import _parse_sco_paths
from movimiento_calle.sli_paths import parse_sli_paths

OMSI = _default_omsi()
FIXTURE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "docs",
    "e2e",
    "fixture",
    "maps",
    "Test_Lat30",
)


def find_spline_sli(spline_id: str) -> tuple[str, str] | None:
    for name in os.listdir(FIXTURE):
        if not name.startswith("tile_") or not name.endswith(".map"):
            continue
        path = os.path.join(FIXTURE, name)
        with open(path, encoding="utf-8", errors="replace") as handle:
            lines = [ln.rstrip("\n\r") for ln in handle]
        idx = 0
        while idx < len(lines):
            tag = lines[idx].strip()
            if tag in ("[spline]", "[spline_h]") and idx + 1 < len(lines) and lines[idx + 1].strip() == "0":
                sid = lines[idx + 3].strip()
                if sid == spline_id:
                    return name, lines[idx + 2].strip()
            idx += 1
    return None


def main() -> None:
    print("=== Entry 0: spline 11, path_idx=1 ===")
    found = find_spline_sli("11")
    if found:
        tile, rel = found
        sli_full = os.path.join(OMSI, rel.replace("/", os.sep))
        print(f"  tile={tile}, sli={rel}")
        paths = parse_sli_paths(sli_full)
        for k in sorted(paths):
            p = paths[k]
            print(f"    .sli path {k} (0-based): typ={p.typ} lateral={p.lateral}")
        p1 = paths.get(1)
        if p1:
            print(f"  TTR path_idx=1 -> .sli path 1, typ={p1.typ}")

    print()
    print("=== Entry 1: object 9, path_idx=2 ===")
    sco = os.path.join(OMSI, r"Sceneryobjects\Felix\NAZCA CRUCE.sco")
    paths = _parse_sco_paths(sco)
    for idx in sorted(paths):
        sp = paths[idx]
        print(f"    .sco path {idx} (1-based en SDK/TTR): typ={sp.typ} len={sp.length:.3f}")
    sp2 = paths.get(2)
    if sp2:
        print(f"  TTR path_idx=2 -> .sco path 2, typ={sp2.typ}, len={sp2.length:.3f}")

    print()
    print("=== Indexacion path_idx ===")
    print("  Splines (.sli): 0-based (primer [path] = 0)")
    print("  Objetos (.sco): 1-based (primer [path] = 1) — igual que SDK y .ttr oficial")
    print("  Visor web parseScoPaths: 0-based internamente (solo afecta dibujo objeto)")
    print()
    print("=== Campos OMSI 2.3 ===")
    print("  element_id  = ID instancia en .map")
    print("  path_idx    = indice en .sli (0-based) u .sco (1-based)")
    print("  route_id    = kachel / grupo ruta editor")
    print("  global_path = PathIndex.path (grafo global, NO path_idx)")
    print("  distance    = reldist metros locales en ese segmento")
    print("  Ver docs/TTR.md para reparacion y typ=0/1/2")


if __name__ == "__main__":
    main()
