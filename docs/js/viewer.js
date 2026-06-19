import { APP_VERSION } from "./version.js?v=33";
import { loadMapLazy, validateOmsiInstall, listMapCatalog } from "./map_processor.js?v=33";
import {
  pickOmsiRoot,
  pickMapFolder,
  pickOmsiAssetsRoot,
  pickGlobalCfgFile,
  scanMapsCatalogFromHandle,
} from "./omsi_browser.js?v=33";
import { RAIL_TYP, ROUTE_PALETTE, FREE_START, BUSSTOP, SELECTED } from "./colors.js?v=33";
import {
  buildRailSpatialIndex,
  queryVisibleRails,
  findRailNear,
  drawRailsBatched,
  visibleWorldRect,
} from "./map_renderer.js?v=33";
import {
  initDebugPanel,
  debugClear,
  debugPrint,
  debugError,
  describeWebkitPick,
  describeFsaRoot,
  describeFsaMapHandle,
  appendSection,
} from "./debug.js?v=33";

const LARGE_MAP_RAILS = 15000;
const LITE_MODE_RAILS = 8000;

const appVersionEl = document.getElementById("appVersion");
if (appVersionEl) {
  appVersionEl.textContent = `Versión ${APP_VERSION}`;
}

const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const mapSelect = document.getElementById("mapSelect");
const omsiPathLabel = document.getElementById("omsiPathLabel");
const pickOmsiBtn = document.getElementById("pickOmsiBtn");
const pickMapFolderBtn = document.getElementById("pickMapFolderBtn");
const omsiMapSelect = document.getElementById("omsiMapSelect");
const loadOmsiMapBtn = document.getElementById("loadOmsiMapBtn");
const globalCfgLabel = document.getElementById("globalCfgLabel");
const pickGlobalCfgBtn = document.getElementById("pickGlobalCfgBtn");
const routeList = document.getElementById("routeList");
const fileInput = document.getElementById("fileInput");
const showAllRails = document.getElementById("showAllRails");
const showFreeOnly = document.getElementById("showFreeOnly");
const showBusstops = document.getElementById("showBusstops");
const statsEl = document.getElementById("stats");
const progressEl = document.getElementById("progress");
const infoEl = document.getElementById("infoPanel");
const legendEl = document.getElementById("legend");
const resetViewBtn = document.getElementById("resetView");
const debugLogEl = document.getElementById("debugLog");

initDebugPanel(debugLogEl);
debugClear();

async function logPickDebug(label, result, { append = false } = {}) {
  if (!result) return;
  let section = [`=== ${label} ===`, `Timestamp: ${new Date().toISOString()}`, ""];
  try {
    if (result.mode === "fsa" && result.rootHandle) {
      section = appendSection(section, await describeFsaRoot(result.rootHandle));
    } else if (result.mode === "fsa-map" && result.mapHandle) {
      section = appendSection(section, await describeFsaMapHandle(result.mapHandle));
    } else if (result.fileMap) {
      section = appendSection(section, describeWebkitPick(result));
    } else {
      section.push(`Modo: ${result.mode ?? "?"}`);
      section.push(JSON.stringify(result, null, 2));
    }
    const lines = append && debugLogEl?.textContent
      ? appendSection(debugLogEl.textContent.split("\n"), section)
      : section;
    debugPrint(lines);
  } catch (diagErr) {
    debugError(diagErr, `Fallo al generar diagnóstico (${label})`);
  }
}

function alertWithDebug(err, context) {
  const extra = [];
  if (err?.scanLog?.length) {
    extra.push("", "Escaneo maps/:", ...err.scanLog.map((l) => `  · ${l}`));
  }
  debugError(err, context);
  if (extra.length && debugLogEl) {
    debugPrint(appendSection(debugLogEl.textContent.split("\n"), extra));
  }
  alert(`${context ? context + ":\n\n" : ""}${err?.message || String(err)}\n\n(Detalle completo en «Diagnóstico» abajo)`);
}

let data = null;
let railIndex = null;
let loadTiming = null;
let view = { scale: 1, offsetX: 0, offsetY: 0 };
let dragging = false;
let panAnchor = null;
let panSnapshot = null;
let drawPending = false;
let lastDrawnVisible = 0;
let selectedRailId = null;
let selectedRoutes = new Set();
let omsiRoot = null;
let omsiRootLabel = "";
let selectedGlobalCfg = null;
let selectedGlobalCfgMapDir = "";

