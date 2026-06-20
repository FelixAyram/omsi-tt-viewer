// Acceso lazy a instalación OMSI 2:
// 1) Validar raíz y listar global.cfg en subcarpetas de maps/
// 2) Al elegir mapa: cargar tiles, TTData y .sli/.sco referenciados

import { readOmsiText } from "./omsi_text.js?v=35";

function normPath(path) {
  return path.replace(/\\/g, "/");
}

async function getChildDirHandle(parent, ...names) {
  for (const name of names) {
    try {
      return await parent.getDirectoryHandle(name);
    } catch {
      // probar otro alias
    }
  }
  for await (const [name, handle] of parent.entries()) {
    if (handle.kind !== "directory") continue;
    if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) continue;
    try {
      return await parent.getDirectoryHandle(name);
    } catch {
      return handle;
    }
  }
  return null;
}

function mapFilePrefix(fullFileMap, mapDir) {
  const dir = normPath(mapDir).replace(/\/$/, "");
  const dirLower = dir.toLowerCase();
  const folder = dir.split("/").pop() || dir;

  for (const k of fullFileMap.keys()) {
    const n = normPath(k);
    const nl = n.toLowerCase();
    if (nl === `${dirLower}/global.cfg` || nl.endsWith(`/${dirLower}/global.cfg`)) {
      return n.slice(0, n.length - "global.cfg".length);
    }
  }

  const re = new RegExp(`(^|/)maps/${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, "i");
  for (const k of fullFileMap.keys()) {
    const n = normPath(k);
    const m = re.exec(n);
    if (m) {
      const start = m.index + (m[1] === "/" ? 1 : 0);
      return n.slice(0, start + `maps/${folder}/`.length);
    }
  }

  return dir.endsWith("/") ? dir : `${dir}/`;
}

function parseGlobalName(text) {
  const m = /\[name\]\s*\r?\n([^\r\n\[]+)/i.exec(text);
  return m ? m[1].trim() : "";
}

async function ensureReadPermission(handle) {
  if (typeof handle.queryPermission !== "function") return "granted";
  let perm = await handle.queryPermission({ mode: "read" });
  if (perm !== "granted" && typeof handle.requestPermission === "function") {
    perm = await handle.requestPermission({ mode: "read" });
  }
  return perm;
}

async function getFileHandleInsensitive(dirHandle, baseName) {
  const want = baseName.toLowerCase();
  const variants = new Set([
    baseName,
    baseName.toLowerCase(),
    baseName.toUpperCase(),
    "Global.cfg",
    "GLOBAL.CFG",
  ]);
  for (const name of variants) {
    try {
      return await dirHandle.getFileHandle(name);
    } catch {
      // siguiente variante
    }
  }
  try {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind !== "file" || name.toLowerCase() !== want) continue;
      try {
        return await dirHandle.getFileHandle(name);
      } catch {
        return handle;
      }
    }
  } catch {
    // entries puede fallar
  }
  throw new Error(`No se encontró ${baseName}`);
}

async function navigateFromRoot(rootHandle, relPath) {
  const parts = normPath(relPath).split("/").filter(Boolean);
  let cur = rootHandle;
  for (const part of parts) {
    const next = await getChildDirHandle(cur, part);
    if (!next) {
      throw new Error(`No se encontró: ${part} (ruta ${parts.join("/")})`);
    }
    cur = next;
    const perm = await ensureReadPermission(cur);
    if (perm !== "granted") {
      throw new Error(`Sin permiso de lectura en ${part}`);
    }
  }
  return cur;
}

async function readFileFromRoot(rootHandle, relPath) {
  const parts = normPath(relPath).split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Ruta inválida: ${relPath}`);
  }
  const dirPath = parts.slice(0, -1).join("/");
  const fileName = parts[parts.length - 1];
  const dirHandle = await navigateFromRoot(rootHandle, dirPath);
  const fh = await getFileHandleInsensitive(dirHandle, fileName);
  return fh.getFile();
}

