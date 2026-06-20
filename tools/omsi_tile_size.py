"""OMSI 2: métricas de tile según el motor (descompilado maps.c / FUN_007f283c).

- Sin ``[worldcoordinates]`` → 300 m fijos, rejilla uniforme.
- Con ``[worldcoordinates]`` + ``tile_X_Y`` → ``611.5 × cos(lat(Y_grid))`` donde
  ``lat`` sale de Mercator inverso con índice Y de ``[map]`` (no ``[mapcam]``).
- Con ``[worldcoordinates]`` + nombre numérico (``153835.map``) → latitud del nombre.
"""
from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass

STANDARD_TILE_M = 300.0
WORLD_EQUATOR_TILE_M = 611.5
WGS84_R_M = 6378137.0

_TILE_COORDS_RE = re.compile(r"tile_(-?\d+)_(-?\d+)\.map", re.IGNORECASE)
_WORLD_COORDS_RE = re.compile(r"(?m)^\s*\[worldcoordinates\]\s*$", re.IGNORECASE)


def _read_cfg_text(path: str) -> str:
    for enc in ("utf-8", "utf-16", "utf-16-le", "latin-1"):
        try:
            with open(path, encoding=enc) as handle:
                return handle.read()
        except (UnicodeDecodeError, UnicodeError):
            continue
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read()


def has_world_coordinates(cfg_text: str) -> bool:
    """True si global.cfg declara ``[worldcoordinates]`` (flag motor en +0xfc)."""
    return bool(_WORLD_COORDS_RE.search(cfg_text))


def tile_file_stem(path: str) -> str:
    return os.path.splitext(os.path.basename(path.replace("\\", "/")))[0]


def is_global_coordinate_tile_name(stem: str) -> bool:
    if not stem or stem.lower().startswith("tile_"):
        return False
    return len(stem) >= 5 and stem.isdigit()


def try_parse_latitude_from_global_tile_name(stem: str) -> float | None:
    """153835 → 15.3835° (tiles con nombre solo numérico)."""
    if not is_global_coordinate_tile_name(stem):
        return None
    code = int(stem)
    if code >= 100_000:
        return code / 10_000.0
    if code >= 10_000:
        return code / 1_000.0
    return None


def latitude_from_grid_y(tile_y: int) -> float:
    """Latitud en grados a partir del índice Y de ``[map]`` (FUN_007f283c / Mercator)."""
    merc_y = tile_y * WORLD_EQUATOR_TILE_M
    lat_rad = 2.0 * math.atan(math.exp(merc_y / WGS84_R_M)) - math.pi / 2.0
    return math.degrees(lat_rad)


def tile_size_from_grid_y(tile_y: int) -> float:
    """Ancho en metros del tile (motor: FUN_007f283c(tile_Y, 0x10))."""
    lat_rad = math.radians(latitude_from_grid_y(tile_y))
    return WORLD_EQUATOR_TILE_M * math.cos(lat_rad)


def compute_tile_size_meters(
    *,
    latitude_deg: float = 0.0,
    grid_y: int | None = None,
    is_numeric_global: bool = False,
    world_coordinates: bool = False,
    manual_override: float = 0.0,
) -> float:
    if manual_override > 0.01:
        return manual_override
    if is_numeric_global:
        return WORLD_EQUATOR_TILE_M * math.cos(math.radians(latitude_deg))
    if world_coordinates and grid_y is not None:
        return tile_size_from_grid_y(grid_y)
    return STANDARD_TILE_M


def parse_map_entries_from_global_cfg(cfg_text: str) -> list[tuple[int, int, str]]:
    lines = cfg_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    entries: list[tuple[int, int, str]] = []
    i = 0
    while i < len(lines):
        tag = lines[i].strip()
        if tag.lower() != "[map]":
            i += 1
            continue
        vals: list[str] = []
        j = i + 1
        while j < len(lines):
            text = lines[j].strip()
            if not text:
                j += 1
                continue
            if text.startswith("["):
                break
            vals.append(text)
            j += 1
        if len(vals) >= 3:
            try:
                x = int(vals[0])
                y = int(vals[1])
                rel = vals[2].replace("\\", "/")
                if rel:
                    entries.append((x, y, rel))
            except ValueError:
                pass
        i = j
    return entries


