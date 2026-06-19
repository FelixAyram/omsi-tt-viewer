/**
 * Procesa carpetas OMSI 2 en el navegador (global.cfg + tiles + TTData).
 * Requiere que la selección incluya Splines/ y Sceneryobjects/ (carpeta OMSI 2 o mapa dentro de ella).
 */
import {
  sampleSplineRail,
  sampleScoRail,
  expandBounds,
  dirFromRotation,
  splineLocalAt,
  perpOffset,
} from "./geometry.js";

const TILE_SIZE = 300;
const VEHICLE_TYP = 0;
const CONNECT_TOL = 0.1;

function safeFloat(text, fallback = 0) {
  const v = String(text ?? "").trim().replace(",", ".");
  if (!v || v.startsWith("[")) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function readText(file) {
  return file.text();
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

function parseSplineBlock(lines, i) {
  if (lines[i]?.trim() !== "0") return null;
  const path = lines[i + 1]?.trim() ?? "";
  if (!isSplinePath(path)) return null;
  const id = lines[i + 2]?.trim() ?? "";
  const previd = lines[i + 3]?.trim() ?? "";
  let numStart = i + 4;
  if (previd !== "-1") numStart = i + 5;
  const nums = [];
  let j = numStart;
  while (j < lines.length && nums.length < 14) {
    const t = lines[j]?.trim();
    if (!t) {
      j += 1;
      continue;
    }
    if (t.startsWith("[")) break;
    if (/^-?\d+(\.\d+)?$/.test(t.replace(",", "."))) {
      nums.push(parseFloat(t.replace(",", ".")));
      j += 1;
    } else break;
  }
  if (nums.length < 5) return null;
  return {
    path,
    id,
    previd,
    x: nums[0],
    y: nums[2],
    z: nums[1],
    rotation: nums[3],
    largo: nums[4],
    radius: nums[5] ?? 0,
    endIdx: j,
  };
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
      pathIndex += 1;
      out.set(pathIndex, {
        sx: vals[0],
        sy: vals[2],
        sz: vals[1],
        angle: vals[3],
        radius: vals[4],
        length: Math.abs(vals[5]) || 0.01,
        typ: vals.length > 8 ? (vals[8] | 0) : VEHICLE_TYP,
      });
    }
    idx = j;
  }
  return out;
}

function parseTtr(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^\s*(\d+)\s*:?\s*$/.exec(lines[i]);
    if (m && lines[i + 1]?.trim() === "[track_entry]") {
      entries.push({
        elementId: lines[i + 2]?.trim() ?? "",
        pathIdx: lines[i + 3]?.trim() ?? "",
        routeId: lines[i + 4]?.trim() ?? "",
        distance: lines[i + 5]?.trim() ?? "",
      });
      i += 8;
      continue;
    }
    i += 1;
  }
  return entries;
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

