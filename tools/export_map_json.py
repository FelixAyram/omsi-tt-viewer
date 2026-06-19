#!/usr/bin/env python3
"""Exporta un mapa OMSI 2 a JSON para el visor web (GitHub Pages)."""
from __future__ import annotations

import argparse
import json
import math
import os
import sys


def _default_sdk() -> str:
    env = os.environ.get("OMSI_SDK", "").strip()
    if env and os.path.isdir(env):
        return env
    candidates = [
        r"F:\SteamLibrary\steamapps\common\OMSI 2\SDK",
        os.path.expanduser(r"~\SteamLibrary\steamapps\common\OMSI 2\SDK"),
    ]
    for path in candidates:
        if os.path.isdir(path):
            return path
    return candidates[0]


def rail_key(kind: str, element_id: str, path_idx: str) -> str:
    return f"{kind}:{element_id}:{path_idx}"


def _segment_count(length: float, radius: float) -> int:
    length = max(length, 0.01)
    if abs(radius) < 1e-6:
        return min(64, max(2, math.ceil(length / 12)))
    arc = length / abs(radius)
    return min(96, max(8, math.ceil(arc / (math.pi / 20))))


def _sample_spline_polyline(graph, sid: str, path_idx: int) -> list[list[float]]:
    from movimiento_calle.path_graph import Point3, _dir_from_rotation, _parse_tile_coords, _tile_origin
    from movimiento_calle.path_starts import _perp_offset
    from movimiento_calle.spline_geometry import calculate_final_position_3d

    info = graph.splines.get(str(sid))
    if not info:
        return []
    meta = graph.spline_path_info(sid, str(path_idx))
    lateral = meta.lateral_x if meta else 0.0
    height = meta.height_z if meta else 0.0
    coords = _parse_tile_coords(info.tile)
    origin = _tile_origin(coords[0], coords[1], graph._min_tx, graph._min_ty) if coords else Point3(0, 0, 0)
    n = _segment_count(info.largo, info.radius)
    points: list[list[float]] = []
    for i in range(n + 1):
        dist = info.largo * i / n
        xf, yf, zf, rot_f = calculate_final_position_3d(
            info.x,
            info.y,
            info.rotation,
            info.radius,
            dist,
            info.z,
            is_spline_h=False,
        )
        direction = _dir_from_rotation(rot_f)
        off = _perp_offset(direction, lateral)
        wx = origin.x + xf + off.x
        wz = origin.z + yf + off.z
        wy = zf + height
        points.append([wx, wy, wz])
    return points


def _sample_object_polyline(graph, oid: str, path_idx: int) -> list[list[float]]:
    from movimiento_calle.path_graph import Point3, _parse_tile_coords, _resolve_sco_path, _rotate_y, _tile_origin
    from movimiento_calle.spline_geometry import calculate_final_position_3d

    obj = graph.objects.get(str(oid))
    if not obj:
        return []
    path = obj.paths.get(path_idx)
    if not path:
        return []

    sco_radius = 0.0
    sco_angle = 0.0
    sco_sx = path.start_local.x
    sco_sy = path.start_local.z
    sco_sz = path.start_local.y
    sco_full = _resolve_sco_path(graph.omsi_root, obj.sco_rel)
    if sco_full:
        try:
            with open(sco_full, encoding="latin-1", errors="replace") as handle:
                lines = [line.rstrip("\r\n") for line in handle]
        except OSError:
            lines = []
        pnum = 0
        idx = 0
        while idx < len(lines):
            tag = lines[idx].strip().lower()
            if tag not in ("[path]", "[path_2]"):
                idx += 1
                continue
            vals = []
            j = idx + 1
            while j < len(lines):
                text = lines[j].strip()
                if not text:
                    j += 1
                    continue
                if text.startswith("["):
                    break
                try:
                    vals.append(float(text.replace(",", ".")))
                except ValueError:
                    break
                j += 1
            if len(vals) >= 6:
                pnum += 1
                if pnum == path_idx:
                    sco_sx, sco_sy, sco_sz = vals[0], vals[2], vals[1]
                    sco_angle = vals[3]
                    sco_radius = vals[4]
                    break
            idx = j

    coords = _parse_tile_coords(obj.tile)
    origin = _tile_origin(coords[0], coords[1], graph._min_tx, graph._min_ty) if coords else Point3(0, 0, 0)
    n = _segment_count(path.length, sco_radius)
    points: list[list[float]] = []
    for i in range(n + 1):
        dist = path.length * i / n
        xf, yf, zf, _ = calculate_final_position_3d(
            sco_sx,
            sco_sy,
            sco_angle,
            sco_radius,
            dist,
            sco_sz,
        )
        p = _rotate_y(Point3(xf, zf, yf), obj.rotation)
        wx = origin.x + obj.x + p.x
        wz = origin.z + obj.y + p.z
        wy = obj.z + p.y
        points.append([wx, wy, wz])
    return points