def parse_tile_coords_from_name(filename: str) -> tuple[int, int] | None:
    match = _TILE_COORDS_RE.search(filename)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


@dataclass
class MapTileMetric:
    x: int
    y: int
    relative_path: str
    file_name: str
    is_global: bool = False
    world_coordinates: bool = False
    latitude_deg: float = 0.0
    tile_size_m: float = STANDARD_TILE_M
    layout_world_x: float = 0.0
    layout_world_z: float = 0.0


def apply_tile_metrics(
    metric: MapTileMetric,
    manual_override: float = 0.0,
    *,
    map_world_coordinates: bool = False,
) -> None:
    stem = tile_file_stem(metric.file_name or metric.relative_path)
    is_numeric_global = is_global_coordinate_tile_name(stem)
    metric.is_global = is_numeric_global
    metric.world_coordinates = map_world_coordinates and not is_numeric_global

    if manual_override > 0.01:
        metric.tile_size_m = manual_override
        return

    if is_numeric_global:
        lat = try_parse_latitude_from_global_tile_name(stem)
        metric.latitude_deg = lat if lat is not None else 0.0
        metric.tile_size_m = compute_tile_size_meters(
            latitude_deg=metric.latitude_deg,
            is_numeric_global=True,
        )
        return

    if map_world_coordinates:
        metric.latitude_deg = latitude_from_grid_y(metric.y)
        metric.tile_size_m = tile_size_from_grid_y(metric.y)
        return

    metric.latitude_deg = 0.0
    metric.tile_size_m = STANDARD_TILE_M


def apply_world_layout(metrics: list[MapTileMetric], fallback_m: float = STANDARD_TILE_M) -> None:
    if not metrics:
        return

    grid: dict[tuple[int, int], MapTileMetric] = {}
    min_x = min_y = 10**9
    fallback = fallback_m if fallback_m > 0.01 else STANDARD_TILE_M

    for metric in metrics:
        if metric.tile_size_m < 0.01:
            metric.tile_size_m = fallback
        grid[(metric.x, metric.y)] = metric
        min_x = min(min_x, metric.x)
        min_y = min(min_y, metric.y)

    if min_x == 10**9:
        return

    for metric in metrics:
        origin_x = 0.0
        origin_z = 0.0
        for x in range(min_x, metric.x):
            left = grid.get((x, metric.y))
            origin_x += left.tile_size_m if left else fallback
        for y in range(min_y, metric.y):
            below = grid.get((metric.x, y))
            origin_z += below.tile_size_m if below else fallback
        metric.layout_world_x = origin_x
        metric.layout_world_z = origin_z


def uses_mercator_layout(metric: MapTileMetric) -> bool:
    return metric.is_global or metric.world_coordinates


def get_tile_origin(metric: MapTileMetric, min_tx: int, min_ty: int, legacy_uniform: float = STANDARD_TILE_M) -> tuple[float, float]:
    if metric.layout_world_x > 0.001 or metric.layout_world_z > 0.001 or uses_mercator_layout(metric):
        return metric.layout_world_x, metric.layout_world_z
    size = legacy_uniform if legacy_uniform > 0.01 else STANDARD_TILE_M
    return (metric.x - min_tx) * size, (metric.y - min_ty) * size


def map_root_from_tiles_dir(tiles_dir: str) -> str:
    base = os.path.abspath(tiles_dir)
    if os.path.basename(base).lower() == "copia":
        return os.path.dirname(base)
    return base


def resolve_global_cfg_path(map_dir: str) -> str | None:
    candidate = os.path.join(map_root_from_tiles_dir(map_dir), "global.cfg")
    return candidate if os.path.isfile(candidate) else None


