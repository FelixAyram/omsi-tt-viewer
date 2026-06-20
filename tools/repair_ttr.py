#!/usr/bin/env python3
"""
Auditoría y reparación de rutas .ttr (OMSI 2) — alineado con el visor web.

Usa el SDK movimiento_calle (OMSI 2/SDK). Flujo recomendado para mapas grandes:

  1. audit   — informe antes (issues OMSI + entradas que el visor omitiría)
  2. restore — restaurar formato OMSI 2.3 desde TTData_backup_pre_repair
  3. geometry — repair_entry_omsi en cada entrada (conectividad, typ=0, distancias)
  4. anchored — anclar en cajitas busstop (.ttp) y rellenar segmentos intermedios

Ejemplos:
  python tools/repair_ttr.py audit "F:/.../maps/Ahlheim 4"
  python tools/repair_ttr.py repair "F:/.../maps/Ahlheim 4" --phases restore,geometry,anchored
  python tools/repair_ttr.py repair "F:/.../maps/Ahlheim 4" --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone


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


def _default_omsi_root() -> str:
    env = os.environ.get("OMSI_ROOT", "").strip()
    if env and os.path.isdir(env):
        return env
    candidates = [
        r"F:\SteamLibrary\steamapps\common\OMSI 2",
        os.path.expanduser(r"~\SteamLibrary\steamapps\common\OMSI 2"),
    ]
    for path in candidates:
        if os.path.isdir(path):
            return path
    return candidates[0]


def _ensure_sdk():
    sdk = _default_sdk()
    if sdk not in sys.path:
        sys.path.insert(0, sdk)
    return sdk


@dataclass
class ViewerSkip:
    file: str
    index: int
    element_id: str
    path_idx: str
    kind: str
    reason: str
    detail: str


def _viewer_skip_label(skip: ViewerSkip) -> str:
    if skip.reason == "missing":
        return (
            f"#{skip.index}: riel no encontrado ({skip.kind} {skip.element_id} - path {skip.path_idx}) "
            f"-- spline/objeto o path_idx ausente en el mapa"
        )
    if skip.reason == "non-vehicle":
        typ_label = {1: "peatón", 2: "tranvía/tren"}.get(
            int(skip.detail) if skip.detail.isdigit() else -1, f"typ={skip.detail}"
        )
        return (
            f"#{skip.index}: no es carretera, typ={skip.detail} {typ_label} "
            f"({skip.kind} {skip.element_id} - path {skip.path_idx}) "
            f"-- las rutas .ttr de bus solo usan typ=0; OMSI lo ignora aquí"
        )
    return f"#{skip.index}: {skip.reason} ({skip.kind} {skip.element_id} path {skip.path_idx})"


def audit_viewer_skips(graph, entries, rel_file: str) -> list[ViewerSkip]:
    """Misma lógica que resolveTrackEntryRail en docs/js/map_processor.js."""
    from movimiento_calle.ttr_omsi import EntryKind, classify_entry

    skips: list[ViewerSkip] = []
    for entry in entries:
        idx = entry.index if entry.index is not None else 0
        ref = classify_entry(graph, entry.element_id, entry.path_idx)
        if ref.kind == EntryKind.INVALID:
            skips.append(
                ViewerSkip(rel_file, idx, entry.element_id, entry.path_idx, "invalid", "missing", "")
            )
            continue

        kind = ref.kind.value
        norm_path = (
            graph.normalize_spline_path(entry.element_id, entry.path_idx)
            if ref.kind == EntryKind.SPLINE
            else graph.normalize_object_path(entry.element_id, entry.path_idx)
        )
        ref = classify_entry(graph, entry.element_id, norm_path)

        path_ok = (
            graph.spline_has_path(entry.element_id, norm_path)
            if ref.kind == EntryKind.SPLINE
            else graph.object_has_path(entry.element_id, norm_path)
        )
        if not path_ok:
            skips.append(
                ViewerSkip(rel_file, idx, entry.element_id, norm_path, kind, "missing", "")
            )
            continue

        if not graph.is_vehicle_path(ref.rail):
            typ = 0
            if ref.kind == EntryKind.SPLINE:
                meta = graph.spline_path_info(entry.element_id, norm_path)
                typ = meta.typ if meta else 0
            else:
                obj = graph.objects.get(entry.element_id)
                try:
                    sco = obj.paths.get(int(norm_path)) if obj else None
                    typ = sco.typ if sco else 0
                except (ValueError, AttributeError):
                    typ = 0
            skips.append(
                ViewerSkip(rel_file, idx, entry.element_id, norm_path, kind, "non-vehicle", str(typ))
            )
    return skips


def collect_ttr_files(tt_dir: str) -> list[tuple[str, str]]:
    files: list[tuple[str, str]] = []
    for root, _dirs, names in os.walk(tt_dir):
        for name in names:
            if not name.lower().endswith(".ttr"):
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, tt_dir).replace("\\", "/")
            files.append((rel, full))
    return sorted(files)


def run_audit(map_dir: str, *, workers: int = 0, sample_skips: int = 40) -> dict:
    _ensure_sdk()
    from movimiento_calle.config import REPAIR_CPU_WORKERS, cpu_worker_count
    from movimiento_calle.path_graph import MapPathGraph
    from movimiento_calle.ttdata_repair import map_tiles_dir
    from movimiento_calle.ttr_omsi import validate_ttr_omsi
    from movimiento_calle.ttr_v23 import count_omsi_load_errors
    from movimiento_calle.ttdata_updater import parse_ttr

    tt_dir = os.path.join(map_dir, "TTData")
    tiles_dir = map_tiles_dir(map_dir)
    worker_count = cpu_worker_count(workers or REPAIR_CPU_WORKERS)

    print(f"[audit] mapa: {map_dir}")
    print(f"[audit] tiles: {tiles_dir}")
    print(f"[audit] TTData: {tt_dir}")
    t0 = time.time()
    graph = MapPathGraph(tiles_dir, progress_cb=lambda m: print(m, flush=True), workers=worker_count)
    print(f"[audit] grafo en {time.time() - t0:.1f}s | {len(graph.splines)} splines, {len(graph.objects)} objetos")

    omsi_codes: Counter[str] = Counter()
    viewer_reasons: Counter[str] = Counter()
    files_with_omsi = 0
    files_with_viewer = 0
    entries_total = 0
    omsi_parse_errors = 0
    skip_samples: list[str] = []

    ttr_files = collect_ttr_files(tt_dir)
    for rel, path in ttr_files:
        with open(path, encoding="utf-8", errors="replace") as handle:
            _, entries = parse_ttr(handle.read())
        entries_total += len(entries)
        omsi_parse_errors += count_omsi_load_errors(entries)
        issues = validate_ttr_omsi(graph, entries)
        if issues:
            files_with_omsi += 1
            for issue in issues:
                omsi_codes[issue.code] += 1

        vskips = audit_viewer_skips(graph, entries, rel)
        if vskips:
            files_with_viewer += 1
            for sk in vskips:
                viewer_reasons[sk.reason] += 1
                if len(skip_samples) < sample_skips:
                    skip_samples.append(_viewer_skip_label(sk))

    report = {
        "map": os.path.basename(map_dir.rstrip("\\/")),
        "map_dir": map_dir,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "ttr_files": len(ttr_files),
        "entries_total": entries_total,
        "omsi_parse_errors": omsi_parse_errors,
        "files_with_omsi_issues": files_with_omsi,
        "files_with_viewer_skips": files_with_viewer,
        "omsi_issues_by_code": dict(omsi_codes.most_common()),
        "viewer_skips_by_reason": dict(viewer_reasons.most_common()),
        "viewer_skip_samples": skip_samples,
        "elapsed_s": round(time.time() - t0, 1),
    }

    print()
    print(f"Archivos .ttr: {report['ttr_files']}")
    print(f"Entradas: {report['entries_total']}")
    print(f"Errores parse OMSI (sin path entero v23): {report['omsi_parse_errors']}")
    print(f"Archivos con issues OMSI: {files_with_omsi}")
    print(f"Archivos con entradas omitidas en visor: {files_with_viewer}")
    print(f"Issues OMSI por código: {report['omsi_issues_by_code']}")
    print(f"Omitidos visor por motivo: {report['viewer_skips_by_reason']}")
    if skip_samples:
        print("\nMuestra (como en el visor):")
        for line in skip_samples[:15]:
            print(f"  · {line}")

    return report


def _geometry_pass_file(path: str, graph, backup_root: str | None, rel: str) -> dict:
    from movimiento_calle.ttdata_repair import rebuild_ttr_content, _file_header
    from movimiento_calle.ttr_omsi import dedupe_redundant_entry0, repair_ttr_entries
    from movimiento_calle.ttr_v23 import audit_ttr_v23
    from movimiento_calle.ttdata_updater import parse_ttr

    with open(path, encoding="utf-8", errors="replace") as handle:
        content = handle.read()

    backup_content = None
    if backup_root:
        backup_path = os.path.join(backup_root, rel)
        if os.path.isfile(backup_path):
            with open(backup_path, encoding="utf-8", errors="replace") as handle:
                backup_content = handle.read()

    lines, entries = parse_ttr(content)
    if not entries:
        return {"changed": 0, "dropped": 0, "entries": 0}

    backup_entries = None
    if backup_content:
        _, backup_entries = parse_ttr(backup_content)

    repaired, changed = repair_ttr_entries(entries, graph)
    repaired, dropped = dedupe_redundant_entry0(repaired)
    if changed == 0 and dropped == 0:
        return {"changed": 0, "dropped": dropped, "entries": len(entries)}

    newline = "\r\n" if "\r\n" in content[:500] else "\n"
    new_content = rebuild_ttr_content(_file_header(lines), repaired, newline)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(new_content)

    audit = audit_ttr_v23(repaired)
    return {
        "changed": changed,
        "dropped": dropped,
        "entries": len(repaired),
        "omsi_errors": audit["omsi_load_errors"],
    }


def run_repair(
    map_dir: str,
    *,
    phases: list[str],
    dry_run: bool = False,
    workers: int = 0,
    backup: bool = True,
) -> dict:
    _ensure_sdk()
    from movimiento_calle.config import REPAIR_CPU_WORKERS, cpu_worker_count
    from movimiento_calle.path_graph import MapPathGraph
    from movimiento_calle.ttdata_repair import map_tiles_dir, repair_ttdata
    from movimiento_calle.repair_ttdata_anchored import repair_ttdata_anchored

    worker_count = cpu_worker_count(workers or REPAIR_CPU_WORKERS)
    results: dict = {"map_dir": map_dir, "phases": {}, "dry_run": dry_run}

    if "restore" in phases and not dry_run:
        print("\n=== Fase: restore (formato OMSI 2.3 desde backup) ===")
        results["phases"]["restore"] = repair_ttdata(
            map_dir, progress_cb=lambda m: print(m, flush=True), backup=backup, workers=worker_count
        )
    elif "restore" in phases:
        print("\n=== Fase: restore (omitida en --dry-run) ===")

    if "geometry" in phases:
        print("\n=== Fase: geometry (repair_entry_omsi) ===")
        tt_dir = os.path.join(map_dir, "TTData")
        tiles_dir = map_tiles_dir(map_dir)
        backup_dir = os.path.join(map_dir, "TTData_backup_pre_repair")
        if not os.path.isdir(backup_dir):
            backup_dir = None

        t0 = time.time()
        graph = MapPathGraph(tiles_dir, progress_cb=lambda m: print(m, flush=True), workers=worker_count)
        stats = {"files": 0, "changed_files": 0, "changed_entries": 0, "dropped": 0}
        for rel, path in collect_ttr_files(tt_dir):
            stats["files"] += 1
            if dry_run:
                continue
            result = _geometry_pass_file(path, graph, backup_dir, rel)
            stats["changed_entries"] += result.get("changed", 0)
            stats["dropped"] += result.get("dropped", 0)
            if result.get("changed") or result.get("dropped"):
                stats["changed_files"] += 1
            if stats["files"] == 1 or stats["files"] % 50 == 0:
                print(f"[geometry] {stats['files']} archivos procesados...")
        stats["elapsed_s"] = round(time.time() - t0, 1)
        results["phases"]["geometry"] = stats
        print(f"[geometry] {stats['changed_files']}/{stats['files']} archivos modificados en {stats['elapsed_s']}s")

    if "anchored" in phases:
        print("\n=== Fase: anchored (anclas busstop + relleno) ===")
        backup_dir = os.path.join(map_dir, "TTData_backup_pre_repair")
        results["phases"]["anchored"] = repair_ttdata_anchored(
            map_dir,
            dry_run=dry_run,
            workers=worker_count,
            backup_dir=backup_dir if os.path.isdir(backup_dir) else None,
            progress_cb=lambda m: print(m, flush=True),
        )

    return results


def _write_report(map_dir: str, name: str, payload: dict) -> str:
    out_dir = os.path.join(map_dir, "_ttdata_reports")
    os.makedirs(out_dir, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_path = os.path.join(out_dir, f"{name}_{ts}.json")
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    print(f"\nInforme guardado: {out_path}")
    return out_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Auditoría y reparación de .ttr OMSI 2")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_audit = sub.add_parser("audit", help="Auditar TTData sin modificar archivos")
    p_audit.add_argument("map_dir", nargs="?", default=os.path.join(_default_omsi_root(), "maps", "Ahlheim 4"))
    p_audit.add_argument("--workers", type=int, default=0)
    p_audit.add_argument("--no-report", action="store_true")

    p_repair = sub.add_parser("repair", help="Reparar TTData (varias fases)")
    p_repair.add_argument("map_dir", nargs="?", default=os.path.join(_default_omsi_root(), "maps", "Ahlheim 4"))
    p_repair.add_argument(
        "--phases",
        default="restore,geometry,anchored",
        help="Fases separadas por coma: restore, geometry, anchored",
    )
    p_repair.add_argument("--dry-run", action="store_true")
    p_repair.add_argument("--no-backup", action="store_true")
    p_repair.add_argument("--workers", type=int, default=0)
    p_repair.add_argument("--audit-after", action="store_true", default=True)

    args = parser.parse_args()
    map_dir = os.path.abspath(args.map_dir.rstrip("\\/"))
    if not os.path.isdir(map_dir):
        print(f"ERROR: no existe {map_dir}", file=sys.stderr)
        return 1
    if not os.path.isdir(os.path.join(map_dir, "TTData")):
        print(f"ERROR: no hay TTData en {map_dir}", file=sys.stderr)
        return 1

    if args.cmd == "audit":
        report = run_audit(map_dir, workers=args.workers)
        if not args.no_report:
            _write_report(map_dir, "audit_before", report)
        return 0

    phases = [p.strip() for p in args.phases.split(",") if p.strip()]
    print(f"=== Reparar {map_dir} | fases={phases} dry_run={args.dry_run} ===")
    before = run_audit(map_dir, workers=args.workers)
    _write_report(map_dir, "audit_before", before)

    repair_result = run_repair(
        map_dir,
        phases=phases,
        dry_run=args.dry_run,
        workers=args.workers,
        backup=not args.no_backup,
    )
    _write_report(map_dir, "repair_result", repair_result)

    if args.audit_after and not args.dry_run:
        after = run_audit(map_dir, workers=args.workers)
        _write_report(map_dir, "audit_after", after)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
