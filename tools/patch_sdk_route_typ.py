#!/usr/bin/env python3
"""Parchea movimiento_calle (SDK) para reparar rutas segun typ de inicio (bus/tren/avion)."""
from __future__ import annotations

import os
import shutil
import sys
from datetime import datetime


def sdk_root() -> str:
    env = os.environ.get("OMSI_SDK", "").strip()
    if env and os.path.isdir(env):
        return env
    for path in (
        r"F:\SteamLibrary\steamapps\common\OMSI 2\SDK",
        os.path.expanduser(r"~\SteamLibrary\steamapps\common\OMSI 2\SDK"),
    ):
        if os.path.isdir(path):
            return path
    raise SystemExit("SDK no encontrado")


def backup(path: str) -> None:
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    shutil.copy2(path, f"{path}.{ts}.bak")


def patch_tile_layout(path: str) -> None:
    text = open(path, encoding="utf-8").read()
    if "_build_tile_layout(" in text:
        print(f"[skip] {path} ya tiene tile layout Unity")
        return

    # Quitar parche anterior basado en [mapcam] si existe
    if "_resolve_tile_size_m(" in text:
        start = text.find("\nTILE_SIZE_EQUATOR_M = 611.5\n")
        end = text.find("\n\n@dataclass\nclass Point3:")
        if start >= 0 and end > start:
            text = text[:start] + text[end:]

    helpers = '''
WORLD_EQUATOR_TILE_M = 611.5
_TILE_LAYOUT: dict[tuple[int, int], tuple[float, float, float]] = {}


def _read_global_cfg_text(cfg_path: str) -> str:
    for enc in ("utf-8", "utf-16", "utf-16-le", "latin-1"):
        try:
            with open(cfg_path, encoding=enc) as handle:
                return handle.read()
        except (UnicodeDecodeError, UnicodeError):
            continue
    with open(cfg_path, encoding="utf-8", errors="replace") as handle:
        return handle.read()


def _is_global_coordinate_tile_name(stem: str) -> bool:
    if not stem or stem.lower().startswith("tile_"):
        return False
    return len(stem) >= 5 and stem.isdigit()


def _latitude_from_global_tile_name(stem: str) -> float | None:
    if not _is_global_coordinate_tile_name(stem):
        return None
    code = int(stem)
    if code >= 100_000:
        return code / 10_000.0
    if code >= 10_000:
        return code / 1_000.0
    return None


def _tile_size_for_stem(stem: str) -> tuple[float, bool]:
    if not _is_global_coordinate_tile_name(stem):
        return TILE_SIZE, False
    lat = _latitude_from_global_tile_name(stem) or 0.0
    return WORLD_EQUATOR_TILE_M * math.cos(math.radians(lat)), True


def _parse_map_entries_cfg(cfg_text: str) -> list[tuple[int, int, str]]:
    lines = cfg_text.replace("\\r\\n", "\\n").replace("\\r", "\\n").split("\\n")
    entries: list[tuple[int, int, str]] = []
    i = 0
    while i < len(lines):
        if lines[i].strip().lower() != "[map]":
            i += 1
            continue
        vals: list[str] = []
        j = i + 1
        while j < len(lines):
            text_line = lines[j].strip()
            if not text_line:
                j += 1
                continue
            if text_line.startswith("["):
                break
            vals.append(text_line)
            j += 1
        if len(vals) >= 3:
            try:
                entries.append((int(vals[0]), int(vals[1]), vals[2].replace("\\\\", "/")))
            except ValueError:
                pass
        i = j
    return entries


def _build_tile_layout(copia_path: str) -> dict[tuple[int, int], tuple[float, float, float]]:
    base = os.path.abspath(copia_path)
    if os.path.basename(base).lower() == "copia":
        base = os.path.dirname(base)
    cfg = os.path.join(base, "global.cfg")
    entries = _parse_map_entries_cfg(_read_global_cfg_text(cfg)) if os.path.isfile(cfg) else []
    if not entries:
        return {}

    metrics: list[tuple[int, int, str, float, bool]] = []
    for x, y, rel in entries:
        stem = os.path.splitext(os.path.basename(rel.replace("\\\\", "/")))[0]
        size, is_global = _tile_size_for_stem(stem)
        metrics.append((x, y, rel, size, is_global))

    grid = {(x, y): (x, y, rel, size, is_global) for x, y, rel, size, is_global in metrics}
    min_x = min(x for x, _, _, _, _ in metrics)
    min_y = min(y for _, y, _, _, _ in metrics)
    layout: dict[tuple[int, int], tuple[float, float, float]] = {}
    for x, y, _rel, size, is_global in metrics:
        origin_x = 0.0
        origin_z = 0.0
        for xi in range(min_x, x):
            left = grid.get((xi, y))
            origin_x += left[3] if left else TILE_SIZE
        for yi in range(min_y, y):
            below = grid.get((x, yi))
            origin_z += below[3] if below else TILE_SIZE
        if origin_x > 0.001 or origin_z > 0.001 or is_global:
            layout[(x, y)] = (origin_x, origin_z, size)
    return layout

'''
    if "TILE_SIZE = 300.0\n" not in text:
        raise SystemExit("No se encontro TILE_SIZE = 300.0 en path_graph.py")
    text = text.replace("TILE_SIZE = 300.0\n", "TILE_SIZE = 300.0\n" + helpers, 1)

    origin_fn = """def _tile_origin(tx: int, ty: int, min_tx: int, min_ty: int) -> Point3:
    key = (tx, ty)
    if key in _TILE_LAYOUT:
        ox, oz, _ = _TILE_LAYOUT[key]
        return Point3(ox, 0.0, oz)
    return Point3(
        (tx - min_tx) * TILE_SIZE,
        0.0,
        (ty - min_ty) * TILE_SIZE,
    )
"""
    old_origin = """def _tile_origin(tx: int, ty: int, min_tx: int, min_ty: int) -> Point3:
    return Point3(
        (tx - min_tx) * TILE_SIZE,
        0.0,
        (ty - min_ty) * TILE_SIZE,
    )
"""
    if old_origin not in text and "_TILE_LAYOUT[key]" not in text:
        raise SystemExit("No se encontro _tile_origin en path_graph.py")
    if old_origin in text:
        text = text.replace(old_origin, origin_fn, 1)

    init_old_mapcam = (
        "        self._min_tx = 0\n"
        "        self._min_ty = 0\n"
        "        global TILE_SIZE\n"
        "        TILE_SIZE = _resolve_tile_size_m(copia_path)\n"
        "        self._tile_size_m = TILE_SIZE\n"
        "        self._load()"
    )
    init_plain = "        self._min_tx = 0\n        self._min_ty = 0\n        self._load()"
    init_patch = (
        "        self._min_tx = 0\n"
        "        self._min_ty = 0\n"
        "        global _TILE_LAYOUT\n"
        "        _TILE_LAYOUT = _build_tile_layout(copia_path)\n"
        "        self._tile_layout = _TILE_LAYOUT\n"
        "        self._load()"
    )
    if init_old_mapcam in text:
        text = text.replace(init_old_mapcam, init_patch, 1)
    elif init_plain in text:
        text = text.replace(init_plain, init_patch, 1)
    else:
        raise SystemExit("No se encontro MapPathGraph.__init__ en path_graph.py")

    backup(path)
    open(path, "w", encoding="utf-8", newline="\n").write(text)
    print(f"[ok] path_graph.py tile layout Unity (611.5×cos lat nombre)")


