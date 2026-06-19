import { RAIL_TYP, ROUTE_PALETTE, FREE_START, BUSSTOP, SELECTED } from "./colors.js";
import { distPointPolyline } from "./geometry.js";
import {
  loadFilesFromInput,
  listMapsInFiles,
  processMapFolder,
  detectOmsiPrefix,
  mergeFileMaps,
} from "./map_processor.js";

const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const mapSelect = document.getElementById("mapSelect");
const routeList = document.getElementById("routeList");
const fileInput = document.getElementById("fileInput");
const folderInput = document.getElementById("folderInput");
const assetsInput = document.getElementById("assetsInput");
const localMapSelect = document.getElementById("localMapSelect");
const loadLocalMapBtn = document.getElementById("loadLocalMapBtn");
const showAllRails = document.getElementById("showAllRails");
const showFreeOnly = document.getElementById("showFreeOnly");
const showBusstops = document.getElementById("showBusstops");
const statsEl = document.getElementById("stats");
const progressEl = document.getElementById("progress");
const infoEl = document.getElementById("infoPanel");
const legendEl = document.getElementById("legend");
const resetViewBtn = document.getElementById("resetView");

let data = null;
let view = { scale: 1, offsetX: 0, offsetY: 0 };
let dragging = false;
let lastPointer = { x: 0, y: 0 };
let selectedRailId = null;
let selectedRoutes = new Set();
let pendingFileMap = null;

function railPoints(rail) {
  if (rail.points?.length >= 2) return rail.points;
  if (rail.start && rail.end) return [rail.start, rail.end];
  return [];
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
  draw();
}

function worldToScreen(x, z) {
  return {
    x: (x - view.offsetX) * view.scale + canvas.clientWidth / 2,
    y: (z - view.offsetY) * view.scale + canvas.clientHeight / 2,
  };
}

