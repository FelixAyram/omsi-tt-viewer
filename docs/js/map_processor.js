/**
 * Procesa carpetas OMSI 2 en el navegador (global.cfg + tiles + TTData).
 */
import {
  buildMapFileMapLazy,
  buildMapFileMapWebkit,
  buildMapFileMapWebkitCombined,
  ensureMapRootInFileMap,
} from "./omsi_browser.js?v=28";
import { readOmsiText } from "./omsi_text.js?v=28";
import {
  sampleSplineRail,
  sampleScoRail,
  expandBounds,
  dirFromRotation,
  splineLocalAt,
  perpOffset,
} from "./geometry.js?v=28";

const TILE_SIZE = 300;
const VEHICLE_TYP = 0;
const CONNECT_TOL = 0.1;
/** OMSI [path] direction: 0=adelante, 1=atrás, 2=doble (OmsiPathRules.cs). */
const PATH_DIR_FORWARD = 0;
const PATH_DIR_REVERSE = 1;
const PATH_DIR_BOTH = 2;
const MAP_GLOBAL_RE = /(?:^|\/)maps\/([^/]+)\/global\.cfg$/i;

function normPath(path) {
  return path.replace(/\\/g, "/");
}

function detectOmsiPrefix(files) {
  for (const p of files.keys()) {
    const lower = normPath(p).toLowerCase();
    for (const marker of ["maps/", "splines/", "sceneryobjects/"]) {
      const i = lower.indexOf(marker);
      if (i >= 0) return normPath(p).slice(0, i);
    }
  }
  return "";
}

function canonicalMapDirFromPath(path) {
  const m = MAP_GLOBAL_RE.exec(normPath(path));
  if (!m || m[1].startsWith("_")) return null;
  return `maps/${m[1]}`;
}

