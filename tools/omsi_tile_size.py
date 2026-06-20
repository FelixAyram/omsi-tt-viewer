"""OMSI 2: tamaño de tile según latitud del mapa (compensación Mercator).

OMSI mantiene la escala métrica de splines/objetos, pero el ancho geográfico
de cada tile_*.map se reduce hacia los polos:

    tile_size_m = 611.5 * cos(latitud_grados)

La latitud se lee de global.cfg, sección [mapcam] (5.º valor: tx, ty, x, y, lat).
"""
from __future__ import annotations

import math
import os

TILE_SIZE_EQUATOR_M = 611.5
DEFAULT_TILE_SIZE_M = 300.0


def _read_cfg_text(path: str) -> str:
    for enc in ("utf-8", "utf-16", "utf-16-le", "latin-1"):
        try:
            with open(path, encoding=enc) as handle:
                return handle.read()
        except (UnicodeDecodeError, UnicodeError):
            continue
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read()


def _section_values(cfg_text: str, section: str) -> list[str]:
    lines = cfg_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    in_section = False
    values: list[str] = []
    for line in lines:
        text = line.strip()
        if not text:
            continue
        if text.startswith("["):
            tag = text.lower()
            if tag == f"[{section.lower()}]":
                in_section = True
                continue
            if in_section:
                break
            continue
        if in_section:
            values.append(text)
    return values


def parse_mapcam_latitude(cfg_text: str) -> float | None:
    """Latitud en grados desde [mapcam] (5.º valor tras la etiqueta)."""
    vals = _section_values(cfg_text, "mapcam")
    if len(vals) < 5:
        return None
    try:
        lat = float(vals[4].replace(",", "."))
    except ValueError:
        return None
    if not math.isfinite(lat) or abs(lat) > 90:
        return None
    return lat


def tile_size_meters(latitude_deg: float) -> float:
    return TILE_SIZE_EQUATOR_M * math.cos(math.radians(latitude_deg))


def map_root_from_tiles_dir(tiles_dir: str) -> str:
    """Raíz del mapa (global.cfg) a partir de la carpeta de tiles o copia/."""
    base = os.path.abspath(tiles_dir)
    if os.path.basename(base).lower() == "copia":
        return os.path.dirname(base)
    return base


def resolve_global_cfg_path(map_dir: str) -> str | None:
    root = map_root_from_tiles_dir(map_dir)
    candidate = os.path.join(root, "global.cfg")
    return candidate if os.path.isfile(candidate) else None


def tile_size_from_map_dir(map_dir: str) -> tuple[float, float | None]:
    """(tile_size_m, latitud_grados | None)."""
    cfg = resolve_global_cfg_path(map_dir)
    if not cfg:
        return DEFAULT_TILE_SIZE_M, None
    lat = parse_mapcam_latitude(_read_cfg_text(cfg))
    if lat is None:
        return DEFAULT_TILE_SIZE_M, None
    return tile_size_meters(lat), lat


def apply_tile_size_to_sdk(map_dir: str) -> tuple[float, float | None]:
    """Fija movimiento_calle.path_graph.TILE_SIZE antes de crear MapPathGraph."""
    size, lat = tile_size_from_map_dir(map_dir)
    import movimiento_calle.path_graph as pg

    pg.TILE_SIZE = size
    return size, lat