function clearGlobalCfgSelection() {
  selectedGlobalCfg = null;
  selectedGlobalCfgMapDir = "";
  if (globalCfgLabel) {
    globalCfgLabel.textContent = "Sin global.cfg elegido";
    globalCfgLabel.classList.add("muted");
  }
  if (loadOmsiMapBtn) loadOmsiMapBtn.disabled = true;
}

function updateGlobalCfgUi() {
  const mapDir = omsiMapSelect?.value;
  const cfgOk = selectedGlobalCfg && selectedGlobalCfgMapDir === mapDir;
  if (globalCfgLabel) {
    if (cfgOk) {
      globalCfgLabel.textContent = `global.cfg: ${selectedGlobalCfg.name || "elegido"}`;
      globalCfgLabel.classList.remove("muted");
    } else {
      globalCfgLabel.textContent = mapDir
        ? "Elige global.cfg de este mapa (obligatorio)"
        : "Sin global.cfg elegido";
      globalCfgLabel.classList.add("muted");
    }
  }
  if (loadOmsiMapBtn) {
    loadOmsiMapBtn.disabled = !omsiRoot || !mapDir || !cfgOk;
  }
  if (pickGlobalCfgBtn) {
    pickGlobalCfgBtn.disabled = !omsiRoot || !mapDir;
  }
}

function simplifyPoints(pts, scale) {
  if (pts.length <= 2) return pts;
  if (scale < 0.4) return [pts[0], pts.at(-1)];
  if (scale < 1.5 && pts.length > 6) {
    const out = [pts[0]];
    for (let i = 2; i < pts.length - 1; i += 2) out.push(pts[i]);
    out.push(pts.at(-1));
    return out;
  }
  if (scale < 4 && pts.length > 12) {
    const step = Math.max(2, Math.floor(pts.length / 8));
    const out = [pts[0]];
    for (let i = step; i < pts.length - 1; i += step) out.push(pts[i]);
    out.push(pts.at(-1));
    return out;
  }
  return pts;
}

function scheduleDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => {
    drawPending = false;
    draw();
  });
}

function snapshotCanvas() {
  panSnapshot = document.createElement("canvas");
  panSnapshot.width = canvas.width;
  panSnapshot.height = canvas.height;
  const sctx = panSnapshot.getContext("2d");
  if (sctx) sctx.drawImage(canvas, 0, 0);
}

function drawPanPreview(dx, dy) {
  if (!ctx || !panSnapshot) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#12151c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(panSnapshot, dx * dpr, dy * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function isLiteMode() {
  const n = data?.stats?.railCount ?? data?.rails?.length ?? 0;
  return n >= LITE_MODE_RAILS;
}

function railPoints(rail) {
  if (rail.points?.length >= 2) return rail.points;
  if (rail.start && rail.end) return [rail.start, rail.end];
  return [];
}

/** Tramo verde desde el punto de spawn OMSI hasta el fin de circulación. */
function railSpawnSegment(rail) {
  const pts = railPoints(rail);
  if (!rail.freeStart || !rail.trafficStart || pts.length < 2) return pts;
  let bestIdx = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    const d = Math.hypot(pts[i][0] - rail.trafficStart[0], pts[i][2] - rail.trafficStart[2]);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  // Spawn en el extremo final de la polilínea (backward o callejón forward): cruce → spawn
  if (bestIdx >= pts.length - 1) return pts.slice(0, bestIdx + 1);
  // Spawn en el extremo inicial: desde ahí hasta el final
  return pts.slice(bestIdx);
}

function resizeCanvas() {
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scheduleDraw();
}

/** Espejo en X al dibujar (vista cenital = editor OMSI; curvas a la derecha). */
const VIEW_MIRROR_X = true;

function worldToScreen(x, z) {
  const dx = (x - view.offsetX) * view.scale;
  return {
    x: VIEW_MIRROR_X ? canvas.clientWidth / 2 - dx : canvas.clientWidth / 2 + dx,
    y: (z - view.offsetY) * view.scale + canvas.clientHeight / 2,
  };
}

function screenToWorld(sx, sy) {
  const dx = VIEW_MIRROR_X
    ? (canvas.clientWidth / 2 - sx) / view.scale
    : (sx - canvas.clientWidth / 2) / view.scale;
  return {
    x: dx + view.offsetX,
    z: (sy - canvas.clientHeight / 2) / view.scale + view.offsetY,
  };
}

