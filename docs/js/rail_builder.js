/** Generación de rieles compartida entre hilo principal y Web Workers. */
import { sampleSplineRail, sampleScoRail, expandBounds } from "./geometry.js?v=34";

export const VEHICLE_TYP = 0;
export const PATH_DIR_FORWARD = 0;
export const PATH_DIR_REVERSE = 1;
export const PATH_DIR_BOTH = 2;

export function railKey(kind, elementId, pathIdx) {
  return `${kind}:${elementId}:${pathIdx}`;
}

/** OmsiPathRules.MirrorAdjustedTravelDirection — invierte sentido en splines mirror. */
export function mirrorAdjustedDirection(direction, isMirrored) {
  if (!isMirrored) return direction ?? PATH_DIR_FORWARD;
  const dir = direction ?? PATH_DIR_FORWARD;
  if (dir === PATH_DIR_FORWARD) return PATH_DIR_REVERSE;
  if (dir === PATH_DIR_REVERSE) return PATH_DIR_FORWARD;
  return PATH_DIR_BOTH;
}

export function parseSliPaths(text) {
  const lines = text.split(/\r?\n/);
  const out = new Map();
  let idx = 0;
  let pathIndex = 0;
  while (idx < lines.length) {
    if (lines[idx].trim().toLowerCase() !== "[path]") {
      idx += 1;
      continue;
    }
    const vals = [];
    let j = idx + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (!t) {
        j += 1;
        continue;
      }
      if (t.startsWith("[")) break;
      vals.push(t);
      j += 1;
    }
    if (vals.length >= 5) {
      out.set(pathIndex, {
        typ: parseInt(vals[0], 10) || 0,
        lateral: parseFloat(vals[1].replace(",", ".")) || 0,
        height: parseFloat(vals[2].replace(",", ".")) || 0,
        direction: parseInt(vals[4], 10) || 0,
      });
      pathIndex += 1;
    }
    idx = j;
  }
  return out;
}

export function parseScoPaths(text) {
  const lines = text.split(/\r?\n/);
  const out = new Map();
  let pathIndex = 0;
  let idx = 0;
  while (idx < lines.length) {
    const tag = lines[idx].trim().toLowerCase();
    if (tag !== "[path]" && tag !== "[path_2]") {
      idx += 1;
      continue;
    }
    const vals = [];
    let j = idx + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (!t) {
        j += 1;
        continue;
      }
      if (t.startsWith("[")) break;
      const n = parseFloat(t.replace(",", "."));
      if (Number.isFinite(n)) vals.push(n);
      else break;
      j += 1;
    }
    if (vals.length >= 6) {
      out.set(pathIndex, {
        sx: vals[0],
        sy: vals[1],
        sz: vals[2],
        angle: vals[3],
        radius: vals[4],
        length: Math.abs(vals[5]) || 0.01,
        gradStart: vals[6] ?? 0,
        gradEnd: vals[7] ?? 0,
        typ: vals.length > 8 ? (vals[8] | 0) : VEHICLE_TYP,
        direction: vals.length > 10 ? (vals[10] | 0) : PATH_DIR_FORWARD,
      });
      pathIndex += 1;
    }
    idx = j;
  }
  return out;
}

function emptyBounds() {
  return { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
}

function pathsFromEntries(entries) {
  return entries?.length ? new Map(entries) : new Map();
}

const DEFAULT_SLI_PATH = [
  [0, { typ: 0, lateral: 0, height: 0, direction: PATH_DIR_BOTH }],
];

/** @param {{ sp: object, pathsEntries: [number, object][] }[]} items */
export function buildSplineRails(items) {
  const rails = [];
  const bounds = emptyBounds();
  for (const { sp, pathsEntries } of items) {
    if (sp.isInvis) continue;
    const paths = pathsFromEntries(pathsEntries);
    if (!paths.size) {
      for (const [pidx, meta] of new Map(DEFAULT_SLI_PATH)) {
        paths.set(pidx, meta);
      }
    }
    for (const [pidx, meta] of paths) {
      const lateral = sp.isMirrored ? -meta.lateral : meta.lateral;
      const points = sampleSplineRail(sp, sp.origin, {
        lateral,
        height: meta.height,
      });
      for (const p of points) expandBounds(bounds, p[0], p[2]);
      rails.push({
        id: railKey("spline", sp.id, String(pidx)),
        kind: "spline",
        elementId: sp.id,
        pathIdx: String(pidx),
        typ: meta.typ,
        vehicle: meta.typ === VEHICLE_TYP,
        direction: mirrorAdjustedDirection(meta.direction, sp.isMirrored),
        isSplineH: sp.isSplineH ?? false,
        isMirrored: sp.isMirrored ?? false,
        tile: sp.tile,
        points,
        start: points[0],
        end: points.at(-1),
        length: sp.largo,
        radius: sp.radius,
        freeStart: false,
      });
    }
  }
  return { rails, bounds };
}

/** @param {{ obj: object, origin: object, pathsEntries: [number, object][] }[]} items */
export function buildScoRails(items) {
  const rails = [];
  const bounds = emptyBounds();
  for (const { obj, origin, pathsEntries } of items) {
    const paths = pathsFromEntries(pathsEntries);
    if (!paths.size) continue;
    for (const [pidx, scoPath] of paths) {
      const points = sampleScoRail(obj, scoPath, origin);
      for (const p of points) expandBounds(bounds, p[0], p[2]);
      rails.push({
        id: railKey("object", obj.id, String(pidx)),
        kind: "object",
        elementId: obj.id,
        pathIdx: String(pidx),
        typ: scoPath.typ,
        vehicle: scoPath.typ === VEHICLE_TYP,
        direction: scoPath.direction ?? PATH_DIR_FORWARD,
        tile: obj.tile,
        points,
        start: points[0],
        end: points.at(-1),
        length: scoPath.length,
        radius: scoPath.radius,
        freeStart: false,
      });
    }
  }
  return { rails, bounds };
}

export function mergeBounds(dst, src) {
  if (!src || !Number.isFinite(src.minX)) return dst;
  dst.minX = Math.min(dst.minX, src.minX);
  dst.maxX = Math.max(dst.maxX, src.maxX);
  dst.minZ = Math.min(dst.minZ, src.minZ);
  dst.maxZ = Math.max(dst.maxZ, src.maxZ);
  return dst;
}