async function readTextFromRoot(rootHandle, relPath) {
  const file = await readFileFromRoot(rootHandle, relPath);
  return readOmsiText(file);
}

async function getDirHandle(rootHandle, relPath) {
  return navigateFromRoot(rootHandle, relPath);
}

async function readFileFromHandle(dirHandle, fileName) {
  const fh = await getFileHandleInsensitive(dirHandle, fileName);
  return fh.getFile();
}

export async function resolveMapBasePath(rootHandle, mapRelDir) {
  const folder = normPath(mapRelDir).split("/").pop();
  const mapsDir = await getChildDirHandle(rootHandle, "maps", "Maps");
  if (!mapsDir) throw new Error("No se encontró maps/ en OMSI 2.");
  const mapDirHandle = await getChildDirHandle(mapsDir, folder);
  if (!mapDirHandle) throw new Error(`No se encontró la carpeta del mapa: ${folder}`);
  return `${mapsDir.name}/${folder}`;
}

function canonicalMapPrefix(mapRelDir) {
  const folder = normPath(mapRelDir).split("/").pop();
  return `maps/${folder}`;
}

function shouldSkipMapSubdir(name) {
  return name.startsWith("_") || name.toLowerCase() === "copia";
}

async function seedMapRootFiles(rootHandle, basePath, canonPrefix, fileMap, tileHints = new Set()) {
  const mapDirHandle = await navigateFromRoot(rootHandle, basePath);

  try {
    const gf = await getFileHandleInsensitive(mapDirHandle, "global.cfg");
    fileMap.set(`${canonPrefix}/global.cfg`, await gf.getFile());
  } catch {
    try {
      fileMap.set(`${canonPrefix}/global.cfg`, await readFileFromRoot(rootHandle, `${basePath}/global.cfg`));
    } catch {
      // se reintentará al procesar
    }
  }

  for (const k of fileMap.keys()) {
    const m = /\/(tile_-?\d+_-?\d+\.map)$/i.exec(normPath(k));
    if (m) tileHints.add(m[1]);
  }
  try {
    for await (const [name] of mapDirHandle.entries()) {
      if (/^tile_-?\d+_-?\d+\.map$/i.test(name)) tileHints.add(name);
    }
  } catch {
    // omitir
  }

  for (const tileName of tileHints) {
    const canon = `${canonPrefix}/${tileName}`;
    if (fileMap.has(canon)) continue;
    try {
      const fh = await getFileHandleInsensitive(mapDirHandle, tileName);
      fileMap.set(canon, await fh.getFile());
    } catch {
      try {
        fileMap.set(canon, await readFileFromRoot(rootHandle, `${basePath}/${tileName}`));
      } catch {
        // tile no en raíz del mapa
      }
    }
  }
}

// Recorre subcarpetas del mapa (TTData, texture…). La raíz del mapa va en seedMapRootFiles.
async function collectDirFromRoot(rootHandle, diskPath, canonPrefix, fileMap) {
  const dirHandle = await navigateFromRoot(rootHandle, diskPath);
  const entries = [];
  for await (const [name, entry] of dirHandle.entries()) {
    entries.push({ name, kind: entry.kind });
  }

  for (const { name, kind } of entries) {
    const diskChild = `${diskPath}/${name}`;
    const canonChild = `${canonPrefix}/${name}`;

    if (kind === "directory") {
      if (shouldSkipMapSubdir(name)) continue;
      await collectDirFromRoot(rootHandle, diskChild, canonChild, fileMap);
      continue;
    }

    try {
      const fh = await getFileHandleInsensitive(dirHandle, name);
      fileMap.set(normPath(canonChild), await fh.getFile());
    } catch {
      try {
        fileMap.set(normPath(canonChild), await readFileFromRoot(rootHandle, diskChild));
      } catch {
        // omitir archivo
      }
    }
  }
}

