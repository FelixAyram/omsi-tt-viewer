"""
Modo de ruta por typ de path OMSI (0=bus, 2=tren, 3=avion).

El reparador infiere el typ desde la primera entrada valida del .ttr
y mantiene ese typ en toda la ruta.
"""
from __future__ import annotations

from collections import Counter

VEHICLE_PATH_TYP = 0
PEDESTRIAN_PATH_TYP = 1
TRAIN_PATH_TYP = 2
AIR_PATH_TYP = 3

DRIVEN_PATH_TYPS = frozenset({VEHICLE_PATH_TYP, TRAIN_PATH_TYP, AIR_PATH_TYP})

TYP_LABELS = {
    VEHICLE_PATH_TYP: "calle/bus",
    PEDESTRIAN_PATH_TYP: "peaton",
    TRAIN_PATH_TYP: "tren/tranvia",
    AIR_PATH_TYP: "avion",
}


def typ_label(typ: int) -> str:
    return TYP_LABELS.get(typ, f"tipo {typ}")


def path_typ_of_ref(graph, ref) -> int:
    """typ del path en .sli/.sco para una OmsiEntryRef del SDK."""
    if hasattr(graph, "rail_path_typ"):
        return graph.rail_path_typ(ref.rail)
    # Fallback pre-parche SDK
    if graph.is_vehicle_path(ref.rail):
        return VEHICLE_PATH_TYP
    if ref.kind.value == "spline":
        meta = graph.spline_path_info(ref.element_id, ref.path_idx)
        return meta.typ if meta else VEHICLE_PATH_TYP
    obj = graph.objects.get(ref.element_id)
    if obj:
        try:
            sco = obj.paths.get(int(ref.path_idx))
            return sco.typ if sco else VEHICLE_PATH_TYP
        except (ValueError, AttributeError):
            pass
    return VEHICLE_PATH_TYP


def infer_route_path_typ(graph, entries, *, classify_entry) -> int:
    """
    typ de toda la ruta = primera entrada valida con typ conducible (0/2/3).
    Si solo hay peatón (1) o entradas invalidas, default bus (0).
    """
    from movimiento_calle.ttr_omsi import EntryKind

    for entry in entries:
        ref = classify_entry(graph, entry.element_id, entry.path_idx)
        if ref.kind == EntryKind.INVALID:
            continue
        typ = path_typ_of_ref(graph, ref)
        if typ in DRIVEN_PATH_TYPS:
            return typ
    return VEHICLE_PATH_TYP


def is_route_path_typ(graph, ref, route_typ: int) -> bool:
    if hasattr(graph, "is_path_typ"):
        return graph.is_path_typ(ref.rail, route_typ)
    return path_typ_of_ref(graph, ref) == route_typ


def default_spline_path_for_typ(graph, spline_id: str, route_typ: int) -> str:
    if hasattr(graph, "default_path_for_typ"):
        return str(graph.default_path_for_typ(spline_id, route_typ))
    if route_typ == VEHICLE_PATH_TYP:
        return str(graph.default_vehicle_spline_path(spline_id))
    meta = graph._sli_meta_for_spline(spline_id) if hasattr(graph, "_sli_meta_for_spline") else {}
    for pidx, info in sorted(meta.items()):
        if info.typ == route_typ:
            return str(pidx)
    return str(graph.default_vehicle_spline_path(spline_id))
