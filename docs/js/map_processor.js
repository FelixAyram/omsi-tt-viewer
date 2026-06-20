/**
 * Procesa carpetas OMSI 2 en el navegador (global.cfg + tiles + TTData).
 */
import {
  buildMapFileMapLazy,
  buildMapFileMapWebkit,
  buildMapFileMapWebkitCombined,
  ensureMapRootInFileMap,
} from "./omsi_browser.js?v=46";
import { readOmsiAnsiText, readOmsiText } from "./omsi_text.js?v=46";
import {
  expandBounds,
  dirFromRotation,
  splineLocalAt,
  perpOffset,
} from "./geometry.js?v=46";
import { runInParallel, ioConcurrency, hardwareThreads } from "./parallel.js?v=46";
import {
  VEHICLE_TYP,
  PATH_DIR_FORWARD,
  PATH_DIR_REVERSE,
  PATH_DIR_BOTH,
  railKey,
  parseSliPaths,
  parseSliFile,
  parseScoPaths,
  buildSplineRails,
  buildScoRails,
  mergeBounds,
} from "./rail_builder.js?v=46";
import { createMapWorkerPool, defaultPoolSize } from "./workers/worker_pool.js?v=46";

/** Métricas OMSI según motor (maps.c / FUN_007f283c). */
const STANDARD_TILE_M = 300;
const WORLD_EQUATOR_TILE_M = 611.5;
const WGS84_R_M = 6378137;
const CONNECT_TOL = 0.1;
const IO_CONCURRENCY = ioConcurrency();
const ENDPOINT_CELL_M = 2;
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

function readAnsiText(file) {
  return readOmsiAnsiText(file);
}

function parseTileCoords(name) {
  const m = /tile_(-?\d+)_(-?\d+)\.map/i.exec(name);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}

function isGlobalCoordinateTileName(stem) {
  if (!stem || stem.toLowerCase().startsWith("tile_")) return false;
  if (stem.length < 5) return false;
  return /^\d+$/.test(stem);
}

function parseLatitudeFromGlobalTileName(stem) {
  if (!isGlobalCoordinateTileName(stem)) return null;
  const code = Number.parseInt(stem, 10);
  if (!Number.isFinite(code)) return null;
  if (code >= 100000) return code / 10000;
  if (code >= 10000) return code / 1000;
  return null;
}

function hasWorldCoordinates(globalText) {
  return /^\s*\[worldcoordinates\]\s*$/im.test(globalText);
}

function latitudeFromGridY(tileY) {
  const mercY = tileY * WORLD_EQUATOR_TILE_M;
  const latRad = 2 * Math.atan(Math.exp(mercY / WGS84_R_M)) - Math.PI / 2;
  return (latRad * 180) / Math.PI;
}

function tileSizeFromGridY(tileY) {
  const latRad = (latitudeFromGridY(tileY) * Math.PI) / 180;
  return WORLD_EQUATOR_TILE_M * Math.cos(latRad);
}

function computeTileSizeMeters({
  latitudeDeg = 0,
  gridY = null,
  isNumericGlobal = false,
  worldCoordinates = false,
  manualOverride = 0,
} = {}) {
  if (manualOverride > 0.01) return manualOverride;
  if (isNumericGlobal) {
    return WORLD_EQUATOR_TILE_M * Math.cos((latitudeDeg * Math.PI) / 180);
  }
  if (worldCoordinates && gridY != null) return tileSizeFromGridY(gridY);
  return STANDARD_TILE_M;
}

function parseMapEntriesFromGlobalCfg(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const entries = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().toLowerCase() !== "[map]") {
      i += 1;
      continue;
    }
    const vals = [];
    let j = i + 1;
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
    if (vals.length >= 3) {
      const x = parseInt(vals[0], 10);
      const y = parseInt(vals[1], 10);
      const rel = vals[2].replace(/\\/g, "/");
      if (Number.isFinite(x) && Number.isFinite(y) && rel) {
        entries.push({ x, y, relativePath: rel, fileName: rel.split("/").pop() });
      }
    }
    i = j;
  }
  return entries;
}

function applyTileMetric(entry, mapWorldCoordinates = false, manualOverride = 0) {
  const stem = (entry.fileName || "").replace(/\.map$/i, "");
  const isNumericGlobal = isGlobalCoordinateTileName(stem);
  const worldCoordinates = mapWorldCoordinates && !isNumericGlobal;
  const latFromName = parseLatitudeFromGlobalTileName(stem);
  let latitudeDeg = 0;
  let tileSizeM = STANDARD_TILE_M;

  if (manualOverride > 0.01) {
    tileSizeM = manualOverride;
  } else if (isNumericGlobal) {
    latitudeDeg = latFromName ?? 0;
    tileSizeM = computeTileSizeMeters({ latitudeDeg, isNumericGlobal: true });
  } else if (worldCoordinates) {
    latitudeDeg = latitudeFromGridY(entry.y);
    tileSizeM = tileSizeFromGridY(entry.y);
  }

  return {
    ...entry,
    isGlobal: isNumericGlobal,
    worldCoordinates,
    latitudeDeg,
    tileSizeM,
    layoutWorldX: 0,
    layoutWorldZ: 0,
  };
}