async function collectMapTreeFromRoot(rootHandle, mapRelDir, fileMap) {
  const basePath = await resolveMapBasePath(rootHandle, mapRelDir);
  const canonPrefix = canonicalMapPrefix(mapRelDir);

  await seedMapRootFiles(rootHandle, basePath, canonPrefix, fileMap);
  await collectDirFromRoot(rootHandle, basePath, canonPrefix, fileMap);
  await seedMapRootFiles(rootHandle, basePath, canonPrefix, fileMap);
}

async function collectMapTreeFromHandle(mapHandle, mapRelDir, fileMap) {
  const canonPrefix = canonicalMapPrefix(mapRelDir);
  await seedMapRootFromHandle(mapHandle, canonPrefix, fileMap);
  await collectDirFromHandle(mapHandle, canonPrefix, fileMap);
  await seedMapRootFromHandle(mapHandle, canonPrefix, fileMap);
}

async function seedMapRootFromHandle(mapHandle, canonPrefix, fileMap, tileHints = new Set()) {
  try {
    const gf = await getFileHandleInsensitive(mapHandle, "global.cfg");
    fileMap.set(`${canonPrefix}/global.cfg`, await gf.getFile());
  } catch {
    // omitir
  }
  for (const k of fileMap.keys()) {
    const m = /\/(tile_-?\d+_-?\d+\.map)$/i.exec(normPath(k));
    if (m) tileHints.add(m[1]);
  }
  for await (const [name] of mapHandle.entries()) {
    if (/^tile_-?\d+_-?\d+\.map$/i.test(name)) tileHints.add(name);
  }
  for (const tileName of tileHints) {
    const canon = `${canonPrefix}/${tileName}`;
    if (fileMap.has(canon)) continue;
    try {
      fileMap.set(canon, await readFileFromHandle(mapHandle, tileName));
    } catch {
      // omitir
    }
  }
}

async function collectDirFromHandle(dirHandle, canonPrefix, fileMap) {
  const entries = [];
  for await (const [name, entry] of dirHandle.entries()) {
    entries.push({ name, kind: entry.kind });
  }

  for (const { name, kind } of entries) {
    const canonChild = `${canonPrefix}/${name}`;
    if (kind === "directory") {
      if (shouldSkipMapSubdir(name)) continue;
      try {
        const sub = await dirHandle.getDirectoryHandle(name);
        await collectDirFromHandle(sub, canonChild, fileMap);
      } catch {
        // omitir
      }
      continue;
    }
    try {
      fileMap.set(normPath(canonChild), await readFileFromHandle(dirHandle, name));
    } catch {
      // omitir
    }
  }
}

export async function ensureMapRootInFileMap(rootHandle, mapRelDir, fileMap) {
  const basePath = await resolveMapBasePath(rootHandle, mapRelDir);
  const canonPrefix = canonicalMapPrefix(mapRelDir);
  await seedMapRootFiles(rootHandle, basePath, canonPrefix, fileMap);
}

// Valida maps/, Splines/, Sceneryobjects/ sin leer todo el árbol.
export async function validateOmsiRootHandle(rootHandle) {
  const required = [
    ["maps"],
    ["Splines", "splines"],
    ["Sceneryobjects", "sceneryobjects"],
  ];
  const missing = [];
  for (const names of required) {
    const handle = await getChildDirHandle(rootHandle, ...names);
    if (!handle) missing.push(`${names[0]}/`);
  }
  if (missing.length) {
    throw new Error(
      "No parece la carpeta raíz de OMSI 2. Falta: " +
        missing.join(", ") +
        ". Selecciona la carpeta donde está omsi.exe.",
    );
  }
}