def export_map(map_dir: str, out_path: str, *, compact: bool = True) -> dict:
    sdk = _default_sdk()
    if sdk not in sys.path:
        sys.path.insert(0, sdk)

    from movimiento_calle.path_graph import MapPathGraph
    from movimiento_calle.path_starts import collect_all_rail_endpoints, find_path_starts
    from movimiento_calle.ttdata_ecosystem import collect_trip_ttr_pairs, parse_ttp_file
    from movimiento_calle.ttdata_updater import parse_ttr, ttdata_dir

    map_dir = os.path.abspath(map_dir)
    graph = MapPathGraph(map_dir, workers=0)

    rails_raw = collect_all_rail_endpoints(graph, skip_invis=True)
    starts = find_path_starts(graph)
    free_ids = {
        rail_key(a.rail.kind, a.rail.element_id, a.rail.path_idx)
        for a in starts
        if a.is_free_start
    }

    rails: list[dict] = []
    min_x = min_z = float("inf")
    max_x = max_z = float("-inf")

    def _expand(point) -> None:
        nonlocal min_x, max_x, min_z, max_z
        min_x = min(min_x, point.x)
        max_x = max(max_x, point.x)
        min_z = min(min_z, point.z)
        max_z = max(max_z, point.z)

    for rail in rails_raw:
        key = rail_key(rail.kind, rail.element_id, rail.path_idx)
        try:
            pidx = int(rail.path_idx)
        except ValueError:
            pidx = 0
        if rail.kind == "spline":
            points = _sample_spline_polyline(graph, rail.element_id, pidx)
        else:
            points = _sample_object_polyline(graph, rail.element_id, pidx)
        if not points:
            points = [
                [rail.start.x, rail.start.y, rail.start.z],
                [rail.end.x, rail.end.y, rail.end.z],
            ]
        for pt in points:
            _expand(type("P", (), {"x": pt[0], "z": pt[2]})())
        radius = 0.0
        if rail.kind == "spline":
            sp = graph.splines.get(rail.element_id)
            radius = sp.radius if sp else 0.0
        rails.append(
            {
                "id": key,
                "kind": rail.kind,
                "elementId": rail.element_id,
                "pathIdx": rail.path_idx,
                "typ": rail.typ,
                "vehicle": rail.is_vehicle,
                "direction": rail.direction,
                "tile": rail.tile,
                "points": points,
                "start": points[0],
                "end": points[-1],
                "length": round(rail.length, 3),
                "radius": radius,
                "freeStart": key in free_ids,
            }
        )

    busstops: list[dict] = []
    for bid, stop in sorted(graph.busstops.items(), key=lambda x: int(x[0]) if x[0].isdigit() else x[0]):
        world = graph.object_world_center(
            bid,
            hint_spline=stop.parent_spline_id or None,
            hint_dist=stop.dist_along_spline if stop.dist_along_spline else None,
        )
        if world:
            bx, by, bz = world.x, world.y, world.z
        else:
            bx, by, bz = stop.x, stop.y, stop.z
        _expand(type("P", (), {"x": bx, "z": bz})())
        busstops.append(
            {
                "id": bid,
                "name": stop.name or f"Parada {bid}",
                "x": bx,
                "y": by,
                "z": bz,
                "rotation": stop.rotation,
                "pathIdx": stop.path_idx,
                "parentSpline": stop.parent_spline_id,
            }
        )

    routes: list[dict] = []
    tt_dir = ttdata_dir(map_dir)
    if os.path.isdir(tt_dir):
        ttr_to_trip: dict[str, str] = {}
        for rel, ttp_path, ttr_path in collect_trip_ttr_pairs(tt_dir):
            trip = parse_ttp_file(ttp_path)
            label = trip.linie.strip() or trip.target.strip() or rel
            if trip.target.strip() and trip.linie.strip():
                label = f"{trip.linie} → {trip.target}"
            ttr_to_trip[os.path.normpath(ttr_path)] = label

        seen: set[str] = set()
        for root, _dirs, files in os.walk(tt_dir):
            for name in sorted(files):
                if not name.lower().endswith(".ttr"):
                    continue
                ttr_path = os.path.join(root, name)
                norm = os.path.normpath(ttr_path)
                if norm in seen:
                    continue
                seen.add(norm)

                with open(ttr_path, encoding="utf-8", errors="replace") as handle:
                    _, entries = parse_ttr(handle.read())

                rel = os.path.relpath(ttr_path, tt_dir).replace("\\", "/")
                route_entries = []
                used_rails: set[str] = set()
                for entry in entries:
                    kind = "spline" if entry.element_id in graph.splines else "object"
                    key = rail_key(kind, entry.element_id, entry.path_idx)
                    used_rails.add(key)
                    route_entries.append(
                        {
                            "elementId": entry.element_id,
                            "pathIdx": entry.path_idx,
                            "routeId": entry.route_id,
                            "distance": entry.distance,
                            "kind": kind,
                            "railId": key,
                        }
                    )

                routes.append(
                    {
                        "id": rel,
                        "file": name,
                        "label": ttr_to_trip.get(norm, name),
                        "entries": route_entries,
                        "railIds": sorted(used_rails),
                    }
                )

    if not rails:
        min_x = max_x = min_z = max_z = 0.0

    payload = {
        "version": 2,
        "mapName": os.path.basename(map_dir.rstrip("\\/")),
        "bounds": {
            "minX": min_x,
            "maxX": max_x,
            "minZ": min_z,
            "maxZ": max_z,
        },
        "rails": rails,
        "busstops": busstops,
        "routes": routes,
        "stats": {
            "railCount": len(rails),
            "freeStartCount": len(free_ids),
            "busstopCount": len(busstops),
            "routeCount": len(routes),
        },
    }

    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        if compact:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(payload, handle, ensure_ascii=False, indent=2)

    print(
        f"OK {payload['mapName']}: {len(rails)} rieles, "
        f"{len(free_ids)} libres, {len(busstops)} paradas, {len(routes)} rutas -> {out_path}"
    )
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Exporta mapa OMSI 2 a JSON para el visor web.")
    parser.add_argument("map_dir", help="Carpeta del mapa (ej. .../maps/Test_Lat30)")
    parser.add_argument(
        "-o",
        "--output",
        help="Archivo JSON de salida (default: docs/data/<nombre>.json)",
    )
    parser.add_argument("--pretty", action="store_true", help="JSON indentado")
    args = parser.parse_args()

    map_name = os.path.basename(os.path.abspath(args.map_dir.rstrip("\\/")))
    slug = map_name.lower().replace(" ", "_")
    out = args.output or os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "docs",
        "data",
        f"{slug}.json",
    )
    export_map(args.map_dir, out, compact=not args.pretty)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