function resolveFile(files, relPath, omsiPrefix) {
  const norm = relPath.replace(/\\/g, "/");
  const tries = [
    norm,
    `${omsiPrefix}${norm}`,
    `${omsiPrefix}Sceneryobjects/${norm}`,
    norm.replace(/^Sceneryobjects\//i, `${omsiPrefix}Sceneryobjects/`),
  ];
  for (const t of tries) {
    if (files.has(t)) return files.get(t);
  }
  for (const [k, f] of files) {
    if (k.replace(/\\/g, "/").toLowerCase().endsWith(norm.toLowerCase())) return f;
  }
  return null;
}

function findMaps(files) {
  const maps = [];
  for (const path of files.keys()) {
    if (/\/global\.cfg$/i.test(path.replace(/\\/g, "/"))) {
      const dir = path.replace(/\\/g, "/").replace(/\/global\.cfg$/i, "");
      maps.push(dir);
    }
  }
  return maps.sort();
}

function detectOmsiPrefix(files) {
  for (const p of files.keys()) {
    const n = p.replace(/\\/g, "/");
    if (n.includes("Sceneryobjects/")) return n.split("Sceneryobjects/")[0];
    if (n.includes("Splines/")) return n.split("Splines/")[0];
  }
  return "";
}

function findFreeStarts(rails) {
  const free = new Set();
  for (let i = 0; i < rails.length; i += 1) {
    const sx = rails[i].points[0][0];
    const sz = rails[i].points[0][2];
    let incoming = false;
    for (let j = 0; j < rails.length; j += 1) {
      if (i === j) continue;
      const end = rails[j].points.at(-1);
      if (Math.hypot(end[0] - sx, end[2] - sz) <= CONNECT_TOL) {
        incoming = true;
        break;
      }
    }
    if (!incoming) free.add(rails[i].id);
  }
  return free;
}

function busstopWorld(graph, stop, splines) {
  const tile = parseTileCoords(stop.tile);
  const origin = tile ? tileOrigin(tile[0], tile[1], graph.minTx, graph.minTy) : { x: 0, z: 0 };
  const sid = stop.parentSpline;
  const spline = sid ? splines.get(sid) : null;
  if (spline) {
    const local = splineLocalAt(
      spline.x,
      spline.y,
      spline.rotation,
      spline.radius,
      stop.distAlong || 0,
      spline.z,
    );
    const dir = dirFromRotation(local.rot);
    const off = perpOffset(dir, stop.lateral || 0);
    return {
      x: origin.x + local.x + off.x,
      y: local.z,
      z: origin.z + local.y + off.z,
    };
  }
  return { x: origin.x + stop.x, y: stop.z, z: origin.z + stop.y };
}

/**
 * @param {Map<string, File>} fileMap path relativo → File
 * @param {string} mapDir prefijo carpeta mapa (ej. maps/Test_Lat30)
 * @param {(msg:string)=>void} onProgress
 */
export async function processMapFolder(fileMap, mapDir, onProgress = () => {}) {
  const prefix = mapDir.endsWith("/") ? mapDir : `${mapDir}/`;
  const omsiPrefix = detectOmsiPrefix(fileMap);
  const files = fileMap;

  onProgress("Leyendo global.cfg…");
  const globalFile = files.get(`${prefix}global.cfg`);
  if (!globalFile) throw new Error("No se encontró global.cfg en la carpeta del mapa.");
  const globalText = await readText(globalFile);
  const mapName = parseGlobalName(globalText) || mapDir.split("/").pop();

  const tileFiles = [...files.keys()].filter(
    (p) => p.startsWith(prefix) && /tile_-?\d+_-?\d+\.map$/i.test(p),
  );
  if (!tileFiles.length) throw new Error("No hay tiles tile_*.map en la carpeta.");

  const tileCoords = tileFiles.map((f) => parseTileCoords(f.split("/").pop())).filter(Boolean);
  const minTx = Math.min(...tileCoords.map((c) => c[0]));
  const minTy = Math.min(...tileCoords.map((c) => c[1]));

  const splines = new Map();
  const objects = new Map();
  const busstops = [];
  const sliCache = new Map();
  const scoCache = new Map();

  onProgress(`Parseando ${tileFiles.length} tiles…`);
  for (const tilePath of tileFiles) {
    const tileName = tilePath.split("/").pop();
    const text = await readText(files.get(tilePath));
    const lines = text.split(/\r?\n/);
    const coords = parseTileCoords(tileName);
    const origin = tileOrigin(coords[0], coords[1], minTx, minTy);

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
          let name = "";
          let parentSpline = "";
          for (let j = idx + 9; j < Math.min(idx + 22, lines.length); j += 1) {
            const t = lines[j]?.trim();
            if (!t || t.startsWith("[")) break;
            if (/^-?\d+(\.\d+)?$/.test(t)) {
              if (name && !parentSpline) parentSpline = t;
              continue;
            }
            if (t && !t.toLowerCase().endsWith(".sco")) name = t;
          }
          busstops.push({
            id: oid,
            name: name || `Parada ${oid}`,
            tile: tileName,
            x: safeFloat(lines[idx + 5]),
            y: safeFloat(lines[idx + 6]),
            z: safeFloat(lines[idx + 7]),
            rotation: safeFloat(lines[idx + 8]),
            pathIdx: lines[idx + 4]?.trim() ?? "0",
            parentSpline,
            distAlong: safeFloat(lines[idx + 7]),
            lateral: safeFloat(lines[idx + 5]),
          });
        }
        idx += 1;
        continue;
      }

      if ((tag === "[spline]" || tag === "[spline_h]") && lines[idx + 1]?.trim() === "0") {
        const block = parseSplineBlock(lines, idx + 1);
        if (block) {
          splines.set(block.id, {
            ...block,
            tile: tileName,
            origin,
            isInvis: block.path.toLowerCase().includes("invis"),
          });
        }
      }
    }
  }

  onProgress("Cargando paths .sli…");
  for (const sp of splines.values()) {
    const key = sp.path.replace(/\\/g, "/").toLowerCase();
    if (sliCache.has(key)) continue;
    const file = resolveFile(files, sp.path, omsiPrefix);
    if (file) {
      sliCache.set(key, parseSliPaths(await readText(file)));
    } else {
      sliCache.set(key, new Map([[0, { typ: 0, lateral: 0, height: 0, direction: 2 }]]));
    }
  }

  onProgress("Cargando paths .sco…");
  for (const obj of objects.values()) {
    const key = obj.scoRel.replace(/\\/g, "/").toLowerCase();
    if (!scoCache.has(key)) {
      const file = resolveFile(files, obj.scoRel, omsiPrefix);
      scoCache.set(key, file ? parseScoPaths(await readText(file)) : new Map());
    }
    obj.paths = scoCache.get(key);
  }

  onProgress("Generando rieles…");
  const rails = [];
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };

  for (const sp of splines.values()) {
    if (sp.isInvis) continue;
    const sliKey = sp.path.replace(/\\/g, "/").toLowerCase();
    const paths = sliCache.get(sliKey) || new Map([[0, { typ: 0, lateral: 0, height: 0, direction: 2 }]]);
    for (const [pidx, meta] of paths) {
      const points = sampleSplineRail(sp, sp.origin, {
        lateral: meta.lateral,
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
        direction: meta.direction,
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
        direction: -1,
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

  const freeIds = findFreeStarts(rails);
  for (const r of rails) r.freeStart = freeIds.has(r.id);

  onProgress("Paradas…");
  const busstopOut = busstops.map((s) => {
    const w = busstopWorld({ minTx, minTy }, s, splines);
    expandBounds(bounds, w.x, w.z);
    return {
      id: s.id,
      name: s.name,
      x: w.x,
      y: w.y,
      z: w.z,
      rotation: s.rotation,
      pathIdx: s.pathIdx,
      parentSpline: s.parentSpline,
    };
  });

  onProgress("Rutas TTData…");
  const routes = [];
  const ttrLabels = new Map();
  for (const [path, file] of files) {
    if (!path.startsWith(prefix) || !/\.ttp$/i.test(path)) continue;
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
  for (const [path, file] of files) {
    if (!path.startsWith(prefix) || !/\.ttr$/i.test(path)) continue;
    const norm = path.replace(/\\/g, "/");
    if (seenTtr.has(norm)) continue;
    seenTtr.add(norm);
    const entries = parseTtr(await readText(file));
    const used = new Set();
    const enriched = entries.map((e) => {
      const kind = splines.has(e.elementId) ? "spline" : "object";
      const rid = railKey(kind, e.elementId, e.pathIdx);
      used.add(rid);
      return { ...e, kind, railId: rid };
    });
    routes.push({
      id: norm.slice(prefix.length),
      file: norm.split("/").pop(),
      label: ttrLabels.get(norm) || norm.split("/").pop(),
      entries: enriched,
      railIds: [...used].sort(),
    });
  }

  if (!Number.isFinite(bounds.minX)) {
    bounds.minX = bounds.maxX = bounds.minZ = bounds.maxZ = 0;
  }

  onProgress("Listo.");
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
      busstopCount: busstopOut.length,
      routeCount: routes.length,
    },
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

export function listMapsInFiles(fileMap) {
  return findMaps(fileMap);
}

export { detectOmsiPrefix };