function fitBounds(bounds, padding = 40) {
  if (!bounds) return;
  const w = bounds.maxX - bounds.minX || 1;
  const h = bounds.maxZ - bounds.minZ || 1;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const sx = (canvas.clientWidth - padding * 2) / w;
  const sy = (canvas.clientHeight - padding * 2) / h;
  view.scale = Math.min(sx, sy);
  view.offsetX = cx;
  view.offsetY = cz;
}

function routeColor(index) {
  return ROUTE_PALETTE[index % ROUTE_PALETTE.length];
}

function buildRouteRailMap() {
  const map = new Map();
  if (!data?.routes) return map;
  data.routes.forEach((route, idx) => {
    if (!selectedRoutes.has(route.id)) return;
    const color = routeColor(idx);
    for (const rid of route.railIds || []) {
      if (!map.has(rid)) map.set(rid, []);
      map.get(rid).push(color);
    }
  });
  return map;
}

function findRailAt(sx, sy, threshold = 8) {
  if (!data?.rails || !railIndex) return null;
  const { x, z } = screenToWorld(sx, sy);
  const worldThreshold = threshold / view.scale;
  return findRailNear(railIndex, x, z, worldThreshold);
}

function prepareVisibleItems() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const worldRect = visibleWorldRect(view, w, h, VIEW_MIRROR_X);
  const lite = isLiteMode();
  const raw = queryVisibleRails(railIndex, worldRect);
  return raw.map(({ rail, pts }) => {
    let line = rail.freeStart ? railSpawnSegment(rail) : pts;
    if (lite) line = simplifyPoints(line, view.scale);
    return { rail, pts: line };
  });
}

function draw() {
  if (!ctx) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#12151c";
  ctx.fillRect(0, 0, w, h);

  if (!data) {
    ctx.fillStyle = "#8b95a8";
    ctx.font = "15px Segoe UI, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Elige la carpeta OMSI 2 y carga un mapa", w / 2, h / 2);
    return;
  }

  const routeRails = buildRouteRailMap();
  const showAll = showAllRails.checked;
  const freeOnly = showFreeOnly.checked;
  const lite = isLiteMode();
  const visibleItems = prepareVisibleItems();

  const drawStyles = {
    railTyp: RAIL_TYP,
    base: { width: lite ? 1 : Math.max(1.2, 1.5 * view.scale * 0.04) },
    route: { width: lite ? 2 : Math.max(4, 3 * view.scale * 0.08) },
    freeStart: { width: lite ? 1.5 : Math.max(3, 2.5 * view.scale * 0.06), stroke: FREE_START.stroke },
    selected: { width: 4, stroke: SELECTED.stroke },
  };

  lastDrawnVisible = drawRailsBatched(ctx, visibleItems, {
    worldToScreen,
    routeRails,
    showAll,
    freeOnly,
    selectedRailId,
    styles: drawStyles,
    liteMode: lite,
  });

  if (showBusstops.checked && data.busstops) {
    const r = Math.max(4, 4 * view.scale * 0.05);
    for (const stop of data.busstops) {
      const p = worldToScreen(stop.x, stop.z);
      if (p.x < -20 || p.y < -20 || p.x > w + 20 || p.y > h + 20) continue;
      ctx.fillStyle = BUSSTOP.fill;
      ctx.strokeStyle = BUSSTOP.stroke;
      ctx.lineWidth = 1.5;
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  const total = data.stats?.railCount ?? data.rails.length;
  if (lastDrawnVisible === 0 && total >= LARGE_MAP_RAILS && !showAll && selectedRoutes.size === 0) {
    ctx.fillStyle = "#8b95a8";
    ctx.font = "14px Segoe UI, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Mapa grande — activa capas o marca rutas .ttr para dibujar rieles", w / 2, h / 2);
  }
}

function updateStats() {
  if (!data) {
    statsEl.textContent = "";
    return;
  }
  const s = data.stats || {};
  const total = s.railCount ?? data.rails.length;
  let text =
    `${data.mapName} · ${total} rieles · ` +
    `${s.freeStartCount ?? 0} libres · ${s.busstopCount ?? data.busstops.length} paradas · ` +
    `${s.routeCount ?? data.routes.length} rutas`;
  if (s.sliMissing > 0 || s.scoMissing > 0) {
    text += ` · faltan ${s.sliMissing ?? 0} .sli / ${s.scoMissing ?? 0} .sco`;
  }
  if (loadTiming) {
    text += ` · ${formatLoadTiming(loadTiming)}`;
  }
  if (s.parallelWorkers > 0) {
    text += ` · ${s.parallelWorkers}/${s.parallelPoolSize ?? s.parallelWorkers} workers`;
  }
  if (lastDrawnVisible > 0 && total >= LARGE_MAP_RAILS) {
    text += ` · vista ${lastDrawnVisible}/${total} rieles`;
  }
  statsEl.textContent = text;
}

