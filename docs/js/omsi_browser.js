// Acceso lazy a instalación OMSI 2:
// 1) Validar raíz y listar global.cfg en subcarpetas de maps/
// 2) Al elegir mapa: cargar tiles, TTData y .sli/.sco referenciados

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
    if (handle.kind === "directory" && names.some((n) => n.toLowerCase() === name.toLowerCase())) {
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

async function getFileHandleInsensitive(dirHandle, baseName) {
  try {
    return await dirHandle.getFileHandle(baseName);
  } catch {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === "file" && name.toLowerCase() === baseName.toLowerCase()) {
        return handle;
      }
    }
    throw new Error(`No se encontró ${baseName}`);
  }
}

async function getDirHandle(rootHandle, relPath) {
  let cur = rootHandle;
  for (const part of relPath.replace(/\\/g, "/").split("/").filter(Boolean)) {
    cur = await cur.getDirectoryHandle(part);
  }
  return cur;
}

async function readFileFromRoot(rootHandle, relPath) {
  const parts = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  let cur = rootHandle;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur = await cur.getDirectoryHandle(parts[i]);
  }
  const fh = await cur.getFileHandle(parts[parts.length - 1]);
  return fh.getFile();
}

async function walkDirectoryToMap(dirHandle, prefix, fileMap) {
  for await (const [name, handle] of dirHandle.entries()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "file") {
      fileMap.set(rel.replace(/\\/g, "/"), await handle.getFile());
    } else if (handle.kind === "directory") {
      await walkDirectoryToMap(handle, rel, fileMap);
    }
  }
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
  const mapsDir = await getChildDirHandle(rootHandle, "maps", "Maps");
  if (!mapsDir) {
    throw new Error("No se encontró la carpeta maps/ en la instalación OMSI 2.");
  }
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
    try {
      const gf = await getFileHandleInsensitive(child, "global.cfg");
      const file = await gf.getFile();
      const cfgName = parseGlobalName(await file.text());
      let label = folderName;
      if (cfgName && cfgName.toLowerCase() !== folderName.toLowerCase()) {
        label = `${folderName} — ${cfgName}`;
      }
      entries.push({ dir: `maps/${folderName}`, folder: folderName, label });
      scanLog.push(`${folderName}/ → global.cfg OK`);
    } catch (err) {
      scanLog.push(`${folderName}/ → sin global.cfg (${err.message})`);
    }
  }
  if (!entries.length) {
    const err = new Error("No se encontraron mapas en maps/ (global.cfg por carpeta).");
    err.scanLog = scanLog;
    throw err;
  }
  return entries.sort((a, b) => a.folder.localeCompare(b.folder, undefined, { sensitivity: "base" }));
}

// Carga carpeta del mapa + .sli y .sco referenciados bajo demanda.
export async function buildMapFileMapLazy(
  rootHandle,
  mapRelDir,
  collectAssetRefs,
  onProgress = null,
  mapHandleOverride = null,
) {
  const mapDir = mapRelDir.replace(/\\/g, "/");
  const fileMap = new Map();

  onProgress?.("Cargando tiles y TTData del mapa…");
  const mapHandle = mapHandleOverride ?? (await getDirHandle(rootHandle, mapDir));
  await walkDirectoryToMap(mapHandle, mapDir, fileMap);

  onProgress?.("Analizando .map → referencias .sli / .sco…");
  const { sliPaths, scoPaths } = await collectAssetRefs(fileMap, mapDir);

  const allAssets = [...sliPaths, ...scoPaths];
  let i = 0;
  for (const rel of allAssets) {
    i += 1;
    const name = rel.split("/").pop();
    onProgress?.(`Asset ${i}/${allAssets.length}: ${name}`);
    try {
      const file = await readFileFromRoot(rootHandle, rel);
      fileMap.set(rel.replace(/\\/g, "/"), file);
    } catch {
      // asset ausente en disco
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
  await getFileHandleInsensitive(mapHandle, "global.cfg");
  let hasTile = false;
  for await (const [name, handle] of mapHandle.entries()) {
    if (handle.kind === "file" && /tile_-?\d+_-?\d+\.map$/i.test(name)) {
      hasTile = true;
      break;
    }
  }
  if (!hasTile) {
    throw new Error("La carpeta no contiene tiles tile_*.map. Elige la carpeta del mapa (ej. maps/Test_Lat30).");
  }
  const folder = mapHandle.name;
  let label = folder;
  try {
    const gf = await getFileHandleInsensitive(mapHandle, "global.cfg");
    const cfgName = parseGlobalName(await (await gf.getFile()).text());
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
            const cfgName = parseGlobalName(await fileMap.get(gfKey).text());
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
