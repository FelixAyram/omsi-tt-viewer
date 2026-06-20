#!/usr/bin/env python3
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from omsi_tile_size import (
    WORLD_EQUATOR_TILE_M,
    STANDARD_TILE_M,
    build_tile_metrics_from_map_dir,
    has_world_coordinates,
    latitude_from_grid_y,
    parse_map_entries_from_global_cfg,
    resolve_global_cfg_path,
    tile_size_from_grid_y,
    _read_cfg_text,
)


def parse_name(cfg: str) -> str:
    m = re.search(r"\[name\]\s*\r?\n([^\r\n\[]+)", cfg, re.I)
    return m.group(1).strip() if m else "?"


def main() -> None:
    maps = [
        ("Ecuador", r"F:\SteamLibrary\steamapps\common\OMSI 2\maps\Test_Ecuador"),
        ("Artico", r"F:\SteamLibrary\steamapps\common\OMSI 2\maps\Test_Artico"),
        ("Lat30", r"F:\SteamLibrary\steamapps\common\OMSI 2\maps\Test_Lat30"),
        ("Berlin", r"F:\SteamLibrary\steamapps\common\OMSI 2\maps\Test_Berlin"),
    ]

    refs = {0: 611.5, 5729: 529.6, 11261: 372.5, 21148: 158.3}

    for label, m in maps:
        cfgp = resolve_global_cfg_path(m)
        cfg = _read_cfg_text(cfgp) if cfgp else ""
        wc = has_world_coordinates(cfg)
        metrics, _, _ = build_tile_metrics_from_map_dir(m)
        print(f"=== Test_{label} ({parse_name(cfg)}) ===")
        print(f"  [worldcoordinates]: {wc}")
        for metric in metrics:
            calc = tile_size_from_grid_y(metric.y)
            print(
                f"    {metric.file_name}: grid ({metric.x},{metric.y}) "
                f"lat={metric.latitude_deg:.2f} deg -> {metric.tile_size_m:.1f} m"
            )
            if metric.y in refs:
                ref = refs[metric.y]
                print(f"      ref OMSI ~{ref} m, diff={abs(metric.tile_size_m-ref):.2f}")
        print()

    print("Fórmula motor: tile_size = 611.5 * cos(lat(Y_grid))")
    for y, measured in refs.items():
        calc = tile_size_from_grid_y(y)
        print(f"  Y={y}: calc={calc:.2f} m, medido ~{measured} m")


if __name__ == "__main__":
    main()