// Solo escanea global.cfg en cada subcarpeta de maps/ (rápido).
export async function scanMapsCatalogFromHandle(rootHandle, onProgress = null) {
  onProgress?.("Listando mapas en maps/…");
  await ensureReadPermission(rootHandle);
  const mapsDir = await getChildDirHandle(rootHandle, "maps", "Maps");
  if (!mapsDir) {
    throw new Error("No se encontró la carpeta maps/ en la instalación OMSI 2.");
  }
  await ensureReadPermission(mapsDir);
  const mapsDirName = mapsDir.name;
  const entries = [];
  const scanLog = [];
  for await (const [folderName, child] of mapsDir.entries()) {
    if (child.kind !== "directory") {
      scanLog.push(`${folderName} [archivo, ignorado]`);
      continue;
    }
    if (folderName.startsWith("_")) {
      scanLog.push(`${folderName}/ [omitida, empieza por _]`);
      continue;
    }
    let label = folderName;
    let readOk = false;
    const cfgPath = `${mapsDirName}/${folderName}/global.cfg`;
    try {
      const text = await readTextFromRoot(rootHandle, cfgPath);
      const cfgName = parseGlobalName(text);
      if (cfgName && cfgName.toLowerCase() !== folderName.toLowerCase()) {
        label = `${folderName} — ${cfgName}`;
      }
      readOk = true;
      scanLog.push(`${folderName}/ → global.cfg OK (desde raíz)`);
    } catch (err) {
      scanLog.push(`${folderName}/ → global.cfg: ${err.name || "Error"}: ${err.message}`);
    }
    entries.push({ dir: `maps/${folderName}`, folder: folderName, label, cfgReadable: readOk });
  }
  if (!entries.length) {
    const err = new Error("maps/ no tiene subcarpetas de mapas.");
    err.scanLog = scanLog;
    throw err;
  }
  const readable = entries.filter((e) => e.cfgReadable).length;
  if (readable === 0) {
    scanLog.push("");
    scanLog.push(
      "Aviso: no se pudo leer global.cfg en ningún mapa, pero se listan las carpetas. " +
        "Prueba «Elegir carpeta de mapa…» si al cargar falla.",
    );
  }
  return {
    catalog: entries
      .map(({ dir, folder, label }) => ({ dir, folder, label }))
      .sort((a, b) => a.folder.localeCompare(b.folder, undefined, { sensitivity: "base" })),
    scanLog,
  };
}