function applyWorldLayout(metrics, fallbackM = STANDARD_TILE_M) {
  if (!metrics.length) return metrics;
  const grid = new Map();
  let minX = Infinity;
  let minY = Infinity;
  const fallback = fallbackM > 0.01 ? fallbackM : STANDARD_TILE_M;
  for (const m of metrics) {
    if (m.tileSizeM < 0.01) m.tileSizeM = fallback;
    grid.set(`${m.x},${m.y}`, m);
    minX = Math.min(minX, m.x);
    minY = Math.min(minY, m.y);
  }
  for (const m of metrics) {
    let originX = 0;
    let originZ = 0;
    for (let x = minX; x < m.x; x += 1) {
      originX += grid.get(`${x},${m.y}`)?.tileSizeM ?? fallback;
    }
    for (let y = minY; y < m.y; y += 1) {
      originZ += grid.get(`${m.x},${y}`)?.tileSizeM ?? fallback;
    }
    m.layoutWorldX = originX;
    m.layoutWorldZ = originZ;
  }
  return metrics;
}

function getTileOriginFromMetric(metric, minTx, minTy, legacyUniform = STANDARD_TILE_M) {
  if (
    metric.layoutWorldX > 0.001 ||
    metric.layoutWorldZ > 0.001 ||
    metric.isGlobal ||
    metric.worldCoordinates
  ) {
    return { x: metric.layoutWorldX, z: metric.layoutWorldZ };
  }
  const size = legacyUniform > 0.01 ? legacyUniform : STANDARD_TILE_M;
  return { x: (metric.x - minTx) * size, z: (metric.y - minTy) * size };
}

function buildTileLayoutMap(globalText, tileFiles) {
  const mapWorldCoordinates = hasWorldCoordinates(globalText);
  const cfgEntries = parseMapEntriesFromGlobalCfg(globalText);
  let metrics = [];
  if (cfgEntries.length) {
    metrics = cfgEntries.map((e) => applyTileMetric(e, mapWorldCoordinates));
  } else {
    for (const tilePath of tileFiles) {
      const fileName = tilePath.split("/").pop();
      const coords = parseTileCoords(fileName);
      if (!coords) continue;
      metrics.push(
        applyTileMetric(
          { x: coords[0], y: coords[1], relativePath: fileName, fileName },
          mapWorldCoordinates,
        ),
      );
    }
  }
  applyWorldLayout(metrics);
  const byName = new Map();
  for (const m of metrics) byName.set(m.fileName.toLowerCase(), m);
  const classicTileCount = metrics.filter((m) => !m.isGlobal && !m.worldCoordinates).length;
  const globalTileCount = metrics.filter((m) => m.isGlobal).length;
  const worldGridTileCount = metrics.filter((m) => m.worldCoordinates).length;
  const sampleWorld =
    mapWorldCoordinates && worldGridTileCount
      ? metrics.find((m) => m.worldCoordinates)
      : null;
  const sampleGlobal = metrics.find((m) => m.isGlobal);
  const sample = sampleWorld ?? sampleGlobal;
  return {
    byName,
    classicTileCount,
    globalTileCount,
    worldGridTileCount,
    worldCoordinates: mapWorldCoordinates,
    tileSizeM: sample?.tileSizeM ?? STANDARD_TILE_M,
    mapLatitude: sample?.latitudeDeg ?? null,
    sampleGridY: sample?.y ?? null,
  };
}

function parseGlobalName(text) {
  const m = /\[name\]\s*\r?\n([^\r\n\[]+)/i.exec(text);
  return m ? m[1].trim() : "";
}

function isSplinePath(line) {
  return /\.sli$/i.test(line) && /Splines/i.test(line);
}

function scanTileAssetRefs(text) {
  const sliPaths = new Set();
  const scoPaths = new Set();
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
      if (scoPathLooksBusstop(rel)) scoPaths.add(rel.replace(/\\/g, "/"));
    }
  }
  return { sliPaths, scoPaths };
}