def patch_tile_size(path: str) -> None:
    patch_tile_layout(path)


def patch_path_graph(path: str) -> None:
    text = open(path, encoding="utf-8").read()
    marker = "    def default_vehicle_spline_path(self, spline_id: str) -> int:"
    if "def rail_path_typ(self, ref: RailRef)" in text:
        print(f"[skip] {path} ya tiene rail_path_typ")
        return
    insert = '''    def rail_path_typ(self, ref: RailRef) -> int:
        if ref.kind == "spline" or ref.element_id in self.splines:
            meta = self.spline_path_info(ref.element_id, ref.path_idx)
            return meta.typ if meta else VEHICLE_PATH_TYP
        obj = self.objects.get(ref.element_id)
        if not obj or not obj.paths:
            return VEHICLE_PATH_TYP
        try:
            sco = obj.paths.get(int(ref.path_idx))
        except ValueError:
            return VEHICLE_PATH_TYP
        return sco.typ if sco else VEHICLE_PATH_TYP

    def is_path_typ(self, ref: RailRef, typ: int) -> bool:
        return self.rail_path_typ(ref) == typ

    def spline_paths_with_typ(self, spline_id: str, typ: int) -> list[int]:
        meta = self._sli_meta_for_spline(spline_id)
        matched = [pidx for pidx, info in sorted(meta.items()) if info.typ == typ]
        if matched:
            return matched
        if typ == VEHICLE_PATH_TYP:
            return self.vehicle_spline_paths(spline_id)
        return sorted(meta.keys()) if meta else [0]

    def default_path_for_typ(self, spline_id: str, typ: int) -> int:
        paths = self.spline_paths_with_typ(spline_id, typ)
        return paths[0] if paths else 0

'''
    idx = text.find(marker)
    if idx < 0:
        raise SystemExit(f"No se encontro {marker} en path_graph.py")
    # Insertar antes de default_vehicle_spline_path
    text = text[:idx] + insert + text[idx:]
    backup(path)
    open(path, "w", encoding="utf-8", newline="\n").write(text)
    print(f"[ok] path_graph.py parcheado")