// Carga carpeta del mapa + .sli y .sco referenciados bajo demanda.
export async function buildMapFileMapLazy(
  rootHandle,
  mapRelDir,
  collectAssetRefs,
  onProgress = null,
  mapHandleOverride = null,
) {
  const mapDir = normPath(mapRelDir);
  const fileMap = new Map();

  onProgress?.("Cargando tiles y TTData del mapa…");
  if (mapHandleOverride) {
    await collectMapTreeFromHandle(mapHandleOverride, mapDir, fileMap);
  } else {
    await collectMapTreeFromRoot(rootHandle, mapDir, fileMap);
  }

  const tileCount = [...fileMap.keys()].filter((k) => /tile_-?\d+_-?\d+\.map$/i.test(k)).length;
  const hasGlobal = [...fileMap.keys()].some((k) => /global\.cfg$/i.test(k));
  onProgress?.(`Mapa: ${tileCount} tiles, global.cfg ${hasGlobal ? "OK" : "NO"}`);

  onProgress?.("Analizando .map → referencias .sli / .sco…");
  const { sliPaths, scoPaths } = await collectAssetRefs(fileMap, mapDir);

  const allAssets = [...sliPaths, ...scoPaths];
  let i = 0;
  for (const rel of allAssets) {
    i += 1;
    const name = rel.split("/").pop();
    onProgress?.(`Asset ${i}/${allAssets.length}: ${name}`);
    const rl = normPath(rel);
    if (fileMap.has(rl)) continue;
    try {
      const file = await readFileFromRoot(rootHandle, rl);
      fileMap.set(rl, file);
    } catch {
      try {
        const file = await readFileFromRoot(rootHandle, rl.replace(/\//g, "\\"));
        fileMap.set(rl, file);
      } catch {
        // asset ausente
      }
    }
  }

  return fileMap;
}

export async function pickOmsiRoot(onProgress = null) {
  if (typeof window.showDirectoryPicker === "function") {
    try {
      const handle = await window.showDirectoryPicker({
        id: "omsi2-root",
        mode: "read",
      });
      onProgress?.("Validando instalación OMSI 2…");
      const perm = await ensureReadPermission(handle);
      if (perm !== "granted") {
        throw new Error("Se necesita permiso de lectura en la carpeta OMSI 2.");
      }
      await validateOmsiRootHandle(handle);
      return { mode: "fsa", label: handle.name, rootHandle: handle };
    } catch (err) {
      if (err?.name === "AbortError") return null;
      throw err;
    }
  }
  return pickOmsiRootWebkit(onProgress);
}

// Valida carpeta de un mapa (global.cfg + tiles).
export async function validateMapFolderHandle(mapHandle) {
  await ensureReadPermission(mapHandle);
  let hasGlobal = false;
  let hasTile = false;

  try {
    await readFileFromHandle(mapHandle, "global.cfg");
    hasGlobal = true;
  } catch {
    for await (const [name] of mapHandle.entries()) {
      if (name.toLowerCase() === "global.cfg") {
        try {
          await readFileFromHandle(mapHandle, name);
          hasGlobal = true;
          break;
        } catch {
          // seguir
        }
      }
    }
  }

  for await (const [name] of mapHandle.entries()) {
    if (/tile_-?\d+_-?\d+\.map$/i.test(name)) {
      hasTile = true;
      break;
    }
  }

  if (!hasGlobal) {
    throw new Error("No hay global.cfg en la carpeta elegida.");
  }
  if (!hasTile) {
    throw new Error("La carpeta no contiene tiles tile_*.map. Elige la carpeta del mapa (ej. maps/Test_Lat30).");
  }
  const folder = mapHandle.name;
  let label = folder;
  try {
    const gf = await readFileFromHandle(mapHandle, "global.cfg");
    const cfgName = parseGlobalName(await readOmsiText(await gf.getFile()));
    if (cfgName && cfgName.toLowerCase() !== folder.toLowerCase()) {
      label = `${folder} — ${cfgName}`;
    }
  } catch {
    // usar nombre de carpeta
  }
  return { mapDir: `maps/${folder}`, folder, label };
}

export function inspectMapFolderWebkit(fileMap) {
  const keys = [...fileMap.keys()].map(normPath);
  const globalKey = keys.find((k) => /(?:^|\/)global\.cfg$/i.test(k));
  if (!globalKey) {
    throw new Error("No hay global.cfg. Elige la carpeta del mapa (ej. …/maps/Test_Lat30).");
  }
  const hasTile = keys.some((k) => /tile_-?\d+_-?\d+\.map$/i.test(k));
  if (!hasTile) {
    throw new Error("No hay tiles tile_*.map en la carpeta elegida.");
  }

  let folder;
  let flatPaths = false;
  const nested = /(?:^|\/)maps\/([^/]+)\/global\.cfg$/i.exec(globalKey);
  if (nested) {
    folder = nested[1];
  } else {
    const parts = globalKey.split("/");
    if (parts.length === 1) {
      flatPaths = true;
      folder = "Mapa";
    } else {
      folder = parts[parts.length - 2];
    }
  }

  return { mapDir: `maps/${folder}`, folder, flatPaths, globalKey };
}

export function normalizeMapFileKeys(fileMap, mapDir) {
  const folder = mapDir.split("/").pop() || "Mapa";
  const out = new Map();
  for (const [k, f] of fileMap) {
    const n = normPath(k);
    if (!n.includes("/")) {
      out.set(`maps/${folder}/${n}`, f);
    } else if (/^maps\//i.test(n)) {
      out.set(n, f);
    } else {
      out.set(`maps/${folder}/${n}`, f);
    }
  }
  return out;
}

export async function pickMapFolder(onProgress = null) {
  if (typeof window.showDirectoryPicker === "function") {
    try {
      const handle = await window.showDirectoryPicker({
        id: "omsi2-map-folder",
        mode: "read",
      });
      onProgress?.("Validando carpeta del mapa…");
      const info = await validateMapFolderHandle(handle);
      return { mode: "fsa-map", mapHandle: handle, ...info };
    } catch (err) {
      if (err?.name === "AbortError") return null;
      throw err;
    }
  }
  return pickMapFolderWebkit(onProgress);
}

function pickMapFolderWebkit(onProgress = null) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", async () => {
      const files = input.files;
      document.body.removeChild(input);
      if (!files?.length) {
        resolve(null);
        return;
      }
      onProgress?.("Validando carpeta del mapa…");
      const fileMap = new Map();
      for (const f of files) {
        const rel = normPath(f.webkitRelativePath || f.name);
        if (rel) fileMap.set(rel, f);
      }
      try {
        const info = inspectMapFolderWebkit(fileMap);
        let folder = info.folder;
        let label = folder;
        const gfKey = [...fileMap.keys()].find((k) => /global\.cfg$/i.test(normPath(k)));
        if (gfKey) {
          const gfParts = normPath(gfKey).split("/");
          if (info.flatPaths && gfParts.length > 1) {
            folder = gfParts[gfParts.length - 2];
          }
          try {
            const cfgName = parseGlobalName(await readOmsiText(fileMap.get(gfKey)));
            if (cfgName) {
              label = folder && folder !== "Mapa" ? `${folder} — ${cfgName}` : cfgName;
              if (info.flatPaths && folder === "Mapa") folder = cfgName.slice(0, 48) || folder;
            }
          } catch {
            // ignorar
          }
        }
        const mapDir = `maps/${folder}`;
        resolve({
          mode: "webkit-map",
          fileMap: normalizeMapFileKeys(fileMap, mapDir),
          mapDir,
          folder,
          flatPaths: info.flatPaths,
          label,
        });
      } catch (err) {
        alert(err.message || String(err));
        resolve(null);
      }
    });
    input.click();
  });
}