function screenToWorld(sx, sy) {
  return {
    x: (sx - canvas.clientWidth / 2) / view.scale + view.offsetX,
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
  if (!data?.rails) return null;
  const { x, z } = screenToWorld(sx, sy);
  const worldThreshold = threshold / view.scale;
  let best = null;
  let bestD = worldThreshold;
  for (const rail of data.rails) {
    const pts = railPoints(rail);
    if (pts.length < 2) continue;
    const d = distPointPolyline(x, z, pts);
    if (d < bestD) {
      bestD = d;
      best = rail;
    }
  }
  return best;
}

function strokeRail(points, style) {
  if (points.length < 2) return;
  ctx.beginPath();
  const first = worldToScreen(points[0][0], points[0][2]);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i += 1) {
    const p = worldToScreen(points[i][0], points[i][2]);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
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
    ctx.fillText("Elige un mapa, sube JSON o abre carpeta OMSI", w / 2, h / 2);
    return;
  }

  const routeRails = buildRouteRailMap();
  const showAll = showAllRails.checked;
  const freeOnly = showFreeOnly.checked;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const rail of data.rails) {
    const routeColors = routeRails.get(rail.id);
    const onRoute = routeColors && routeColors.length > 0;
    const pts = railPoints(rail);

    if (freeOnly && !rail.freeStart) continue;
    if (!showAll && !onRoute && !freeOnly) continue;
    if (!showAll && freeOnly && !rail.freeStart && !onRoute) continue;

    if (onRoute) {
      ctx.lineWidth = Math.max(4, 3 * view.scale * 0.08);
      ctx.strokeStyle = routeColors[0];
      ctx.shadowColor = routeColors[0];
      ctx.shadowBlur = 6;
    } else if (rail.freeStart && (showAll || freeOnly)) {
      ctx.lineWidth = Math.max(3, 2.5 * view.scale * 0.06);
      ctx.strokeStyle = FREE_START.stroke;
      ctx.shadowColor = FREE_START.glow;
      ctx.shadowBlur = 8;
    } else {
      const typ = RAIL_TYP[rail.typ] || RAIL_TYP[0];
      ctx.lineWidth = Math.max(1.2, 1.5 * view.scale * 0.04);
      ctx.strokeStyle = typ.stroke;
      ctx.shadowBlur = 0;
    }

    if (selectedRailId === rail.id) {
      ctx.lineWidth += 2;
      ctx.strokeStyle = SELECTED.stroke;
    }

    strokeRail(pts, null);
    ctx.shadowBlur = 0;
  }

  if (showBusstops.checked && data.busstops) {
    const r = Math.max(5, 4 * view.scale * 0.05);
    for (const stop of data.busstops) {
      const p = worldToScreen(stop.x, stop.z);
      ctx.fillStyle = BUSSTOP.fill;
      ctx.strokeStyle = BUSSTOP.stroke;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

function updateStats() {
  if (!data) {
    statsEl.textContent = "";
    return;
  }
  const s = data.stats || {};
  let text =
    `${data.mapName} · ${s.railCount ?? data.rails.length} rieles · ` +
    `${s.freeStartCount ?? 0} libres · ${s.busstopCount ?? data.busstops.length} paradas · ` +
    `${s.routeCount ?? data.routes.length} rutas`;
  if (s.sliMissing > 0 || s.scoMissing > 0) {
    text += ` · faltan ${s.sliMissing ?? 0} .sli / ${s.scoMissing ?? 0} .sco`;
  }
  statsEl.textContent = text;
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
  infoEl.innerHTML = `
    <strong>${rail.id}</strong><br/>
    Tipo: ${typLabel}<br/>
    Longitud: ${rail.length} m<br/>
    Radio: ${radiusText}<br/>
    Tile: ${rail.tile || "—"}<br/>
    Inicio libre: ${rail.freeStart ? "sí" : "no"}<br/>
    Vehículo: ${rail.vehicle ? "sí" : "no"}
  `;
}

function populateRoutes() {
  routeList.innerHTML = "";
  selectedRoutes.clear();
  if (!data?.routes?.length) {
    routeList.innerHTML = "<p class='muted'>Sin rutas (.ttr) en este mapa</p>";
    draw();
    return;
  }

  data.routes.forEach((route, idx) => {
    const id = `route-${idx}`;
    const wrap = document.createElement("label");
    wrap.className = "route-item";
    const color = routeColor(idx);
    wrap.innerHTML = `
      <input type="checkbox" id="${id}" data-route-id="${route.id}" />
      <span class="swatch" style="background:${color}"></span>
      <span class="route-label">${route.label || route.file}</span>
      <span class="route-meta">${(route.railIds || []).length} rieles</span>
    `;
    const cb = wrap.querySelector("input");
    cb.addEventListener("change", () => {
      if (cb.checked) selectedRoutes.add(route.id);
      else selectedRoutes.delete(route.id);
      draw();
    });
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

async function applyData(json) {
  data = json;
  selectedRailId = null;
  fitBounds(data.bounds);
  updateStats();
  populateRoutes();
  updateInfo(null);
  progressEl.textContent = "";
  draw();
}

function setProgress(msg) {
  progressEl.textContent = msg;
}

mapSelect.addEventListener("change", async () => {
  const file = mapSelect.value;
  if (!file) return;
  try {
    await applyData(await loadMapFile(file));
  } catch (err) {
    alert(err.message);
  }
});

fileInput.addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    await applyData(JSON.parse(text));
    mapSelect.value = "";
    localMapSelect.innerHTML = "";
  } catch {
    alert("JSON inválido");
  }
});

folderInput.addEventListener("change", async (ev) => {
  const fileList = ev.target.files;
  if (!fileList?.length) return;
  try {
    pendingFileMap = await loadFilesFromInput(fileList);
    await afterFilesLoaded();
  } catch (err) {
    alert(err.message || String(err));
  }
});

assetsInput.addEventListener("change", async (ev) => {
  const fileList = ev.target.files;
  if (!fileList?.length) return;
  try {
    const extra = await loadFilesFromInput(fileList);
    pendingFileMap = pendingFileMap ? mergeFileMaps(pendingFileMap, extra) : extra;
    await afterFilesLoaded(true);
  } catch (err) {
    alert(err.message || String(err));
  }
});

async function afterFilesLoaded(reloadCurrent = false) {
  const maps = listMapsInFiles(pendingFileMap);
  if (!maps.length) {
    alert("No se encontró global.cfg. Selecciona la carpeta del mapa (con tiles y TTData).");
    return;
  }
  localMapSelect.innerHTML = maps
    .map((m) => `<option value="${m}">${m.split("/").pop() || m}</option>`)
    .join("");

  const omsi = detectOmsiPrefix(pendingFileMap);
  const hasSplines = [...pendingFileMap.keys()].some((k) => /splines\//i.test(k.replace(/\\/g, "/")));
  const hasScenery = [...pendingFileMap.keys()].some((k) => /sceneryobjects\//i.test(k.replace(/\\/g, "/")));

  if (!hasSplines && !hasScenery && !omsi) {
    setProgress(
      "Mapa cargado. Añade Splines + Sceneryobjects (botón de abajo) para ver todos los rieles.",
    );
  }

  const current = localMapSelect.value;
  if (reloadCurrent && current) {
    await loadLocalMap(current);
    return;
  }
  if (maps.length === 1) {
    await loadLocalMap(maps[0]);
  } else {
    setProgress(`${maps.length} mapas detectados — elige uno y pulsa Cargar.`);
  }
}

async function loadLocalMap(mapDir) {
  if (!pendingFileMap) return;
  try {
    mapSelect.value = "";
    const json = await processMapFolder(pendingFileMap, mapDir, setProgress);
    await applyData(json);
  } catch (err) {
    alert(err.message || String(err));
    setProgress("");
  }
}

loadLocalMapBtn.addEventListener("click", () => {
  const mapDir = localMapSelect.value;
  if (mapDir) loadLocalMap(mapDir);
});

[showAllRails, showFreeOnly, showBusstops].forEach((el) => {
  el.addEventListener("change", () => {
    if (showFreeOnly.checked) showAllRails.checked = true;
    draw();
  });
});

resetViewBtn.addEventListener("click", () => {
  if (data?.bounds) fitBounds(data.bounds);
  draw();
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
  draw();
}, { passive: false });

canvas.addEventListener("pointerdown", (ev) => {
  dragging = true;
  lastPointer = { x: ev.clientX, y: ev.clientY };
  canvas.setPointerCapture(ev.pointerId);
});

canvas.addEventListener("pointermove", (ev) => {
  if (!dragging) return;
  const dx = ev.clientX - lastPointer.x;
  const dy = ev.clientY - lastPointer.y;
  view.offsetX -= dx / view.scale;
  view.offsetY -= dy / view.scale;
  lastPointer = { x: ev.clientX, y: ev.clientY };
  draw();
});

canvas.addEventListener("pointerup", (ev) => {
  if (!dragging) return;
  const moved = Math.hypot(ev.clientX - lastPointer.x, ev.clientY - lastPointer.y);
  dragging = false;
  if (moved < 4) {
    const rail = findRailAt(ev.offsetX, ev.offsetY);
    selectedRailId = rail?.id || null;
    updateInfo(rail);
    draw();
  }
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
loadManifest().then(async () => {
  resizeCanvas();
  if (mapSelect.options.length > 1) {
    mapSelect.selectedIndex = 1;
    mapSelect.dispatchEvent(new Event("change"));
  }
});