function fmtPt(p) {
  if (!p) return "—";
  return `(${p[0].toFixed(2)}, ${p[2].toFixed(2)})`;
}

function updateInfo(rail) {
  if (!rail) {
    infoEl.innerHTML = "<em>Clic en un riel para ver detalles</em>";
    return;
  }
  const typLabel = (RAIL_TYP[rail.typ] || RAIL_TYP[0]).label;
  const radiusText =
    rail.radius && Math.abs(rail.radius) > 1e-6
      ? `${Math.abs(rail.radius).toFixed(2)} m`
      : "recto";
  const legs = data?.pathLegs?.filter((l) => l.id === rail.id) ?? [];
  const legsHtml = legs.length
    ? legs
        .map(
          (l) =>
            `<br/>&nbsp;&nbsp;${l.leg} (${l.direction}): inicio ${fmtPt(l.start)} → fin ${fmtPt(l.end)}` +
            `${l.isFreeStart ? " <strong>libre</strong>" : ""}`,
        )
        .join("")
    : "";
  infoEl.innerHTML = `
    <strong>${rail.id}</strong><br/>
    Tipo: ${typLabel}<br/>
    Sentido: ${rail.directionLabel || "forward"}<br/>
    Longitud: ${rail.length} m<br/>
    Radio: ${radiusText}<br/>
    Tile: ${rail.tile || "—"}<br/>
    Circulación: inicio ${fmtPt(rail.trafficStart)} → fin ${fmtPt(rail.trafficEnd)}<br/>
    Inicio libre (spawn OMSI): ${rail.freeStart ? "sí" : "no"}<br/>
    Vehículo: ${rail.vehicle ? "sí" : "no"}${legsHtml}
  `;
}

function routeMetaLabel(route) {
  const n = (route.railIds || []).length;
  const skipped = route.skippedCount || 0;
  if (skipped > 0) return `${n} rieles · ${skipped} omitido${skipped === 1 ? "" : "s"}`;
  return `${n} rieles`;
}

function populateRoutes() {
  routeList.innerHTML = "";
  selectedRoutes.clear();
  if (!data?.routes?.length) {
    routeList.innerHTML = "<p class='muted'>Sin rutas (.ttr) en este mapa</p>";
    scheduleDraw();
    return;
  }

  data.routes.forEach((route, idx) => {
    const id = `route-${idx}`;
    const wrap = document.createElement("div");
    wrap.className = "route-item-wrap";

    const label = document.createElement("label");
    label.className = "route-item";
    const color = routeColor(idx);
    label.innerHTML = `
      <input type="checkbox" id="${id}" data-route-id="${route.id}" />
      <span class="swatch" style="background:${color}"></span>
      <span class="route-label">${route.label || route.file}</span>
      <span class="route-meta">${routeMetaLabel(route)}</span>
    `;
    const cb = label.querySelector("input");
    cb.addEventListener("change", () => {
      if (cb.checked) selectedRoutes.add(route.id);
      else selectedRoutes.delete(route.id);
      scheduleDraw();
    });
    wrap.appendChild(label);

    if (route.skippedEntries?.length) {
      const detail = document.createElement("div");
      detail.className = "route-skip-detail";
      for (const entry of route.skippedEntries) {
        const line = document.createElement("div");
        line.textContent = entry.label;
        detail.appendChild(line);
      }
      wrap.appendChild(detail);
    }

    routeList.appendChild(wrap);
  });
}

async function loadManifest() {
  try {
    const res = await fetch("data/manifest.json");
    if (!res.ok) return;
    const manifest = await res.json();
    mapSelect.innerHTML = '<option value="">— Mapa precargado —</option>';
    for (const entry of manifest.maps || []) {
      const opt = document.createElement("option");
      opt.value = entry.file;
      opt.textContent = entry.label || entry.name;
      mapSelect.appendChild(opt);
    }
  } catch {
    /* sin manifest */
  }
}