function resolveMapPrefixInFileMap(fileMap, mapDir) {
  const dir = normPath(mapDir).replace(/\/$/, "");
  const dirLower = dir.toLowerCase();
  const folder = dir.split("/").pop() || dir;

  for (const k of fileMap.keys()) {
    const n = normPath(k);
    const nl = n.toLowerCase();
    if (nl === `${dirLower}/global.cfg` || nl.endsWith(`/${dirLower}/global.cfg`)) {
      return n.slice(0, n.length - "global.cfg".length);
    }
  }

  const re = new RegExp(`(^|/)maps/${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, "i");
  for (const k of fileMap.keys()) {
    const n = normPath(k);
    const m = re.exec(n);
    if (m) {
      const start = m.index + (m[1] === "/" ? 1 : 0);
      return n.slice(0, start + `maps/${folder}/`.length);
    }
  }

  return dir.endsWith("/") ? dir : `${dir}/`;
}

function safeFloat(text, fallback = 0) {
  const v = String(text ?? "").trim().replace(",", ".");
  if (!v || v.startsWith("[")) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function readText(file) {
  return readOmsiText(file);
}

function parseTileCoords(name) {
  const m = /tile_(-?\d+)_(-?\d+)\.map/i.exec(name);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}

function tileOrigin(tx, ty, minTx, minTy) {
  return {
    x: (tx - minTx) * TILE_SIZE,
    z: (ty - minTy) * TILE_SIZE,
  };
}

function parseGlobalName(text) {
  const m = /\[name\]\s*\r?\n([^\r\n\[]+)/i.exec(text);
  return m ? m[1].trim() : "";
}

function isSplinePath(line) {
  return /\.sli$/i.test(line) && /Splines/i.test(line);
}

/** Tras cargar tiles del mapa, detecta .sli y .sco referenciados. */
export async function collectAssetRefsFromMapFiles(fileMap, mapDir) {
  const sliPaths = new Set();
  const scoPaths = new Set();
  const prefix = mapDir.replace(/\\/g, "/");
  const pfx = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const pfxLower = pfx.toLowerCase();

  for (const [path, file] of fileMap) {
    const n = normPath(path);
    if (!n.toLowerCase().startsWith(pfxLower)) continue;
    if (!/tile_-?\d+_-?\d+\.map$/i.test(n)) continue;

    const text = await readText(file);
    const lines = text.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const tag = lines[idx].trim();
      if ((tag === "[spline]" || tag === "[spline_h]") && lines[idx + 1]?.trim() === "0") {
        const sliPath = lines[idx + 2]?.trim() ?? "";
        if (isSplinePath(sliPath)) sliPaths.add(sliPath.replace(/\\/g, "/"));
      }
      if (tag === "[object]" && lines[idx + 1]?.trim() === "0") {
        const sco = lines[idx + 2]?.trim() ?? "";
        if (sco.toLowerCase().endsWith(".sco")) scoPaths.add(sco.replace(/\\/g, "/"));
      }
      if (tag === "[splineAttachement]" && lines[idx + 1]?.trim() === "0") {
        const rel = lines[idx + 2]?.trim() ?? "";
        if (rel.toLowerCase().includes("bus_stop")) scoPaths.add(rel.replace(/\\/g, "/"));
      }
    }
  }

  return { sliPaths, scoPaths };
}

function parseSplineBlock(lines, i, isSplineH = false) {
  if (lines[i]?.trim() !== "0") return null;
  const path = lines[i + 1]?.trim() ?? "";
  if (!isSplinePath(path)) return null;
  const id = lines[i + 2]?.trim() ?? "";
  const previd = lines[i + 3]?.trim() ?? "";
  let numStart = i + 4;
  if (previd !== "-1") numStart = i + 5;
  const nums = [];
  let isMirrored = false;
  let j = numStart;
  while (j < lines.length && nums.length < 20) {
    const t = lines[j]?.trim();
    if (!t) {
      j += 1;
      continue;
    }
    if (t.startsWith("[")) break;
    if (/^mirror$/i.test(t)) {
      isMirrored = true;
      j += 1;
      continue;
    }
    if (/^-?\d+([.,]\d+)?$/.test(t.replace(",", "."))) {
      nums.push(parseFloat(t.replace(",", ".")));
      j += 1;
    } else break;
  }
  if (nums.length < 5) return null;
  const largo = nums[4];
  const lastStandardIdx = isSplineH ? 12 : 11;
  const localLength = nums.length > lastStandardIdx + 1 ? nums[nums.length - 1] : largo;
  return {
    path,
    id,
    previd,
    x: nums[0],
    y: nums[2],
    z: nums[1],
    rotation: nums[3],
    largo,
    localLength,
    radius: nums[5] ?? 0,
    isMirrored,
    endIdx: j,
  };
}

/** OmsiPathRules.MirrorAdjustedTravelDirection — invierte sentido en splines mirror. */
function mirrorAdjustedDirection(direction, isMirrored) {
  if (!isMirrored) return direction ?? PATH_DIR_FORWARD;
  const dir = direction ?? PATH_DIR_FORWARD;
  if (dir === PATH_DIR_FORWARD) return PATH_DIR_REVERSE;
  if (dir === PATH_DIR_REVERSE) return PATH_DIR_FORWARD;
  return PATH_DIR_BOTH;
}

function parseSliPaths(text) {
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

function parseScoPaths(text) {
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

function isIntegerField(value) {
  const text = String(value ?? "").trim();
  if (!text || text.includes(".") || /e/i.test(text)) return false;
  return /^-?\d+$/.test(text);
}

/** Parsea [track_entry] OMSI 2.3 (global_path entero) o legado pre-2.3. */
function parseTtr(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^\s*(\d+)\s*:?\s*$/.exec(lines[i]);
    if (m && lines[i + 1]?.trim() === "[track_entry]") {
      const elementId = lines[i + 2]?.trim() ?? "";
      const pathIdx = lines[i + 3]?.trim() ?? "";
      const routeId = lines[i + 4]?.trim() ?? "";
      const fieldAfterKachel = lines[i + 5]?.trim() ?? "";
      if (isIntegerField(fieldAfterKachel)) {
        const fstrnCount = parseInt(lines[i + 7]?.trim() || "0", 10) || 0;
        const fstrnIds = [];
        for (let j = 0; j < fstrnCount; j += 1) {
          fstrnIds.push(lines[i + 8 + j]?.trim() ?? "");
        }
        entries.push({
          index: parseInt(m[1], 10),
          elementId,
          pathIdx,
          routeId,
          globalPath: fieldAfterKachel,
          distance: lines[i + 6]?.trim() ?? "",
          fstrnIds,
          formatV23: true,
        });
        i += 8 + fstrnCount;
      } else {
        entries.push({
          index: parseInt(m[1], 10),
          elementId,
          pathIdx,
          routeId,
          globalPath: "",
          distance: fieldAfterKachel,
          speed: lines[i + 6]?.trim() ?? "",
          flag: lines[i + 7]?.trim() ?? "",
          fstrnIds: [],
          formatV23: false,
        });
        i += 8;
      }
      if (i < lines.length && !lines[i]?.trim()) i += 1;
      continue;
    }
    i += 1;
  }
  return entries;
}

function defaultVehicleSplinePath(pathsMap) {
  const sorted = [...pathsMap.keys()].sort((a, b) => a - b);
  for (const idx of sorted) {
    if (pathsMap.get(idx)?.typ === VEHICLE_TYP) return idx;
  }
  return sorted[0] ?? 0;
}

/** Paths .sco: índice 0-based (igual que .sli y path_idx del .ttr). */
function normalizeObjectPath(pathsMap, pathIdxStr) {
  if (!pathsMap?.size) return pathIdxStr;
  const pidx = parseInt(pathIdxStr, 10);
  if (!Number.isFinite(pidx)) return "0";
  if (pathsMap.has(pidx)) return String(pidx);
  if (pidx < 0) return "0";
  const paths = [...pathsMap.keys()].sort((a, b) => a - b);
  let best = paths[0];
  let bestDist = Math.abs(best - pidx);
  for (const p of paths) {
    const dist = Math.abs(p - pidx);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  return String(best);
}

function normalizeSplinePath(pathsMap, pathIdxStr) {
  if (!pathsMap?.size) return pathIdxStr;
  const pidx = parseInt(pathIdxStr, 10);
  if (Number.isFinite(pidx) && pathsMap.has(pidx)) return String(pidx);
  return String(defaultVehicleSplinePath(pathsMap));
}

function resolveTrackEntryRail(entry, ctx) {
  const { splines, objects, railsById, sliCache } = ctx;
  const kind = splines.has(entry.elementId) ? "spline" : "object";
  let pathIdx = entry.pathIdx;
  let typ = VEHICLE_TYP;

  if (kind === "object") {
    const paths = objects.get(entry.elementId)?.paths;
    pathIdx = normalizeObjectPath(paths, pathIdx);
    typ = paths?.get(parseInt(pathIdx, 10))?.typ ?? VEHICLE_TYP;
  } else {
    const sp = splines.get(entry.elementId);
    const sliKey = sp?.path.replace(/\\/g, "/").toLowerCase();
    const paths = sliCache.get(sliKey) || new Map();
    pathIdx = normalizeSplinePath(paths, pathIdx);
    typ = paths.get(parseInt(pathIdx, 10))?.typ ?? VEHICLE_TYP;
  }

  const railId = railKey(kind, entry.elementId, pathIdx);
  const rail = railsById.get(railId);
  const skipped = !rail || typ !== VEHICLE_TYP;
  let skipReason = null;
  if (!rail) skipReason = "missing";
  else if (typ !== VEHICLE_TYP) skipReason = "non-vehicle";

  return {
    kind,
    pathIdx,
    originalPathIdx: entry.pathIdx,
    railId,
    typ,
    rail,
    skipped,
    skipReason,
  };
}

function parseTtpLabel(text) {
  const lines = text.split(/\r?\n/);
  let linie = "";
  let target = "";
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === "[trip]" && i + 3 < lines.length) {
      target = lines[i + 2].trim();
      linie = lines[i + 3].trim();
    }
  }
  if (linie && target) return `${linie} → ${target}`;
  return linie || target || "";
}

function railKey(kind, elementId, pathIdx) {
  return `${kind}:${elementId}:${pathIdx}`;
}

/** Índice de rutas con variantes (mayúsculas, sufijos, carpetas parciales). */
export function buildFileIndex(fileMap) {
  const index = new Map();
  for (const [rawKey, file] of fileMap) {
    const key = rawKey.replace(/\\/g, "/");
    index.set(key, file);
    index.set(key.toLowerCase(), file);
  }
  return index;
}

export function mergeFileMaps(...maps) {
  const out = new Map();
  for (const m of maps) {
    for (const [k, v] of m) out.set(k, v);
  }
  return out;
}

function resolveFile(index, relPath, omsiPrefix = "") {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const normLower = norm.toLowerCase();
  const variants = new Set([
    norm,
    normLower,
    `${omsiPrefix}${norm}`,
    `${omsiPrefix}${norm}`.toLowerCase(),
  ]);

  if (normLower.startsWith("sceneryobjects/")) {
    variants.add(norm.slice("Sceneryobjects/".length));
    variants.add(norm.slice("sceneryobjects/".length));
  } else if (normLower.includes(".sco")) {
    variants.add(`Sceneryobjects/${norm}`);
    variants.add(`sceneryobjects/${norm}`.toLowerCase());
  }

  if (normLower.startsWith("splines/")) {
    variants.add(norm.slice("Splines/".length));
    variants.add(norm.slice("splines/".length));
  } else if (normLower.includes(".sli")) {
    variants.add(`Splines/${norm}`);
    variants.add(`splines/${norm}`.toLowerCase());
  }

  for (const v of variants) {
    if (index.has(v)) return index.get(v);
  }

  let best = null;
  let bestLen = Infinity;
  for (const [k, file] of index) {
    const kl = k.toLowerCase();
    if (kl.endsWith(normLower) || kl.endsWith(`/${normLower}`)) {
      if (k.length < bestLen) {
        bestLen = k.length;
        best = file;
      }
    }
  }
  return best;
}


function pickTilePaths(files, mapDir) {
  const folder = normPath(mapDir).split("/").pop();
  const mapPrefixRe = new RegExp(
    `(^|/)maps/${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
    "i",
  );
  let tiles = [...files.keys()].filter((k) => {
    const n = normPath(k);
    return mapPrefixRe.test(n) && /tile_-?\d+_-?\d+\.map$/i.test(n);
  });
  const primary = tiles.filter((t) => !/_test_ttdata|\/copia\//i.test(normPath(t)));
  if (primary.length) tiles = primary;
  if (!tiles.length) return [];
  const minDepth = Math.min(...tiles.map((t) => normPath(t).split("/").length));
  return tiles.filter((t) => normPath(t).split("/").length === minDepth);
}

export function injectGlobalCfgIntoFileMap(fileMap, mapDir, globalFile) {
  const prefix = resolveMapPrefixInFileMap(fileMap, mapDir);
  const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const key = normPath(`${p}global.cfg`);
  fileMap.set(key, globalFile);
  return key;
}

function resolveMapContext(files, mapDir) {
  const folder = normPath(mapDir).split("/").pop();
  const mapPrefixRe = new RegExp(
    `(^|/)maps/${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
    "i",
  );

  const globalKey = [...files.keys()].find((k) => {
    const n = normPath(k);
    return mapPrefixRe.test(n) && /global\.cfg$/i.test(n);
  });
  const tilePaths = pickTilePaths(files, mapDir);

  if (globalKey && tilePaths.length > 0) {
    const globalNorm = normPath(globalKey);
    const prefix = globalNorm.slice(0, globalNorm.length - "global.cfg".length);
    return { prefix, globalKey, globalFile: files.get(globalKey), tilePaths };
  }

  const prefix = resolveMapPrefixInFileMap(files, mapDir);
  const globalKey2 = [...files.keys()].find((k) => {
    const n = normPath(k);
    return n.startsWith(prefix) && /global\.cfg$/i.test(n);
  });
  const tilePaths2 = pickTilePaths(files, mapDir);
  if (globalKey2 && tilePaths2.length > 0) {
    return { prefix, globalKey: globalKey2, globalFile: files.get(globalKey2), tilePaths: tilePaths2 };
  }

  const keysSample = [...files.keys()].slice(0, 15).join("\n  ");
  throw new Error(
    `No se encontró global.cfg con tiles en ${mapDir}. ` +
      `Usa «Elegir global.cfg…» y selecciona el archivo del mapa. ` +
      `Archivos en memoria: ${files.size}. Tiles candidatos: ${tilePaths.length}. ` +
      (keysSample ? `Muestra:\n  ${keysSample}` : "fileMap vacío."),
  );
}

function findMaps(files) {
  const maps = new Set();
  for (const path of files.keys()) {
    const canon = canonicalMapDirFromPath(path);
    if (canon) maps.add(canon);
  }
  return [...maps].sort((a, b) => {
    const na = a.split("/").pop().toLowerCase();
    const nb = b.split("/").pop().toLowerCase();
    return na.localeCompare(nb);
  });
}

function findGlobalFile(fileMap, mapDir) {
  const target = `${normPath(mapDir).replace(/\/$/, "")}/global.cfg`.toLowerCase();
  for (const [k, f] of fileMap) {
    const kn = normPath(k).toLowerCase();
    if (kn === target || kn.endsWith(`/${target}`)) return f;
  }
  return null;
}

/** Comprueba que la carpeta parece una instalación OMSI 2. */
export function validateOmsiInstall(fileMap) {
  const keys = [...fileMap.keys()].map((k) => k.replace(/\\/g, "/").toLowerCase());
  const has = (fragment) => keys.some((k) => k.includes(`/${fragment}/`) || k.startsWith(`${fragment}/`));
  const missing = [];
  if (!has("maps")) missing.push("maps/");
  if (!has("splines")) missing.push("Splines/");
  if (!has("sceneryobjects")) missing.push("Sceneryobjects/");
  if (missing.length) {
    throw new Error(
      `No parece la carpeta raíz de OMSI 2. Falta: ${missing.join(", ")}. ` +
        "Selecciona la carpeta donde está omsi.exe (ej. …/steamapps/common/OMSI 2).",
    );
  }
  const maps = findMaps(fileMap);
  if (!maps.length) {
    throw new Error("No se encontraron mapas en maps/ (global.cfg por carpeta).");
  }
  return maps.length;
}

/** Lista mapas con nombre del global.cfg para el desplegable. */
export async function listMapCatalog(fileMap) {
  const dirs = findMaps(fileMap);
  const entries = [];
  for (const dir of dirs) {
    const folder = dir.split("/").pop();
    let label = folder;
    const gf = findGlobalFile(fileMap, dir);
    if (gf) {
      try {
        const name = parseGlobalName(await readText(gf));
        if (name && name.toLowerCase() !== folder.toLowerCase()) {
          label = `${folder} — ${name}`;
        }
      } catch {
        /* usar nombre carpeta */
      }
    }
    entries.push({ dir, folder, label });
  }
  return entries;
}

/** Etiqueta legible de direction OMSI (splines .sli; .sco suele ser forward geométrico). */
export function directionLabel(direction) {
  if (direction === PATH_DIR_REVERSE) return "backward";
  if (direction === PATH_DIR_BOTH) return "both";
  return "forward";
}

/**
 * Inicio/fin de circulación según direction del [path] (0=fwd, 1=bwd, 2=both).
 * both → dos sentidos; el resto → un sentido.
 */
export function enumeratePathLegs(rail) {
  const pts = rail.points;
  if (!pts?.length) return [];
  const dir = rail.direction ?? PATH_DIR_FORWARD;
  if (dir === PATH_DIR_BOTH) {
    return [
      { leg: "fwd", start: pts[0], end: pts.at(-1) },
      { leg: "rev", start: pts.at(-1), end: pts[0] },
    ];
  }
  if (dir === PATH_DIR_REVERSE) {
    return [{ leg: "bwd", start: pts.at(-1), end: pts[0] }];
  }
  return [{ leg: "fwd", start: pts[0], end: pts.at(-1) }];
}

/** Inicio/fin principal (primer sentido de circulación). */
export function getTrafficEndpoints(rail) {
  const legs = enumeratePathLegs(rail);
  if (!legs.length) return { start: null, end: null };
  return { start: legs[0].start, end: legs[0].end };
}

function distXZ(a, b) {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

function endpointsNear(a, b, tol = CONNECT_TOL) {
  return a && b && distXZ(a, b) <= tol;
}

/**
 * Enumera todos los paths (.sli + .sco) con posición de inicio/fin de circulación.
 * Candidato a inicio libre: ningún otro path termina a ≤10 cm de donde este path inicia.
 */
export function findFreeStartCandidates(rails, { tolerance = CONNECT_TOL } = {}) {
  const legs = [];
  for (const rail of rails) {
    for (const leg of enumeratePathLegs(rail)) {
      legs.push({
        railId: rail.id,
        kind: rail.kind,
        elementId: rail.elementId,
        pathIdx: rail.pathIdx,
        typ: rail.typ,
        direction: rail.direction,
        directionLabel: directionLabel(rail.direction),
        legKey: leg.leg,
        start: leg.start,
        end: leg.end,
      });
    }
  }

  const ends = legs.map((entry) => ({
    railId: entry.railId,
    legKey: entry.legKey,
    point: entry.end,
  }));

  return legs.map((entry) => {
    let incomingCount = 0;
    const incomingFrom = [];
    for (const o of ends) {
      if (o.railId === entry.railId && o.legKey === entry.legKey) continue;
      if (!endpointsNear(o.point, entry.start, tolerance)) continue;
      incomingCount += 1;
      incomingFrom.push(o.railId);
    }
    return {
      ...entry,
      isFreeStart: incomingCount === 0,
      incomingCount,
      incomingFrom,
    };
  });
}

/** IDs de paths con al menos un sentido de circulación sin entrada (±10 cm). */
export function findFreeStartIds(rails, opts) {
  const ids = new Set();
  for (const c of findFreeStartCandidates(rails, opts)) {
    if (c.isFreeStart) ids.add(c.railId);
  }
  return ids;
}

function buildSplineAxisEnds(splines) {
  const out = new Map();
  for (const sp of splines.values()) {
    if (sp.isInvis) continue;
    const pts = sampleSplineRail(sp, sp.origin, { lateral: 0, height: 0 });
    if (pts.length >= 2) out.set(sp.id, { start: pts[0], end: pts.at(-1) });
  }
  return out;
}

function nearestAxisSide(point, axis) {
  if (!point || !axis) return null;
  return distXZ(point, axis.start) <= distXZ(point, axis.end) ? "start" : "end";
}

/** Cierra inicios en cruces: carril reverse que termina en un extremo del spline. */
function sameSplineReverseEndClosesForwardStart(entry, other, splineAxis) {
  if (entry.kind !== "spline" || other.kind !== "spline") return false;
  if (entry.elementId !== other.elementId) return false;
  if (other.direction !== PATH_DIR_REVERSE || entry.direction !== PATH_DIR_FORWARD) return false;
  const axis = splineAxis.get(entry.elementId);
  if (!axis) return false;
  return nearestAxisSide(entry.start, axis) === nearestAxisSide(other.end, axis);
}

function buildPathLegEntries(rails) {
  const legs = [];
  for (const rail of rails) {
    for (const leg of enumeratePathLegs(rail)) {
      legs.push({
        railId: rail.id,
        kind: rail.kind,
        elementId: rail.elementId,
        pathIdx: rail.pathIdx,
        typ: rail.typ,
        direction: rail.direction,
        legKey: leg.leg,
        start: leg.start,
        end: leg.end,
      });
    }
  }
  return legs;
}

function isCirculationStartOpen(entry, allLegs, splineAxis, tolerance = CONNECT_TOL) {
  for (const other of allLegs) {
    if (other.railId === entry.railId && other.legKey === entry.legKey) continue;
    if (endpointsNear(other.end, entry.start, tolerance)) return false;
    if (sameSplineReverseEndClosesForwardStart(entry, other, splineAxis)) return false;
  }
  return true;
}

/**
 * Spawn tráfico OMSI en splines [spline] vehículo (typ 0):
 * - Solo sentido efectivo backward (direction=1, o forward+mirror en .map)
 * - Inicio de circulación abierto (±10 cm; cierra reverse→forward mismo spline)
 */
export function findOmsiVehicleSpawnRails(rails, splines) {
  const splineAxis = buildSplineAxisEnds(splines);
  const allLegs = buildPathLegEntries(rails);
  const spawn = new Map();

  for (const rail of rails) {
    if (rail.kind !== "spline" || rail.typ !== VEHICLE_TYP) continue;
    const sp = splines.get(rail.elementId);
    if (!sp || sp.isSplineH) continue;

    const entry = allLegs.find((l) => l.railId === rail.id);
    if (!entry) continue;

    if (rail.direction !== PATH_DIR_REVERSE) continue;
    if (!isCirculationStartOpen(entry, allLegs, splineAxis)) continue;
    spawn.set(rail.id, { point: entry.start, atEnd: false });
  }
  return spawn;
}

function parseAttachmentName(lines, startIdx) {
  let name = "";
  for (let j = startIdx; j < Math.min(startIdx + 16, lines.length); j += 1) {
    const t = lines[j]?.trim();
    if (!t || t.startsWith("[")) break;
    if (/^-?\d+([.,]\d+)?([eE][+-]?\d+)?$/.test(t.replace(",", "."))) continue;
    if (t.toLowerCase().endsWith(".sco")) continue;
    name = t;
  }
  return name;
}

function resolveBusstopParentSpline(stop, splines, splineOrderByTile) {
  const order = splineOrderByTile.get(stop.tile);
  if (order && stop.splineListIndex >= 0 && stop.splineListIndex < order.length) {
    const sid = order[stop.splineListIndex];
    if (splines.has(sid)) return sid;
  }
  if (!order?.length) return "";
  let bestId = "";
  let bestScore = Infinity;
  for (const sid of order) {
    const sp = splines.get(sid);
    if (!sp || sp.largo <= 0) continue;
    if (stop.distAlong > sp.largo + 2) continue;
    const score = Math.abs(stop.distAlong - Math.min(stop.distAlong, sp.largo));
    if (score < bestScore) {
      bestScore = score;
      bestId = sid;
    }
  }
  return bestId;
}

function busstopWorld(graph, stop, splines, splineOrderByTile) {
  const tile = parseTileCoords(stop.tile);
  const tileOriginPt = tile ? tileOrigin(tile[0], tile[1], graph.minTx, graph.minTy) : { x: 0, z: 0 };
  const sid = resolveBusstopParentSpline(stop, splines, splineOrderByTile);
  const spline = sid ? splines.get(sid) : null;
  if (spline) {
    const o = spline.origin || tileOriginPt;
    const localLength = spline.localLength ?? 0;
    let along = (stop.distAlong || 0) - localLength;
    along = Math.max(0, Math.min(spline.largo, along));
    const local = splineLocalAt(
      spline.x,
      spline.y,
      spline.rotation,
      spline.radius,
      along,
      spline.z,
    );
    const dir = dirFromRotation(local.rot);
    const lat = spline.isMirrored ? -(stop.lateral || 0) : stop.lateral || 0;
    const off = perpOffset(dir, lat);
    return {
      x: o.x + local.x + off.x,
      y: local.z + (stop.heightOff || 0),
      z: o.z + local.y + off.z,
    };
  }
  return { x: tileOriginPt.x + stop.x, y: stop.z + (stop.heightOff || 0), z: tileOriginPt.z + stop.y };
}

/**
 * @param {Map<string, File>} fileMap path relativo → File
 * @param {string} mapDir prefijo carpeta mapa (ej. maps/Test_Lat30)
 * @param {(msg:string)=>void} onProgress
 */
export async function processMapFolder(fileMap, mapDir, onProgress = () => {}) {
  const ctx = resolveMapContext(fileMap, mapDir);
  const prefix = ctx.prefix;
  const omsiPrefix = detectOmsiPrefix(fileMap);
  const index = buildFileIndex(fileMap);

  onProgress("Leyendo global.cfg…");
  const globalText = await readText(ctx.globalFile);
  const mapName = parseGlobalName(globalText) || mapDir.split("/").pop();

  const tileFiles = ctx.tilePaths ?? [...fileMap.keys()].filter((p) => {
    const n = normPath(p);
    return n.toLowerCase().startsWith(prefix.toLowerCase()) && /tile_-?\d+_-?\d+\.map$/i.test(n);
  });
  if (!tileFiles.length) throw new Error("No hay tiles tile_*.map en la carpeta.");

  const tileCoords = tileFiles.map((f) => parseTileCoords(f.split("/").pop())).filter(Boolean);
  const minTx = Math.min(...tileCoords.map((c) => c[0]));
  const minTy = Math.min(...tileCoords.map((c) => c[1]));

  const splines = new Map();
  const objects = new Map();
  const busstops = [];
  const splineOrderByTile = new Map();
  const sliCache = new Map();
  const scoCache = new Map();
  let sliFound = 0;
  let sliMissing = 0;
  let scoFound = 0;
  let scoMissing = 0;

  onProgress(`Parseando ${tileFiles.length} tiles…`);
  for (const tilePath of tileFiles) {
    const tileName = tilePath.split("/").pop();
    const text = await readText(fileMap.get(tilePath));
    const lines = text.split(/\r?\n/);
    const coords = parseTileCoords(tileName);
    const origin = tileOrigin(coords[0], coords[1], minTx, minTy);
    const splineOrder = [];

    for (let idx = 0; idx < lines.length; idx += 1) {
      const tag = lines[idx].trim();
      if (tag === "[object]" && lines[idx + 1]?.trim() === "0") {
        const rel = lines[idx + 2]?.trim() ?? "";
        const oid = lines[idx + 3]?.trim() ?? "";
        if (oid && rel.toLowerCase().endsWith(".sco")) {
          objects.set(oid, {
            id: oid,
            scoRel: rel,
            tile: tileName,
            x: safeFloat(lines[idx + 4]),
            y: safeFloat(lines[idx + 5]),
            z: safeFloat(lines[idx + 6]),
            rotation: safeFloat(lines[idx + 7]),
            paths: null,
          });
        }
        idx += 1;
        continue;
      }

      if (tag === "[splineAttachement]" && lines[idx + 1]?.trim() === "0") {
        const rel = lines[idx + 2]?.trim() ?? "";
        const oid = lines[idx + 3]?.trim() ?? "";
        if (oid && rel.toLowerCase().includes("bus_stop")) {
          const splineListIndex = parseInt(lines[idx + 4]?.trim() ?? "0", 10) || 0;
          const name = parseAttachmentName(lines, idx + 9);
          busstops.push({
            id: oid,
            name: name || `Parada ${oid}`,
            tile: tileName,
            splineListIndex,
            lateral: safeFloat(lines[idx + 5]),
            heightOff: safeFloat(lines[idx + 6]),
            distAlong: safeFloat(lines[idx + 7]),
            rotation: safeFloat(lines[idx + 8]),
          });
        }
        idx += 1;
        continue;
      }

      if ((tag === "[spline]" || tag === "[spline_h]") && lines[idx + 1]?.trim() === "0") {
        const block = parseSplineBlock(lines, idx + 1, tag === "[spline_h]");
        if (block) {
          splineOrder.push(block.id);
          splines.set(block.id, {
            ...block,
            tile: tileName,
            origin,
            isSplineH: tag === "[spline_h]",
            isInvis: block.path.toLowerCase().includes("invis"),
          });
        }
      }
    }
    splineOrderByTile.set(tileName, splineOrder);
  }

  onProgress("Cargando paths .sli…");
  for (const sp of splines.values()) {
    const key = sp.path.replace(/\\/g, "/").toLowerCase();
    if (sliCache.has(key)) continue;
    const file = resolveFile(index, sp.path, omsiPrefix);
    if (file) {
      sliCache.set(key, parseSliPaths(await readText(file)));
      sliFound += 1;
    } else {
      sliCache.set(key, new Map([[0, { typ: 0, lateral: 0, height: 0, direction: 2 }]]));
      sliMissing += 1;
    }
  }

  onProgress("Cargando paths .sco…");
  const scoNeeded = new Set();
  for (const obj of objects.values()) scoNeeded.add(obj.scoRel.replace(/\\/g, "/").toLowerCase());

  for (const relLower of scoNeeded) {
    const rel = [...objects.values()].find((o) => o.scoRel.replace(/\\/g, "/").toLowerCase() === relLower)?.scoRel;
    if (!rel) continue;
    const key = rel.replace(/\\/g, "/").toLowerCase();
    if (scoCache.has(key)) continue;
    const file = resolveFile(index, rel, omsiPrefix);
    if (file) {
      scoCache.set(key, parseScoPaths(await readText(file)));
      scoFound += 1;
    } else {
      scoCache.set(key, new Map());
      scoMissing += 1;
    }
  }

  for (const obj of objects.values()) {
    const key = obj.scoRel.replace(/\\/g, "/").toLowerCase();
    obj.paths = scoCache.get(key) || new Map();
  }

  onProgress("Generando rieles…");
  const rails = [];
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };

  for (const sp of splines.values()) {
    if (sp.isInvis) continue;
    const sliKey = sp.path.replace(/\\/g, "/").toLowerCase();
    const paths = sliCache.get(sliKey) || new Map([[0, { typ: 0, lateral: 0, height: 0, direction: 2 }]]);
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

  for (const obj of objects.values()) {
    if (!obj.paths?.size) continue;
    const coords = parseTileCoords(obj.tile);
    const origin = tileOrigin(coords[0], coords[1], minTx, minTy);
    for (const [pidx, scoPath] of obj.paths) {
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

  const startCandidates = findFreeStartCandidates(rails);
  const omsiSpawn = findOmsiVehicleSpawnRails(rails, splines);
  const freeIds = new Set(omsiSpawn.keys());
  for (const r of rails) {
    const ep = getTrafficEndpoints(r);
    r.trafficStart = ep.start;
    r.trafficEnd = ep.end;
    r.directionLabel = directionLabel(r.direction);
    r.freeStart = freeIds.has(r.id);
    r.omsiSpawn = freeIds.has(r.id);
    const spawn = omsiSpawn.get(r.id);
    if (spawn) r.trafficStart = spawn.point;
  }

  const pathLegs = startCandidates.map((c) => ({
    id: c.railId,
    kind: c.kind,
    leg: c.legKey,
    direction: c.directionLabel,
    start: c.start,
    end: c.end,
    isFreeStart: c.isFreeStart,
    isOmsiSpawn: omsiSpawn.has(c.railId),
    incomingCount: c.incomingCount,
  }));

  onProgress("Paradas…");
  const busstopOut = busstops.map((s) => {
    const parentSpline = resolveBusstopParentSpline(s, splines, splineOrderByTile);
    const w = busstopWorld({ minTx, minTy }, s, splines, splineOrderByTile);
    expandBounds(bounds, w.x, w.z);
    return {
      id: s.id,
      name: s.name,
      x: w.x,
      y: w.y,
      z: w.z,
      rotation: s.rotation,
      splineListIndex: s.splineListIndex,
      parentSpline,
      distAlong: s.distAlong,
      lateral: s.lateral,
    };
  });

  onProgress("Rutas TTData…");
  const routes = [];
  const ttrLabels = new Map();
  for (const [path, file] of fileMap) {
    if (!path.replace(/\\/g, "/").startsWith(prefix) || !/\.ttp$/i.test(path)) continue;
    const ttpText = await readText(file);
    const ttpLines = ttpText.split(/\r?\n/);
    let trackName = "";
    let label = "";
    for (let i = 0; i < ttpLines.length; i += 1) {
      if (ttpLines[i].trim() === "[trip]" && i + 3 < ttpLines.length) {
        trackName = ttpLines[i + 1].trim();
        label = parseTtpLabel(ttpText);
        break;
      }
    }
    if (trackName) {
      const ttrFile = trackName.toLowerCase().endsWith(".ttr") ? trackName : `${trackName}.ttr`;
      const ttrPath = `${path.replace(/[^/]+$/, ttrFile)}`.replace(/\\/g, "/");
      ttrLabels.set(ttrPath, label || ttrFile);
    }
  }

  const seenTtr = new Set();
  for (const [path, file] of fileMap) {
    if (!path.replace(/\\/g, "/").startsWith(prefix) || !/\.ttr$/i.test(path)) continue;
    const norm = path.replace(/\\/g, "/");
    if (seenTtr.has(norm)) continue;
    seenTtr.add(norm);
    const entries = parseTtr(await readText(file));
    const railsById = new Map(rails.map((r) => [r.id, r]));
    const resolveCtx = { splines, objects, railsById, sliCache };
    const used = new Set();
    const enriched = entries.map((e) => {
      const resolved = resolveTrackEntryRail(e, resolveCtx);
      if (!resolved.skipped) used.add(resolved.railId);
      return { ...e, ...resolved };
    });
    const skippedCount = enriched.filter((e) => e.skipped).length;
    routes.push({
      id: norm.slice(prefix.length),
      file: norm.split("/").pop(),
      label: ttrLabels.get(norm) || norm.split("/").pop(),
      entries: enriched,
      railIds: [...used].sort(),
      entryCount: entries.length,
      skippedCount,
    });
  }

  if (!Number.isFinite(bounds.minX)) {
    bounds.minX = bounds.maxX = bounds.minZ = bounds.maxZ = 0;
  }

  let progressMsg = "Listo.";
  if (sliMissing > 0 || scoMissing > 0) {
    progressMsg =
      `Listo (${rails.length} rieles). Faltan assets: ${sliMissing} .sli, ${scoMissing} .sco — ` +
      "añade carpetas Splines y Sceneryobjects de OMSI 2, o usa el mapa precargado.";
  } else {
    progressMsg = `Listo — ${rails.length} rieles (${sliFound} .sli, ${scoFound} .sco).`;
  }
  onProgress(progressMsg);

  return {
    version: 2,
    mapName,
    bounds,
    rails,
    busstops: busstopOut,
    routes,
    stats: {
      railCount: rails.length,
      freeStartCount: freeIds.size,
      omsiSpawnCount: freeIds.size,
      freeLegCount: startCandidates.filter((c) => c.isFreeStart).length,
      pathLegCount: startCandidates.length,
      connectToleranceM: CONNECT_TOL,
      busstopCount: busstopOut.length,
      routeCount: routes.length,
      sliFound,
      sliMissing,
      scoFound,
      scoMissing,
      splineCount: splines.size,
      objectCount: objects.size,
    },
    pathLegs,
  };
}

export async function loadFilesFromInput(fileList) {
  const map = new Map();
  for (const f of fileList) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, "/");
    if (rel) map.set(rel, f);
  }
  return map;
}

/** Carga lazy: tiles del mapa → refs en .map → .sli/.sco → procesar. */
export async function loadMapLazy(omsiRoot, mapDir, onProgress = () => {}, loadOptions = {}) {
  const globalCfgFile = loadOptions.globalCfgFile;
  if (!globalCfgFile) {
    throw new Error(
      "Falta global.cfg. Pulsa «Elegir global.cfg…» y abre el archivo dentro de la carpeta del mapa.",
    );
  }

  let fileMap;
  if (omsiRoot.mode === "fsa") {
    fileMap = await buildMapFileMapLazy(
      omsiRoot.rootHandle,
      mapDir,
      collectAssetRefsFromMapFiles,
      onProgress,
    );
  } else if (omsiRoot.mode === "fsa-combined") {
    fileMap = await buildMapFileMapLazy(
      omsiRoot.rootHandle,
      mapDir,
      collectAssetRefsFromMapFiles,
      onProgress,
      omsiRoot.mapHandle,
    );
  } else if (omsiRoot.mode === "webkit-combined") {
    fileMap = await buildMapFileMapWebkitCombined(
      omsiRoot.mapFileMap,
      omsiRoot.assetFileMap,
      mapDir,
      collectAssetRefsFromMapFiles,
      onProgress,
    );
  } else {
    fileMap = await buildMapFileMapWebkit(
      omsiRoot.fileMap,
      mapDir,
      collectAssetRefsFromMapFiles,
      onProgress,
    );
  }
  if (omsiRoot.mode === "fsa" || omsiRoot.mode === "fsa-combined") {
    await ensureMapRootInFileMap(omsiRoot.rootHandle, mapDir, fileMap);
  }
  injectGlobalCfgIntoFileMap(fileMap, mapDir, globalCfgFile);
  return processMapFolder(fileMap, mapDir, onProgress);
}

export function listMapsInFiles(fileMap) {
  return findMaps(fileMap);
}

export { detectOmsiPrefix, findMaps };