// Solo Splines/ y Sceneryobjects/ (para combinar con carpeta de mapa).
export async function validateOmsiAssetsRootHandle(rootHandle) {
  const required = [
    ["Splines", "splines"],
    ["Sceneryobjects", "sceneryobjects"],
  ];
  const missing = [];
  for (const names of required) {
    const handle = await getChildDirHandle(rootHandle, ...names);
    if (!handle) missing.push(`${names[0]}/`);
  }
  if (missing.length) {
    throw new Error(
      "Falta: " +
        missing.join(", ") +
        ". Elige la carpeta raíz de OMSI 2 (donde está omsi.exe).",
    );
  }
}

export async function pickOmsiAssetsRoot(onProgress = null) {
  if (typeof window.showDirectoryPicker === "function") {
    try {
      const handle = await window.showDirectoryPicker({
        id: "omsi2-assets-root",
        mode: "read",
      });
      onProgress?.("Validando Splines y Sceneryobjects…");
      await validateOmsiAssetsRootHandle(handle);
      return { mode: "fsa", label: handle.name, rootHandle: handle };
    } catch (err) {
      if (err?.name === "AbortError") return null;
      throw err;
    }
  }
  return pickOmsiRootWebkit(onProgress);
}

function pickOmsiRootWebkit(onProgress = null) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const files = input.files;
      document.body.removeChild(input);
      if (!files?.length) {
        resolve(null);
        return;
      }
      onProgress?.("Indexando rutas (solo se usarán archivos del mapa elegido)…");
      const fileMap = new Map();
      let label = "OMSI 2";
      for (const f of files) {
        const rel = (f.webkitRelativePath || f.name).replace(/\\/g, "/");
        if (!rel) continue;
        fileMap.set(rel, f);
        if (rel.includes("/")) label = rel.split("/")[0];
      }
      resolve({ mode: "webkit", label, fileMap });
    });
    input.click();
  });
}