async function loadMapFile(file) {
  const res = await fetch(`data/${file}`);
  if (!res.ok) throw new Error(`No se pudo cargar ${file}`);
  return res.json();
}

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatLoadTiming(t) {
  if (!t) return "";
  return `${formatMs(t.totalMs)} total (paths ${formatMs(t.processMs)} · dibujo ${formatMs(t.drawMs)})`;
}

async function applyData(json, timing = null) {
  data = json;
  selectedRailId = null;
  panSnapshot = null;
  panAnchor = null;
  const railCount = json.stats?.railCount ?? json.rails?.length ?? 0;
  if (railCount >= LARGE_MAP_RAILS) {
    showAllRails.checked = false;
    showFreeOnly.checked = false;
  } else {
    showAllRails.checked = true;
  }
  railIndex = buildRailSpatialIndex(json.rails || []);
  fitBounds(data.bounds);
  const drawStart = performance.now();
  populateRoutes();
  updateInfo(null);
  draw();
  const drawMs = performance.now() - drawStart;
  if (timing) {
    loadTiming = {
      processMs: timing.processMs ?? 0,
      drawMs,
      totalMs: performance.now() - timing.startedAt,
    };
  } else {
    loadTiming = null;
  }
  updateStats();
}

function setProgress(msg) {
  progressEl.textContent = msg;
}

async function populateOmsiMapSelect(catalog) {
  clearGlobalCfgSelection();
  omsiMapSelect.disabled = true;
  loadOmsiMapBtn.disabled = true;
  pickGlobalCfgBtn.disabled = true;
  omsiMapSelect.innerHTML = `<option value="">— ${catalog.length} mapas —</option>`;
  for (const entry of catalog) {
    const opt = document.createElement("option");
    opt.value = entry.dir;
    opt.textContent = entry.label;
    omsiMapSelect.appendChild(opt);
  }
  omsiMapSelect.disabled = false;
  updateGlobalCfgUi();
  setProgress(`${catalog.length} mapas — elige mapa, luego global.cfg, y pulsa Cargar.`);
}

function combineMapAndAssetRoots(mapPick, assetPick) {
  if (mapPick.mode === "fsa-map" && assetPick.mode === "fsa") {
    return {
      mode: "fsa-combined",
      rootHandle: assetPick.rootHandle,
      mapHandle: mapPick.mapHandle,
      mapDir: mapPick.mapDir,
      label: `${mapPick.label} · ${assetPick.label}`,
    };
  }
  if (mapPick.mode === "webkit-map" && assetPick.mode === "webkit") {
    return {
      mode: "webkit-combined",
      mapFileMap: mapPick.fileMap,
      assetFileMap: assetPick.fileMap,
      mapDir: mapPick.mapDir,
      label: `${mapPick.label} · ${assetPick.label}`,
    };
  }
  throw new Error("Usa Chrome o Edge para elegir carpetas con este flujo.");
}

async function onMapFolderPicked(mapPick) {
  if (!mapPick) return;
  pickOmsiBtn.disabled = true;
  pickMapFolderBtn.disabled = true;
  try {
    await logPickDebug("Paso 1 — carpeta de mapa", mapPick);
    setProgress("Ahora elige la carpeta OMSI 2 (omsi.exe) para Splines y Sceneryobjects…");
    const assetPick = await pickOmsiAssetsRoot(setProgress);
    if (!assetPick) {
      setProgress("");
      return;
    }
    await logPickDebug("Paso 2 — OMSI 2 (assets)", assetPick, { append: true });

    omsiRoot = combineMapAndAssetRoots(mapPick, assetPick);
    omsiRootLabel = omsiRoot.label;
    omsiPathLabel.textContent = omsiRootLabel;
    omsiPathLabel.classList.remove("muted");

    await populateOmsiMapSelect([
      { dir: mapPick.mapDir, folder: mapPick.folder, label: mapPick.label },
    ]);
    omsiMapSelect.value = mapPick.mapDir;
    updateGlobalCfgUi();
    setProgress("Elige global.cfg del mapa y pulsa Cargar.");
  } catch (err) {
    omsiRoot = null;
    clearGlobalCfgSelection();
    omsiPathLabel.textContent = "Sin carpeta seleccionada";
    omsiPathLabel.classList.add("muted");
    alertWithDebug(err, "Error al cargar mapa directo");
    setProgress("");
  } finally {
    pickOmsiBtn.disabled = false;
    pickMapFolderBtn.disabled = false;
  }
}