def patch_ttr_omsi(path: str) -> None:
    text = open(path, encoding="utf-8").read()
    if "def infer_route_path_typ(" in text:
        print(f"[skip] {path} ya parcheado")
        return

    text = text.replace(
        "from .ttdata_updater import TrackEntry, _format_distance, parse_ttr\n",
        "from .sli_paths import VEHICLE_PATH_TYP\n"
        "from .ttdata_updater import TrackEntry, _format_distance, parse_ttr\n\n"
        "DRIVEN_PATH_TYPS = frozenset({0, 2, 3})\n"
        "TYP_LABELS = {0: \"calle/bus\", 1: \"peaton\", 2: \"tren/tranvia\", 3: \"avion\"}\n\n\n"
        "def path_typ_of_ref(graph: MapPathGraph, ref: OmsiEntryRef) -> int:\n"
        "    return graph.rail_path_typ(ref.rail)\n\n\n"
        "def infer_route_path_typ(graph: MapPathGraph, entries: list[TrackEntry]) -> int:\n"
        "    for entry in entries:\n"
        "        ref = classify_entry(graph, entry.element_id, entry.path_idx)\n"
        "        if ref.kind == EntryKind.INVALID:\n"
        "            continue\n"
        "        typ = path_typ_of_ref(graph, ref)\n"
        "        if typ in DRIVEN_PATH_TYPS:\n"
        "            return typ\n"
        "    return VEHICLE_PATH_TYP\n",
    )

    text = text.replace(
        "def validate_ttr_omsi(graph: MapPathGraph, entries: list[TrackEntry]) -> list[ValidationIssue]:",
        "def validate_ttr_omsi(\n"
        "    graph: MapPathGraph,\n"
        "    entries: list[TrackEntry],\n"
        "    *,\n"
        "    route_typ: int | None = None,\n"
        ") -> list[ValidationIssue]:",
    )
    text = text.replace(
        "    issues: list[ValidationIssue] = []\n"
        "    prev_ref: OmsiEntryRef | None = None\n"
        "    prev_dist: float = 0.0\n\n"
        "    for entry in entries:",
        "    issues: list[ValidationIssue] = []\n"
        "    if route_typ is None:\n"
        "        route_typ = infer_route_path_typ(graph, entries)\n"
        "    prev_ref: OmsiEntryRef | None = None\n"
        "    prev_dist: float = 0.0\n\n"
        "    for entry in entries:",
    )

    text = text.replace(
        'f"path {entry.path_idx} en spline {entry.element_id} no es calle (typ!=0)"',
        'f"path {entry.path_idx} en spline {entry.element_id} typ={path_typ_of_ref(graph, ref)} '
        '!= ruta typ={route_typ} ({TYP_LABELS.get(route_typ, route_typ)})"',
    )
    text = text.replace(
        'elif not graph.is_vehicle_path(ref.rail):\n'
        "                issues.append(\n"
        "                    ValidationIssue(\n"
        "                        idx,\n"
        '                        "non_vehicle_path",',
        'elif not graph.is_path_typ(ref.rail, route_typ):\n'
        "                issues.append(\n"
        "                    ValidationIssue(\n"
        "                        idx,\n"
        '                        "wrong_path_typ",',
        1,
    )
    text = text.replace(
        'f"path {entry.path_idx} en objeto {entry.element_id} no es calle (typ!=0)"',
        'f"path {entry.path_idx} en objeto {entry.element_id} typ={path_typ_of_ref(graph, ref)} '
        '!= ruta typ={route_typ} ({TYP_LABELS.get(route_typ, route_typ)})"',
    )
    # second wrong_path_typ for object block
    text = text.replace(
        'elif not graph.is_vehicle_path(ref.rail):\n'
        "                issues.append(\n"
        "                    ValidationIssue(\n"
        "                        idx,\n"
        '                        "non_vehicle_path",',
        'elif not graph.is_path_typ(ref.rail, route_typ):\n'
        "                issues.append(\n"
        "                    ValidationIssue(\n"
        "                        idx,\n"
        '                        "wrong_path_typ",',
        1,
    )

    text = text.replace(
        "def _vehicle_path_idx(graph: MapPathGraph, spline_id: str, path_idx: str | None = None) -> str:\n"
        "  if path_idx and graph.spline_has_path(spline_id, path_idx):\n"
        "    ref = RailRef(\"spline\", spline_id, path_idx)\n"
        "    if graph.is_vehicle_path(ref):\n"
        "      return path_idx\n"
        "  return str(graph.default_vehicle_spline_path(spline_id))",
        "def _route_path_idx(\n"
        "    graph: MapPathGraph,\n"
        "    spline_id: str,\n"
        "    route_typ: int,\n"
        "    path_idx: str | None = None,\n"
        ") -> str:\n"
        "    if path_idx and graph.spline_has_path(spline_id, path_idx):\n"
        "        ref = RailRef(\"spline\", spline_id, path_idx)\n"
        "        if graph.is_path_typ(ref, route_typ):\n"
        "            return path_idx\n"
        "    return str(graph.default_path_for_typ(spline_id, route_typ))\n\n\n"
        "def _vehicle_path_idx(graph: MapPathGraph, spline_id: str, path_idx: str | None = None) -> str:\n"
        "    return _route_path_idx(graph, spline_id, VEHICLE_PATH_TYP, path_idx)",
    )

    text = text.replace(
        "def _connected_outgoing(graph: MapPathGraph, prev: OmsiEntryRef, route_id: str) -> list[RailRef]:",
        "def _connected_outgoing(\n"
        "    graph: MapPathGraph,\n"
        "    prev: OmsiEntryRef,\n"
        "    route_id: str,\n"
        "    route_typ: int,\n"
        ") -> list[RailRef]:",
    )
    text = text.replace(
        "            pidx = _vehicle_path_idx(graph, nxt)",
        "            pidx = _route_path_idx(graph, nxt, route_typ)",
    )
    text = text.replace(
        "                    pidx = _vehicle_path_idx(graph, link)",
        "                    pidx = _route_path_idx(graph, link, route_typ)",
    )
    text = text.replace(
        "        if not graph.is_vehicle_path(ref):\n"
        "            continue\n"
        "        if not graph.rails_connected(prev.rail, ref):",
        "        if not graph.is_path_typ(ref, route_typ):\n"
        "            continue\n"
        "        if not graph.rails_connected(prev.rail, ref):",
    )

    text = text.replace(
        "def _pick_connected(graph: MapPathGraph, prev_ref: OmsiEntryRef, route_id: str) -> RailRef | None:\n"
        "    outgoing = _connected_outgoing(graph, prev_ref, route_id)",
        "def _pick_connected(\n"
        "    graph: MapPathGraph,\n"
        "    prev_ref: OmsiEntryRef,\n"
        "    route_id: str,\n"
        "    route_typ: int,\n"
        ") -> RailRef | None:\n"
        "    outgoing = _connected_outgoing(graph, prev_ref, route_id, route_typ)",
    )

    text = text.replace(
        "def repair_entry_omsi(\n"
        "    entry: TrackEntry,\n"
        "    entries: list[TrackEntry],\n"
        "    graph: MapPathGraph,\n"
        ") -> TrackEntry | None:",
        "def repair_entry_omsi(\n"
        "    entry: TrackEntry,\n"
        "    entries: list[TrackEntry],\n"
        "    graph: MapPathGraph,\n"
        "    *,\n"
        "    route_typ: int | None = None,\n"
        ") -> TrackEntry | None:\n"
        "    if route_typ is None:\n"
        "        route_typ = infer_route_path_typ(graph, entries)",
    )

    text = text.replace(
        "        pick = _pick_connected(graph, prev_ref, entry.route_id)\n"
        "        if pick is None:\n"
        "            return None\n"
        "        element_id = pick.element_id\n"
        "        path_idx = pick.path_idx\n"
        "        ref = classify_entry(graph, element_id, path_idx)\n"
        "        distance = 0.0\n\n"
        "    # --- Desconexion real",
        "        pick = _pick_connected(graph, prev_ref, entry.route_id, route_typ)\n"
        "        if pick is None:\n"
        "            return None\n"
        "        element_id = pick.element_id\n"
        "        path_idx = pick.path_idx\n"
        "        ref = classify_entry(graph, element_id, path_idx)\n"
        "        distance = 0.0\n\n"
        "    # --- Desconexion real",
    )
    text = text.replace(
        "        pick = _pick_connected(graph, prev_ref, entry.route_id)\n"
        "        if pick:\n"
        "            element_id = pick.element_id\n"
        "            path_idx = pick.path_idx\n"
        "            ref = classify_entry(graph, element_id, path_idx)\n"
        "            distance = 0.0\n\n"
        "    # --- Path spline/objeto invalido ---",
        "        pick = _pick_connected(graph, prev_ref, entry.route_id, route_typ)\n"
        "        if pick:\n"
        "            element_id = pick.element_id\n"
        "            path_idx = pick.path_idx\n"
        "            ref = classify_entry(graph, element_id, path_idx)\n"
        "            distance = 0.0\n\n"
        "    # --- Path spline/objeto invalido ---",
    )

    text = text.replace(
        "        if not graph.is_vehicle_path(ref.rail):\n"
        "            path_idx = str(graph.default_vehicle_spline_path(element_id))\n"
        "            ref = classify_entry(graph, element_id, path_idx)\n"
        "    elif ref.kind == EntryKind.OBJECT:\n"
        "        norm_path = graph.normalize_object_path(element_id, path_idx)\n"
        "        if norm_path != path_idx:\n"
        "            path_idx = norm_path\n"
        "            ref = classify_entry(graph, element_id, path_idx)\n"
        "        if not graph.is_vehicle_path(ref.rail):\n"
        "            obj = graph.objects.get(element_id)\n"
        "            if obj and obj.paths:\n"
        "                for pidx in sorted(obj.paths):\n"
        "                    if graph.is_vehicle_path(RailRef(\"object\", element_id, str(pidx))):\n"
        "                        path_idx = str(pidx)\n"
        "                        ref = classify_entry(graph, element_id, path_idx)\n"
        "                        break",
        "        if not graph.is_path_typ(ref.rail, route_typ):\n"
        "            path_idx = str(graph.default_path_for_typ(element_id, route_typ))\n"
        "            ref = classify_entry(graph, element_id, path_idx)\n"
        "    elif ref.kind == EntryKind.OBJECT:\n"
        "        norm_path = graph.normalize_object_path(element_id, path_idx)\n"
        "        if norm_path != path_idx:\n"
        "            path_idx = norm_path\n"
        "            ref = classify_entry(graph, element_id, path_idx)\n"
        "        if not graph.is_path_typ(ref.rail, route_typ):\n"
        "            obj = graph.objects.get(element_id)\n"
        "            if obj and obj.paths:\n"
        "                for pidx in sorted(obj.paths):\n"
        "                    cand = RailRef(\"object\", element_id, str(pidx))\n"
        "                    if graph.is_path_typ(cand, route_typ):\n"
        "                        path_idx = str(pidx)\n"
        "                        ref = classify_entry(graph, element_id, path_idx)\n"
        "                        break",
    )

    text = text.replace(
        "def repair_ttr_entries(entries: list[TrackEntry], graph: MapPathGraph) -> tuple[list[TrackEntry], int]:\n"
        '    """Repara lista de entradas en orden; devuelve (entradas, cambios)."""\n'
        "    repaired: list[TrackEntry] = []\n"
        "    changed = 0\n"
        "    for entry in entries:\n"
        "        fixed = repair_entry_omsi(entry, entries, graph)",
        "def repair_ttr_entries(entries: list[TrackEntry], graph: MapPathGraph) -> tuple[list[TrackEntry], int]:\n"
        '    """Repara lista de entradas en orden; devuelve (entradas, cambios)."""\n'
        "    route_typ = infer_route_path_typ(graph, entries)\n"
        "    repaired: list[TrackEntry] = []\n"
        "    changed = 0\n"
        "    for entry in entries:\n"
        "        fixed = repair_entry_omsi(entry, entries, graph, route_typ=route_typ)",
    )

    backup(path)
    open(path, "w", encoding="utf-8", newline="\n").write(text)
    print(f"[ok] ttr_omsi.py parcheado")


def main() -> int:
    root = sdk_root()
    pg = os.path.join(root, "movimiento_calle", "path_graph.py")
    patch_tile_size(pg)
    patch_path_graph(pg)
    patch_ttr_omsi(os.path.join(root, "movimiento_calle", "ttr_omsi.py"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