/** Tras cargar tiles del mapa, detecta .sli y .sco referenciados. */
export async function collectAssetRefsFromMapFiles(fileMap, mapDir) {
  const sliPaths = new Set();
  const scoPaths = new Set();
  const prefix = mapDir.replace(/\\/g, "/");
  const pfx = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const pfxLower = pfx.toLowerCase();

  const tileEntries = [...fileMap.entries()].filter(([path]) => {
    const n = normPath(path);
    return n.toLowerCase().startsWith(pfxLower) && /tile_-?\d+_-?\d+\.map$/i.test(n);
  });

  const texts = await runInParallel(
    tileEntries,
    async ([, file]) => readText(file),
    IO_CONCURRENCY,
  );

  for (const text of texts) {
    const refs = scanTileAssetRefs(text);
    for (const p of refs.sliPaths) sliPaths.add(p);
    for (const p of refs.scoPaths) scoPaths.add(p);
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

function pathTypName(typ) {
  if (typ === 0) return "carretera (bus/coche)";
  if (typ === 1) return "peatón";
  if (typ === 2) return "tranvía/tren";
  if (typ === 3) return "aeronave";
  return `tipo ${typ}`;
}

function formatSkippedTrackEntry(entry) {
  const ref = `${entry.kind} ${entry.elementId} · path ${entry.originalPathIdx ?? entry.pathIdx}`;
  if (entry.skipReason === "missing") {
    return (
      `#${entry.index}: riel no encontrado (${ref}) — spline/objeto o path_idx ausente en el mapa`
    );
  }
  if (entry.skipReason === "non-vehicle") {
    return (
      `#${entry.index}: no es carretera, typ=${entry.typ} ${pathTypName(entry.typ)} (${ref}) — ` +
      "las rutas .ttr de bus solo usan typ=0; OMSI lo ignora aquí"
    );
  }
  return `#${entry.index}: omitido (${ref})`;
}

function buildSkippedEntries(enriched) {
  return enriched
    .filter((e) => e.skipped)
    .map((e) => ({
      index: e.index,
      elementId: e.elementId,
      pathIdx: e.originalPathIdx,
      kind: e.kind,
      typ: e.typ,
      skipReason: e.skipReason,
      label: formatSkippedTrackEntry(e),
    }));
}

function endpointCellKey(x, z, cellSize) {
  return `${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`;
}

function buildEndpointIndex(points, cellSize = ENDPOINT_CELL_M) {
  const buckets = new Map();
  for (const item of points) {
    if (!item.point) continue;
    const key = endpointCellKey(item.point[0], item.point[2], cellSize);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  return { buckets, cellSize };
}

function nearbyIndexedPoints(index, point, radiusCells = 1) {
  if (!point) return [];
  const { buckets, cellSize } = index;
  const cx = Math.floor(point[0] / cellSize);
  const cz = Math.floor(point[2] / cellSize);
  const out = [];
  for (let dx = -radiusCells; dx <= radiusCells; dx += 1) {
    for (let dz = -radiusCells; dz <= radiusCells; dz += 1) {
      const bucket = buckets.get(`${cx + dx},${cz + dz}`);
      if (bucket) out.push(...bucket);
    }
  }
  return out;
}

function railBatchSize(itemCount, poolSize) {
  if (itemCount <= 0) return 40;
  const workers = poolSize || defaultPoolSize();
  const targetTasks = Math.max(workers * 16, 64);
  return Math.max(10, Math.min(80, Math.ceil(itemCount / targetTasks)));
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
    const cached = sliCache.get(sliKey);
    const paths = cached?.size ? cached : DEFAULT_SLI_PATHS;
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
  const endIndex = buildEndpointIndex(ends);

  return legs.map((entry) => {
    let incomingCount = 0;
    const incomingFrom = [];
    for (const o of nearbyIndexedPoints(endIndex, entry.start)) {
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
    const o = sp.origin;
    const startLocal = splineLocalAt(sp.x, sp.y, sp.rotation, sp.radius, 0, sp.z);
    const endLocal = splineLocalAt(sp.x, sp.y, sp.rotation, sp.radius, sp.largo, sp.z);
    out.set(sp.id, {
      start: [o.x + startLocal.x, startLocal.z, o.z + startLocal.y],
      end: [o.x + endLocal.x, endLocal.z, o.z + endLocal.y],
    });
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

function isCirculationStartOpen(entry, allLegs, splineAxis, endIndex, tolerance = CONNECT_TOL) {
  for (const other of nearbyIndexedPoints(endIndex, entry.start)) {
    if (other.railId === entry.railId && other.legKey === entry.legKey) continue;
    if (!endpointsNear(other.point, entry.start, tolerance)) continue;
    return false;
  }
  for (const other of allLegs) {
    if (other.railId === entry.railId && other.legKey === entry.legKey) continue;
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
  const legByRailId = new Map();
  for (const leg of allLegs) {
    if (!legByRailId.has(leg.railId)) legByRailId.set(leg.railId, leg);
  }
  const endIndex = buildEndpointIndex(
    allLegs.map((leg) => ({ railId: leg.railId, legKey: leg.legKey, point: leg.end })),
  );
  const spawn = new Map();

  for (const rail of rails) {
    if (rail.kind !== "spline" || rail.typ !== VEHICLE_TYP) continue;
    const sp = splines.get(rail.elementId);
    if (!sp || sp.isSplineH) continue;

    const entry = legByRailId.get(rail.id);
    if (!entry) continue;

    if (rail.direction !== PATH_DIR_REVERSE) continue;
    if (!isCirculationStartOpen(entry, allLegs, splineAxis, endIndex)) continue;
    spawn.set(rail.id, { point: entry.start, atEnd: false });
  }
  return spawn;
}

function scoPathLooksBusstop(scoRel) {
  const rel = (scoRel || "").replace(/\\/g, "/").toLowerCase();
  if (/\/bus_stop\.sco$/i.test(rel)) return true;
  if (/busstop/i.test(rel) && !/routearrow/i.test(rel) && !/timetable/i.test(rel)) return true;
  return false;
}

function scoIsBusstop(scoRel, scoText) {
  if (scoPathLooksBusstop(scoRel)) return true;
  return /^\[busstop\]\s*$/im.test(scoText || "");
}

function dedupeBusstopsByPosition(busstops, graph, splines, splineOrderByTile, eps = 1.5) {
  const kept = [];
  const seen = new Set();
  for (const s of busstops) {
    const w = busstopWorld(graph, s, splines, splineOrderByTile);
    const key = `${Math.round(w.x / eps)},${Math.round(w.z / eps)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(s);
  }
  return kept;
}

function appendStandaloneObjectBusstops(objects, scoBusstopFlags, busstops) {
  const seen = new Set(busstops.map((s) => s.id));
  for (const obj of objects.values()) {
    if (seen.has(obj.id)) continue;
    const key = obj.scoRel.replace(/\\/g, "/").toLowerCase();
    if (!scoBusstopFlags.get(key)) continue;
    busstops.push({
      id: obj.id,
      name: obj.name || `Parada ${obj.id}`,
      tile: obj.tile,
      splineListIndex: -1,
      lateral: 0,
      heightOff: 0,
      distAlong: 0,
      rotation: obj.rotation,
      standalone: true,
      x: obj.x,
      y: obj.y,
      z: obj.z,
    });
    seen.add(obj.id);
  }
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
  const metric = graph.tileLayout?.byName?.get(stop.tile.toLowerCase());
  const tileOriginPt = metric
    ? getTileOriginFromMetric(metric, graph.minTx, graph.minTy)
    : tile
      ? getTileOriginFromMetric(
          { x: tile[0], y: tile[1], layoutWorldX: 0, layoutWorldZ: 0, isGlobal: false },
          graph.minTx,
          graph.minTy,
        )
      : { x: 0, z: 0 };
  if (stop.standalone) {
    return {
      x: tileOriginPt.x + stop.x,
      y: stop.z,
      z: tileOriginPt.z + stop.y,
    };
  }
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

function ingestTileMap(
  text,
  tileName,
  minTx,
  minTy,
  tileLayout,
  splines,
  objects,
  busstops,
  splineOrderByTile,
) {
  const lines = text.split(/\r?\n/);
  const metric = tileLayout?.byName?.get(tileName.toLowerCase());
  const coords = parseTileCoords(tileName);
  const origin = metric
    ? getTileOriginFromMetric(metric, minTx, minTy)
    : coords
      ? getTileOriginFromMetric(
          { x: coords[0], y: coords[1], layoutWorldX: 0, layoutWorldZ: 0, isGlobal: false },
          minTx,
          minTy,
        )
      : { x: 0, z: 0 };
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
          name: parseAttachmentName(lines, idx + 8),
          paths: null,
        });
      }
      idx += 1;
      continue;
    }

    if (tag === "[splineAttachement]" && lines[idx + 1]?.trim() === "0") {
      const rel = lines[idx + 2]?.trim() ?? "";
      const oid = lines[idx + 3]?.trim() ?? "";
      if (oid && scoPathLooksBusstop(rel)) {
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

const DEFAULT_SLI_PATHS = new Map([
  [0, { typ: 0, lateral: 0, height: 0, direction: PATH_DIR_BOTH }],
]);

function sliFileBasename(relPath) {
  return relPath.replace(/\\/g, "/").split("/").pop();
}

/** Diagnóstico: paths por .sli/.sco y rieles generados por spline/object id. */
export function buildRailLoadReport({ splines, objects, rails, sliByFile, scoByFile }) {
  const railsBySplineId = new Map();
  const railsByObjectId = new Map();
  for (const r of rails) {
    if (r.kind === "spline") {
      railsBySplineId.set(r.elementId, (railsBySplineId.get(r.elementId) || 0) + 1);
    } else if (r.kind === "object") {
      railsByObjectId.set(r.elementId, (railsByObjectId.get(r.elementId) || 0) + 1);
    }
  }

  const splineRows = [];
  for (const sp of [...splines.values()].sort((a, b) => a.id - b.id)) {
    const sliKey = sp.path.replace(/\\/g, "/").toLowerCase();
    const meta = sliByFile?.get(sliKey) || {};
    const sliPaths = meta.pathCount ?? 0;
    const railCount = railsBySplineId.get(sp.id) || 0;
    splineRows.push({
      id: sp.id,
      tile: sp.tile,
      sli: sliFileBasename(sp.path),
      sliRel: sp.path,
      sliPaths,
      rails: railCount,
      missing: !!meta.missing,
      onlyEditor: !!meta.onlyEditor,
      usedDefault: !!meta.usedDefault,
      invis: !!sp.isInvis,
      mirror: !!sp.isMirrored,
    });
  }

  const objectRows = [];
  for (const obj of [...objects.values()].sort((a, b) => a.id - b.id)) {
    const scoKey = obj.scoRel.replace(/\\/g, "/").toLowerCase();
    const meta = scoByFile?.get(scoKey) || {};
    const scoPaths = obj.paths?.size ?? meta.pathCount ?? 0;
    const railCount = railsByObjectId.get(obj.id) || 0;
    objectRows.push({
      id: obj.id,
      tile: obj.tile,
      sco: sliFileBasename(obj.scoRel),
      scoRel: obj.scoRel,
      scoPaths,
      rails: railCount,
      missing: !!meta.missing,
      busstop: !!meta.isBusstop,
    });
  }

  const splineRailTotal = rails.filter((r) => r.kind === "spline").length;
  const objectRailTotal = rails.filter((r) => r.kind === "object").length;
  const uniqueSli = sliByFile?.size ?? 0;
  const sliMissingCount = [...(sliByFile?.values() || [])].filter((m) => m.missing).length;
  const scoMissingCount = [...(scoByFile?.values() || [])].filter((m) => m.missing).length;
  const splinesWithRails = splineRows.filter((r) => r.rails > 0).length;
  const objectsWithRails = objectRows.filter((r) => r.rails > 0).length;
  const objectsNoPaths = objectRows.filter((r) => r.scoPaths === 0).length;

  const summary = {
    splineCount: splines.size,
    splinesWithRails,
    splineRailTotal,
    uniqueSli,
    sliMissingCount,
    objectCount: objects.size,
    objectsWithRails,
    objectsNoPaths,
    objectRailTotal,
    uniqueSco: scoByFile?.size ?? 0,
    scoMissingCount,
    totalRails: rails.length,
  };

  const lines = [
    "=== Carga splines (.sli) ===",
    `Splines en .map: ${summary.splineCount} · con rieles: ${summary.splinesWithRails}`,
    `Archivos .sli únicos: ${summary.uniqueSli} (faltan ${summary.sliMissingCount})`,
    `Rieles spline: ${summary.splineRailTotal}`,
    "",
    "=== Carga objects (.sco) ===",
    `Objects en .map: ${summary.objectCount} · con rieles: ${summary.objectsWithRails}`,
    `Archivos .sco únicos: ${summary.uniqueSco} (faltan ${summary.scoMissingCount})`,
    `Sin paths .sco: ${summary.objectsNoPaths}`,
    `Rieles object: ${summary.objectRailTotal}`,
    "",
    `Total rieles: ${summary.totalRails}`,
    "",
    "--- Splines (id · tile · .sli · paths → rieles) ---",
  ];
  for (const row of splineRows) {
    const flags = [
      row.missing ? "MISSING" : null,
      row.onlyEditor ? "onlyEditor" : null,
      row.usedDefault ? "defaultPath" : null,
      row.invis ? "invis" : null,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `spline ${row.id} · ${row.tile} · ${row.sli} · ${row.sliPaths} paths → ${row.rails} rieles` +
        (flags ? ` [${flags}]` : ""),
    );
  }
  lines.push("", "--- Objects (id · tile · .sco · paths → rieles) ---");
  for (const row of objectRows) {
    const flags = [
      row.missing ? "MISSING" : null,
      row.busstop ? "busstop" : null,
      row.scoPaths === 0 ? "sin paths" : null,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `object ${row.id} · ${row.tile} · ${row.sco} · ${row.scoPaths} paths → ${row.rails} rieles` +
        (flags ? ` [${flags}]` : ""),
    );
  }

  return { summary, splineRows, objectRows, lines };
}

async function loadSliCache(splines, index, omsiPrefix, pool) {
  const sliCache = new Map();
  const sliOnlyEditor = new Map();
  const sliByFile = new Map();
  let sliFound = 0;
  let sliMissing = 0;
  const unique = new Map();
  for (const sp of splines.values()) {
    const key = sp.path.replace(/\\/g, "/").toLowerCase();
    if (!unique.has(key)) unique.set(key, sp.path);
  }

  const readResults = await runInParallel(
    [...unique.entries()],
    async ([key, relPath]) => {
      const file = resolveFile(index, relPath, omsiPrefix);
      if (!file) return { key, relPath, missing: true };
      return { key, relPath, text: await readAnsiText(file) };
    },
    IO_CONCURRENCY,
  );

  const toParse = [];
  for (const r of readResults) {
    if (r.missing) {
      sliCache.set(r.key, new Map(DEFAULT_SLI_PATHS));
      sliOnlyEditor.set(r.key, false);
      sliByFile.set(r.key, {
        relPath: r.relPath,
        pathCount: DEFAULT_SLI_PATHS.size,
        onlyEditor: false,
        missing: true,
        usedDefault: true,
      });
      sliMissing += 1;
    } else {
      toParse.push(r);
      sliFound += 1;
    }
  }

  const storeSliParsed = (key, relPath, parsed) => {
    const rawCount = parsed.paths?.size ?? 0;
    const usedDefault = !rawCount;
    const paths = rawCount ? parsed.paths : new Map(DEFAULT_SLI_PATHS);
    sliCache.set(key, paths);
    sliOnlyEditor.set(key, !!parsed.onlyEditor);
    sliByFile.set(key, {
      relPath,
      pathCount: paths.size,
      onlyEditor: !!parsed.onlyEditor,
      missing: false,
      usedDefault,
    });
  };

  if (pool && toParse.length) {
    try {
      const parsed = await pool.runAll(
        toParse.map((r) => ({ type: "parseSli", key: r.key, text: r.text })),
      );
      for (const p of parsed) {
        const relPath = unique.get(p.key) || p.key;
        storeSliParsed(p.key, relPath, {
          paths: new Map(p.pathsEntries),
          onlyEditor: p.onlyEditor,
        });
      }
    } catch {
      for (const r of toParse) {
        storeSliParsed(r.key, r.relPath, parseSliFile(r.text));
      }
    }
  } else {
    for (const r of toParse) {
      storeSliParsed(r.key, r.relPath, parseSliFile(r.text));
    }
  }

  return { sliCache, sliOnlyEditor, sliFound, sliMissing, sliByFile };
}

async function loadScoCache(objects, index, omsiPrefix, pool) {
  const scoCache = new Map();
  const scoBusstopFlags = new Map();
  const scoByFile = new Map();
  let scoFound = 0;
  let scoMissing = 0;
  const scoNeeded = new Map();
  for (const obj of objects.values()) {
    const key = obj.scoRel.replace(/\\/g, "/").toLowerCase();
    if (!scoNeeded.has(key)) scoNeeded.set(key, obj.scoRel);
  }

  const readResults = await runInParallel(
    [...scoNeeded.entries()],
    async ([key, rel]) => {
      const file = resolveFile(index, rel, omsiPrefix);
      if (!file) return { key, rel, missing: true };
      return { key, rel, text: await readText(file) };
    },
    IO_CONCURRENCY,
  );

  const toParse = [];
  for (const r of readResults) {
    if (r.missing) {
      scoCache.set(r.key, new Map());
      const isBusstop = scoPathLooksBusstop(r.rel);
      scoBusstopFlags.set(r.key, isBusstop);
      scoByFile.set(r.key, { relPath: r.rel, pathCount: 0, missing: true, isBusstop });
      scoMissing += 1;
    } else {
      const isBusstop = scoIsBusstop(r.rel, r.text);
      scoBusstopFlags.set(r.key, isBusstop);
      toParse.push(r);
      scoFound += 1;
    }
  }

  const storeScoParsed = (key, relPath, paths) => {
    scoCache.set(key, paths);
    scoByFile.set(key, {
      relPath,
      pathCount: paths.size,
      missing: false,
      isBusstop: scoBusstopFlags.get(key) ?? false,
    });
  };

  if (pool && toParse.length) {
    try {
      const parsed = await pool.runAll(
        toParse.map((r) => ({ type: "parseSco", key: r.key, text: r.text })),
      );
      for (const p of parsed) {
        const relPath = scoNeeded.get(p.key) || p.key;
        storeScoParsed(p.key, relPath, new Map(p.pathsEntries));
      }
    } catch {
      for (const r of toParse) storeScoParsed(r.key, r.rel, parseScoPaths(r.text));
    }
  } else {
    for (const r of toParse) storeScoParsed(r.key, r.rel, parseScoPaths(r.text));
  }

  return { scoCache, scoFound, scoMissing, scoBusstopFlags, scoByFile };
}

function collectRailWorkItems(splines, objects, sliCache, sliOnlyEditor, minTx, minTy, tileLayout) {
  const tileOriginFor = (tileName) => {
    const metric = tileLayout?.byName?.get(tileName.toLowerCase());
    const coords = parseTileCoords(tileName);
    if (metric) return getTileOriginFromMetric(metric, minTx, minTy);
    if (coords) {
      return getTileOriginFromMetric(
        { x: coords[0], y: coords[1], layoutWorldX: 0, layoutWorldZ: 0, isGlobal: false },
        minTx,
        minTy,
      );
    }
    return { x: 0, z: 0 };
  };

  const splineItems = [];
  for (const sp of splines.values()) {
    const sliKey = sp.path.replace(/\\/g, "/").toLowerCase();
    const cached = sliCache.get(sliKey);
    const paths = cached?.size ? cached : DEFAULT_SLI_PATHS;
    splineItems.push({
      sp: { ...sp, origin: tileOriginFor(sp.tile) },
      pathsEntries: [...paths.entries()],
      onlyEditor: sliOnlyEditor.get(sliKey) ?? false,
    });
  }

  const objectItems = [];
  for (const obj of objects.values()) {
    if (!obj.paths?.size) continue;
    objectItems.push({
      obj,
      origin: tileOriginFor(obj.tile),
      pathsEntries: [...obj.paths.entries()],
    });
  }
  return { splineItems, objectItems };
}

async function generateRails(splines, objects, sliCache, sliOnlyEditor, minTx, minTy, tileLayout, pool) {
  const { splineItems, objectItems } = collectRailWorkItems(
    splines,
    objects,
    sliCache,
    sliOnlyEditor,
    minTx,
    minTy,
    tileLayout,
  );
  const tasks = [];
  const batchSize = railBatchSize(splineItems.length + objectItems.length, pool?.size);
  for (let i = 0; i < splineItems.length; i += batchSize) {
    tasks.push({ type: "spline", items: splineItems.slice(i, i + batchSize) });
  }
  for (let i = 0; i < objectItems.length; i += batchSize) {
    tasks.push({ type: "sco", items: objectItems.slice(i, i + batchSize) });
  }

  let parallelWorkers = 0;
  let rails = [];
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };

  const buildSequential = () => {
    const splineResult = buildSplineRails(splineItems);
    const scoResult = buildScoRails(objectItems);
    rails = [...splineResult.rails, ...scoResult.rails];
    mergeBounds(bounds, splineResult.bounds);
    mergeBounds(bounds, scoResult.bounds);
  };

  if (pool && tasks.length) {
    parallelWorkers = pool.size;
    try {
      const results = await pool.runAll(tasks);
      for (const r of results) {
        rails.push(...r.rails);
        mergeBounds(bounds, r.bounds);
      }
    } catch {
      parallelWorkers = 0;
      buildSequential();
    }
  } else {
    buildSequential();
  }

  return { rails, bounds, parallelWorkers };
}

/**
 * @param {Map<string, File>} fileMap path relativo → File
 * @param {string} mapDir prefijo carpeta mapa (ej. maps/Test_Lat30)
 * @param {(msg:string)=>void} onProgress
 */
export async function processMapFolder(fileMap, mapDir, onProgress = () => {}) {
  const pool = createMapWorkerPool();
  try {
    return await processMapFolderInner(fileMap, mapDir, onProgress, pool);
  } finally {
    pool?.terminate();
  }
}

async function processMapFolderInner(fileMap, mapDir, onProgress, pool) {
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
  const tileLayout = buildTileLayoutMap(globalText, tileFiles);

  const splines = new Map();
  const objects = new Map();
  const busstops = [];
  const splineOrderByTile = new Map();

  onProgress(`Parseando ${tileFiles.length} tiles…`);
  const tileTexts = await runInParallel(
    tileFiles,
    async (tilePath) => ({
      tilePath,
      text: await readText(fileMap.get(tilePath)),
    }),
    IO_CONCURRENCY,
  );
  for (const { tilePath, text } of tileTexts) {
    ingestTileMap(
      text,
      tilePath.split("/").pop(),
      minTx,
      minTy,
      tileLayout,
      splines,
      objects,
      busstops,
      splineOrderByTile,
    );
  }

  onProgress("Cargando paths .sli…");
  const { sliCache, sliOnlyEditor, sliFound, sliMissing, sliByFile } = await loadSliCache(
    splines,
    index,
    omsiPrefix,
    pool,
  );

  onProgress("Cargando paths .sco…");
  const { scoCache, scoFound, scoMissing, scoBusstopFlags, scoByFile } = await loadScoCache(
    objects,
    index,
    omsiPrefix,
    pool,
  );

  for (const obj of objects.values()) {
    const key = obj.scoRel.replace(/\\/g, "/").toLowerCase();
    obj.paths = scoCache.get(key) || new Map();
  }
  appendStandaloneObjectBusstops(objects, scoBusstopFlags, busstops);
  const busstopsDeduped = dedupeBusstopsByPosition(
    busstops,
    { minTx, minTy, tileLayout },
    splines,
    splineOrderByTile,
  );

  onProgress(pool ? `Generando rieles (${pool.size} workers)…` : "Generando rieles…");
  const { rails, bounds, parallelWorkers } = await generateRails(
    splines,
    objects,
    sliCache,
    sliOnlyEditor,
    minTx,
    minTy,
    tileLayout,
    pool,
  );

  const loadReport = buildRailLoadReport({ splines, objects, rails, sliByFile, scoByFile });

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
  const busstopAttachmentCount = busstopsDeduped.filter((s) => !s.standalone).length;
  const busstopStandaloneCount = busstopsDeduped.filter((s) => s.standalone).length;
  const busstopOut = busstopsDeduped.map((s) => {
    const parentSpline = s.standalone ? "" : resolveBusstopParentSpline(s, splines, splineOrderByTile);
    const w = busstopWorld({ minTx, minTy, tileLayout }, s, splines, splineOrderByTile);
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
      standalone: !!s.standalone,
      source: s.standalone ? "object" : "attachment",
    };
  });

  onProgress("Rutas TTData…");
  const routes = [];
  const ttrLabels = new Map();
  const ttpEntries = [...fileMap.entries()].filter(
    ([path]) => normPath(path).startsWith(prefix) && /\.ttp$/i.test(path),
  );
  const ttpResults = await runInParallel(
    ttpEntries,
    async ([path, file]) => {
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
      if (!trackName) return null;
      const ttrFile = trackName.toLowerCase().endsWith(".ttr") ? trackName : `${trackName}.ttr`;
      const ttrPath = `${path.replace(/[^/]+$/, ttrFile)}`.replace(/\\/g, "/");
      return { ttrPath, label: label || ttrFile };
    },
    IO_CONCURRENCY,
  );
  for (const r of ttpResults) {
    if (r) ttrLabels.set(r.ttrPath, r.label);
  }

  const ttrEntries = [...fileMap.entries()].filter(
    ([path]) => normPath(path).startsWith(prefix) && /\.ttr$/i.test(path),
  );
  const seenTtr = new Set();
  const uniqueTtr = ttrEntries.filter(([path]) => {
    const norm = normPath(path);
    if (seenTtr.has(norm)) return false;
    seenTtr.add(norm);
    return true;
  });

  const railsById = new Map(rails.map((r) => [r.id, r]));
  const resolveCtx = { splines, objects, railsById, sliCache };

  const ttrResults = await runInParallel(
    uniqueTtr,
    async ([path, file]) => {
      const norm = normPath(path);
      const entries = parseTtr(await readText(file));
      const used = new Set();
      const enriched = entries.map((e) => {
        const resolved = resolveTrackEntryRail(e, resolveCtx);
        if (!resolved.skipped) used.add(resolved.railId);
        return { ...e, ...resolved };
      });
      const skippedCount = enriched.filter((e) => e.skipped).length;
      const skippedEntries = buildSkippedEntries(enriched);
      return {
        id: norm.slice(prefix.length),
        file: norm.split("/").pop(),
        label: ttrLabels.get(norm) || norm.split("/").pop(),
        entries: enriched,
        railIds: [...used].sort(),
        entryCount: entries.length,
        skippedCount,
        skippedEntries,
      };
    },
    IO_CONCURRENCY,
  );
  routes.push(...ttrResults);

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
    loadReport,
    stats: {
      railCount: rails.length,
      freeStartCount: freeIds.size,
      omsiSpawnCount: freeIds.size,
      freeLegCount: startCandidates.filter((c) => c.isFreeStart).length,
      pathLegCount: startCandidates.length,
      connectToleranceM: CONNECT_TOL,
      tileSizeM: Math.round(tileLayout.tileSizeM * 1000) / 1000,
      mapLatitude: tileLayout.mapLatitude != null ? Math.round(tileLayout.mapLatitude * 1000) / 1000 : null,
      classicTileCount: tileLayout.classicTileCount,
      globalTileCount: tileLayout.globalTileCount,
      worldGridTileCount: tileLayout.worldGridTileCount,
      worldCoordinates: tileLayout.worldCoordinates,
      sampleGridY: tileLayout.sampleGridY,
      busstopCount: busstopOut.length,
      busstopAttachmentCount,
      busstopStandaloneCount,
      routeCount: routes.length,
      sliFound,
      sliMissing,
      scoFound,
      scoMissing,
      splineCount: splines.size,
      objectCount: objects.size,
      parallelWorkers,
      parallelPoolSize: defaultPoolSize(),
      hardwareThreads: hardwareThreads(),
      ioConcurrency: IO_CONCURRENCY,
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