async function onOmsiFolderPicked(result) {
  if (!result) return;
  pickOmsiBtn.disabled = true;
  pickMapFolderBtn.disabled = true;
  clearGlobalCfgSelection();
  setProgress("Conectando con OMSI 2…");
  try {
    await logPickDebug("Carpeta OMSI 2 elegida", result);
    omsiRoot = result;
    omsiRootLabel = result.label;
    omsiPathLabel.textContent = omsiRootLabel;
    omsiPathLabel.classList.remove("muted");

    let catalog;
    if (result.mode === "fsa") {
      const scanResult = await scanMapsCatalogFromHandle(result.rootHandle, setProgress);
      catalog = scanResult.catalog;
      debugPrint(
        appendSection(
          (debugLogEl?.textContent || "").split("\n"),
          [
            "=== Resultado escaneo maps/ ===",
            `Mapas listados: ${catalog.length}`,
            ...scanResult.scanLog,
            ...catalog.map((e) => `  · ${e.dir} (${e.label})`),
          ],
        ),
      );
    } else {
      validateOmsiInstall(result.fileMap);
      catalog = await listMapCatalog(result.fileMap);
      debugPrint(
        appendSection(
          (debugLogEl?.textContent || "").split("\n"),
          [`=== Resultado listMapCatalog ===`, `Mapas encontrados: ${catalog.length}`, ...catalog.map((e) => `  · ${e.dir} (${e.label})`)],
        ),
      );
    }

    await populateOmsiMapSelect(catalog);
  } catch (err) {
    omsiRoot = null;
    clearGlobalCfgSelection();
    omsiPathLabel.textContent = "Sin carpeta seleccionada";
    omsiPathLabel.classList.add("muted");
    omsiMapSelect.innerHTML = '<option value="">— Elige primero la carpeta OMSI 2 —</option>';
    omsiMapSelect.disabled = true;
    alertWithDebug(err, "Error al listar mapas");
    setProgress("");
  } finally {
    pickOmsiBtn.disabled = false;
    pickMapFolderBtn.disabled = false;
  }
}

async function loadSelectedOmsiMap() {
  const mapDir = omsiMapSelect.value;
  if (!mapDir || !omsiRoot) return;
  if (!selectedGlobalCfg || selectedGlobalCfgMapDir !== mapDir) {
    alert("Debes elegir global.cfg del mapa antes de cargar.\n\nPulsa «Elegir global.cfg…» y abre el archivo dentro de la carpeta del mapa.");
    return;
  }
  try {
    mapSelect.value = "";
    const startedAt = performance.now();
    setProgress(`Cargando ${mapDir.split("/").pop()}…`);
    const processStart = performance.now();
    const json = await loadMapLazy(omsiRoot, mapDir, setProgress, {
      globalCfgFile: selectedGlobalCfg,
    });
    const processMs = performance.now() - processStart;
    await applyData(json, { startedAt, processMs });
    setProgress(`Listo — ${formatLoadTiming(loadTiming)}`);
  } catch (err) {
    alertWithDebug(err, "Error al cargar mapa");
    setProgress("");
  }
}

async function onPickGlobalCfg() {
  const mapDir = omsiMapSelect.value;
  if (!mapDir) {
    alert("Elige primero un mapa en el desplegable.");
    return;
  }
  const folder = mapDir.split("/").pop();
  try {
    setProgress(`Abre global.cfg de ${folder}…`);
    const picked = await pickGlobalCfgFile();
    if (!picked) {
      setProgress("");
      return;
    }
    selectedGlobalCfg = picked.file;
    selectedGlobalCfgMapDir = mapDir;
    updateGlobalCfgUi();
    setProgress(`global.cfg listo — pulsa Cargar mapa para ${folder}.`);
    debugPrint(
      appendSection((debugLogEl?.textContent || "").split("\n"), [
        "=== global.cfg elegido manualmente ===",
        `Mapa: ${mapDir}`,
        `Archivo: ${picked.file.name} (${picked.file.size} bytes)`,
      ]),
    );
  } catch (err) {
    alertWithDebug(err, "Error al elegir global.cfg");
    setProgress("");
  }
}

pickOmsiBtn.addEventListener("click", async () => {
  try {
    await onOmsiFolderPicked(await pickOmsiRoot(setProgress));
  } catch (err) {
    alertWithDebug(err, "Error al elegir OMSI 2");
  }
});

