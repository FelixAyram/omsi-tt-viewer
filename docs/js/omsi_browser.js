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
  for await (const [folderName, child] of mapsDir.entries()) {
    if (child.kind !== "directory" || folderName.startsWith("_")) continue;
    try {
      const gf = await child.getFileHandle("global.cfg");
      const file = await gf.getFile();
      const cfgName = parseGlobalName(await file.text());
      let label = folderName;
      if (cfgName && cfgName.toLowerCase() !== folderName.toLowerCase()) {
        label = `${folderName} — ${cfgName}`;
      }
      entries.push({ dir: `maps/${folderName}`, folder: folderName, label });
    } catch {
      // no es mapa jugable
    }
  }
  if (!entries.length) {
    throw new Error("No se encontraron mapas en maps/ (global.cfg por carpeta).");
  }
  return entries.sort((a, b) => a.folder.localeCompare(b.folder, undefined, { sensitivity: "base" }));
}

// Carga carpeta del mapa + .sli y .sco referenciados bajo demanda.
export async function buildMapFileMapLazy(rootHandle, mapRelDir, collectAssetRefs, onProgress = null) {
  const mapDir = mapRelDir.replace(/\\/g, "/");
  const fileMap = new Map();

  onProgress?.("Cargando tiles y TTData del mapa…");
  const mapHandle = await getDirHandle(rootHandle, mapDir);
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