// Webkit: subset mapa + assets referenciados desde el fileMap completo.
export async function buildMapFileMapWebkit(fullFileMap, mapDir, collectAssetRefs, onProgress = null) {
  const pfx = mapFilePrefix(fullFileMap, mapDir);
  const mapFiles = new Map();

  onProgress?.("Extrayendo archivos del mapa…");
  for (const [k, f] of fullFileMap) {
    const n = normPath(k);
    if (n.startsWith(pfx)) {
      mapFiles.set(n, f);
    }
  }

  onProgress?.("Analizando .map → referencias .sli / .sco…");
  const { sliPaths, scoPaths } = await collectAssetRefs(mapFiles, mapDir);
  const needed = [...sliPaths, ...scoPaths];

  onProgress?.(`Buscando ${needed.length} assets en la carpeta OMSI…`);
  for (const rel of needed) {
    const rl = rel.replace(/\\/g, "/").toLowerCase();
    for (const [k, f] of fullFileMap) {
      const kl = k.replace(/\\/g, "/").toLowerCase();
      if (kl === rl || kl.endsWith(`/${rl}`)) {
        mapFiles.set(k.replace(/\\/g, "/"), f);
        break;
      }
    }
  }

  return mapFiles;
}

// Mapa en carpeta aparte + assets desde instalación OMSI (webkit).
export async function buildMapFileMapWebkitCombined(
  mapFileMap,
  assetFileMap,
  mapDir,
  collectAssetRefs,
  onProgress = null,
) {
  const mapFiles = new Map(mapFileMap);
  onProgress?.("Analizando .map → referencias .sli / .sco…");
  const { sliPaths, scoPaths } = await collectAssetRefs(mapFiles, mapDir);
  const needed = [...sliPaths, ...scoPaths];

  onProgress?.(`Buscando ${needed.length} assets en OMSI 2…`);
  for (const rel of needed) {
    const rl = normPath(rel).toLowerCase();
    for (const [k, f] of assetFileMap) {
      const kl = normPath(k).toLowerCase();
      if (kl === rl || kl.endsWith(`/${rl}`)) {
        mapFiles.set(normPath(k), f);
        break;
      }
    }
  }

  return mapFiles;
}

/** El usuario debe elegir global.cfg manualmente (showOpenFilePicker). */
export async function pickGlobalCfgFile() {
  if (typeof window.showOpenFilePicker === "function") {
    try {
      const [handle] = await window.showOpenFilePicker({
        id: "omsi-global-cfg",
        types: [
          {
            description: "OMSI global.cfg",
            accept: {
              "text/plain": [".cfg"],
              "application/octet-stream": [".cfg"],
            },
          },
        ],
        multiple: false,
      });
      const file = await handle.getFile();
      if (!/^global\.cfg$/i.test(file.name)) {
        throw new Error(`Archivo incorrecto: «${file.name}». Debe ser global.cfg del mapa.`);
      }
      return { file, label: file.name };
    } catch (err) {
      if (err?.name === "AbortError") return null;
      throw err;
    }
  }
  return pickGlobalCfgFileWebkit();
}

function pickGlobalCfgFileWebkit() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".cfg";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      document.body.removeChild(input);
      if (!file) {
        resolve(null);
        return;
      }
      if (!/^global\.cfg$/i.test(file.name)) {
        alert(`Debe ser global.cfg, no «${file.name}».`);
        resolve(null);
        return;
      }
      resolve({ file, label: file.name });
    });
    input.click();
  });
}