pickMapFolderBtn.addEventListener("click", async () => {
  try {
    await onMapFolderPicked(await pickMapFolder(setProgress));
  } catch (err) {
    alertWithDebug(err, "Error al elegir carpeta de mapa");
  }
});

loadOmsiMapBtn.addEventListener("click", loadSelectedOmsiMap);

pickGlobalCfgBtn.addEventListener("click", () => {
  onPickGlobalCfg().catch((err) => alertWithDebug(err, "Error al elegir global.cfg"));
});

omsiMapSelect.addEventListener("change", () => {
  clearGlobalCfgSelection();
  updateGlobalCfgUi();
});

mapSelect.addEventListener("change", async () => {
  const file = mapSelect.value;
  if (!file) return;
  try {
    setProgress("Cargando demo…");
    const startedAt = performance.now();
    const json = await loadMapFile(file);
    const processMs = performance.now() - startedAt;
    await applyData(json, { startedAt, processMs });
    setProgress(`Mapa precargado — ${formatLoadTiming(loadTiming)}`);
  } catch (err) {
    alert(err.message);
  }
});

fileInput.addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    const startedAt = performance.now();
    const text = await file.text();
    const json = JSON.parse(text);
    const processMs = performance.now() - startedAt;
    await applyData(json, { startedAt, processMs });
    mapSelect.value = "";
    setProgress(`JSON cargado — ${formatLoadTiming(loadTiming)}`);
  } catch {
    alert("JSON inválido");
  }
});

[showAllRails, showFreeOnly, showBusstops].forEach((el) => {
  el.addEventListener("change", () => {
    if (showFreeOnly.checked) showAllRails.checked = true;
    scheduleDraw();
    updateStats();
  });
});

resetViewBtn.addEventListener("click", () => {
  if (data?.bounds) fitBounds(data.bounds);
  scheduleDraw();
});

canvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const factor = ev.deltaY < 0 ? 1.12 : 0.89;
  const before = screenToWorld(ev.offsetX, ev.offsetY);
  view.scale *= factor;
  view.scale = Math.max(0.02, Math.min(view.scale, 800));
  const after = screenToWorld(ev.offsetX, ev.offsetY);
  view.offsetX += before.x - after.x;
  view.offsetY += before.z - after.z;
  scheduleDraw();
}, { passive: false });

canvas.addEventListener("pointerdown", (ev) => {
  dragging = true;
  panAnchor = {
    x: ev.clientX,
    y: ev.clientY,
    offsetX: view.offsetX,
    offsetY: view.offsetY,
  };
  snapshotCanvas();
  canvas.setPointerCapture(ev.pointerId);
});

canvas.addEventListener("pointermove", (ev) => {
  if (!dragging || !panAnchor) return;
  const dx = ev.clientX - panAnchor.x;
  const dy = ev.clientY - panAnchor.y;
  drawPanPreview(dx, dy);
});

canvas.addEventListener("pointerup", (ev) => {
  if (!dragging || !panAnchor) return;
  const dx = ev.clientX - panAnchor.x;
  const dy = ev.clientY - panAnchor.y;
  const moved = Math.hypot(dx, dy);
  dragging = false;
  panSnapshot = null;

  if (moved >= 4) {
    const panX = VIEW_MIRROR_X ? dx / view.scale : -dx / view.scale;
    view.offsetX = panAnchor.offsetX + panX;
    view.offsetY = panAnchor.offsetY - dy / view.scale;
    panAnchor = null;
    scheduleDraw();
    return;
  }

  panAnchor = null;
  const rail = findRailAt(ev.offsetX, ev.offsetY);
  selectedRailId = rail?.id || null;
  updateInfo(rail);
  scheduleDraw();
});

canvas.addEventListener("pointercancel", () => {
  dragging = false;
  panSnapshot = null;
  panAnchor = null;
});

function buildLegend() {
  legendEl.innerHTML = Object.entries(RAIL_TYP)
    .map(([k, v]) => `<span><i style="background:${v.stroke}"></i>${v.label}</span>`)
    .join("");
  legendEl.innerHTML += `<span><i style="background:${FREE_START.stroke}"></i>Inicio libre</span>`;
  legendEl.innerHTML += `<span><i style="background:${BUSSTOP.fill}"></i>Busstop</span>`;
}

window.addEventListener("resize", resizeCanvas);
buildLegend();
loadManifest().then(() => resizeCanvas());