def build_tile_metrics_from_map_dir(
    map_dir: str,
    *,
    tile_paths: list[str] | None = None,
    manual_override: float = 0.0,
) -> tuple[list[MapTileMetric], dict[str, MapTileMetric], bool]:
    cfg_path = resolve_global_cfg_path(map_dir)
    cfg_text = _read_cfg_text(cfg_path) if cfg_path else ""
    map_world_coordinates = has_world_coordinates(cfg_text) if cfg_text else False
    cfg_entries = parse_map_entries_from_global_cfg(cfg_text) if cfg_text else []

    by_name: dict[str, MapTileMetric] = {}
    metrics: list[MapTileMetric] = []

    if cfg_entries:
        for x, y, rel in cfg_entries:
            file_name = os.path.basename(rel.replace("\\", "/"))
            metric = MapTileMetric(x=x, y=y, relative_path=rel, file_name=file_name)
            apply_tile_metrics(metric, manual_override, map_world_coordinates=map_world_coordinates)
            metrics.append(metric)
            by_name[file_name.lower()] = metric
    elif tile_paths:
        for path in tile_paths:
            file_name = os.path.basename(path.replace("\\", "/"))
            coords = parse_tile_coords_from_name(file_name)
            if not coords:
                continue
            metric = MapTileMetric(
                x=coords[0],
                y=coords[1],
                relative_path=file_name,
                file_name=file_name,
            )
            apply_tile_metrics(metric, manual_override, map_world_coordinates=map_world_coordinates)
            metrics.append(metric)
            by_name[file_name.lower()] = metric

    fallback = manual_override if manual_override > 0.01 else STANDARD_TILE_M
    apply_world_layout(metrics, fallback)
    return metrics, by_name, map_world_coordinates


def tile_layout_summary(metrics: list[MapTileMetric], map_world_coordinates: bool = False) -> dict:
    numeric_global = sum(1 for m in metrics if m.is_global)
    world_grid = sum(1 for m in metrics if m.world_coordinates)
    classic = sum(1 for m in metrics if not m.is_global and not m.world_coordinates)

    sample = None
    if map_world_coordinates and world_grid:
        sample = next((m for m in metrics if m.world_coordinates), None)
    elif numeric_global:
        sample = next((m for m in metrics if m.is_global), None)

    return {
        "classicTileCount": classic,
        "globalTileCount": numeric_global,
        "worldGridTileCount": world_grid,
        "worldCoordinates": map_world_coordinates,
        "tileCount": len(metrics),
        "tileSizeM": round(sample.tile_size_m, 3) if sample else STANDARD_TILE_M,
        "mapLatitude": round(sample.latitude_deg, 3) if sample else None,
        "sampleGridY": sample.y if sample else None,
    }


def apply_tile_layout_to_sdk(map_dir: str, *, manual_override: float = 0.0) -> dict:
    """Configura TILE_SIZE + _TILE_LAYOUT en movimiento_calle.path_graph."""
    import movimiento_calle.path_graph as pg

    tiles_dir = map_dir
    if os.path.isdir(map_dir):
        from movimiento_calle.runner import list_tile_maps

        map_files = list_tile_maps(map_dir)
        tile_paths = [os.path.basename(p) for p in map_files]
    else:
        tile_paths = None

    metrics, _, map_world_coordinates = build_tile_metrics_from_map_dir(
        tiles_dir, tile_paths=tile_paths, manual_override=manual_override
    )
    layout: dict[tuple[int, int], tuple[float, float, float]] = {}
    for m in metrics:
        ox, oz = get_tile_origin(m, 0, 0, STANDARD_TILE_M)
        layout[(m.x, m.y)] = (ox, oz, m.tile_size_m)

    pg.TILE_SIZE = manual_override if manual_override > 0.01 else STANDARD_TILE_M
    if hasattr(pg, "_TILE_LAYOUT"):
        pg._TILE_LAYOUT = layout
    summary = tile_layout_summary(metrics, map_world_coordinates)
    summary["layoutTiles"] = len(layout)
    return summary
