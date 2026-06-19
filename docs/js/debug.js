const MAX_SAMPLE = 60;

let debugEl = null;

export function initDebugPanel(element) {
  debugEl = element;
}

function render(lines) {
  if (!debugEl) return;
  debugEl.textContent = lines.join("\n");
  debugEl.closest("details")?.setAttribute("open", "");
}

export function debugClear() {
  render(["— Sin actividad aún —"]);
}

export function debugPrint(lines) {
  const out = Array.isArray(lines) ? lines : [String(lines)];
  console.log("[OMSI debug]\n" + out.join("\n"));
  render(out);
}

export function debugError(err, context = "") {
  const lines = [];
  if (context) lines.push(`=== ERROR: ${context} ===`);
  else lines.push("=== ERROR ===");
  if (err?.name) lines.push(`Tipo: ${err.name}`);
  lines.push(`Mensaje: ${err?.message || String(err)}`);
  if (err?.stack) {
    lines.push("");
    lines.push("Stack:");
    lines.push(err.stack.split("\n").slice(0, 8).join("\n"));
  }
  console.error("[OMSI debug]", context, err);
  render(lines);
}

function normPath(p) {
  return p.replace(/\\/g, "/");
}

function summarizePathKeys(keys) {
  const lines = [];
  const normalized = keys.map(normPath);
  lines.push(`Total rutas indexadas: ${normalized.length}`);

  const topLevels = new Map();
  for (const k of normalized) {
    const top = k.split("/")[0] || "(vacío)";
    topLevels.set(top, (topLevels.get(top) || 0) + 1);
  }
  lines.push("");
  lines.push(`Segmentos raíz (${topLevels.size}):`);
  for (const [name, count] of [...topLevels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    lines.push(`  · ${name}/ → ${count} archivos`);
  }

  const patterns = [
    ["global.cfg", (k) => /global\.cfg$/i.test(k)],
    ["tile_*.map", (k) => /tile_-?\d+_-?\d+\.map$/i.test(k)],
    ["maps/", (k) => /(^|\/)maps\//i.test(k)],
    ["Splines/", (k) => /(^|\/)splines\//i.test(k)],
    ["Sceneryobjects/", (k) => /(^|\/)sceneryobjects\//i.test(k)],
    [".sli", (k) => /\.sli$/i.test(k)],
    [".sco", (k) => /\.sco$/i.test(k)],
    ["TTData/", (k) => /(^|\/)ttdata\//i.test(k)],
  ];
  lines.push("");
  lines.push("Patrones detectados:");
  for (const [label, test] of patterns) {
    lines.push(`  · ${label}: ${normalized.filter(test).length}`);
  }

  const globals = normalized.filter((k) => /global\.cfg$/i.test(k));
  lines.push("");
  lines.push(`Rutas global.cfg (${globals.length}):`);
  if (!globals.length) lines.push("  (ninguna)");
  else globals.slice(0, 40).forEach((g) => lines.push(`  · ${g}`));
  if (globals.length > 40) lines.push(`  … y ${globals.length - 40} más`);

  lines.push("");
  lines.push(`Muestra de rutas (hasta ${MAX_SAMPLE}):`);
  normalized.slice(0, MAX_SAMPLE).forEach((k) => lines.push(`  · ${k}`));
  if (normalized.length > MAX_SAMPLE) {
    lines.push(`  … y ${normalized.length - MAX_SAMPLE} más`);
  }

  return lines;
}

export function describeWebkitPick(result) {
  const lines = [];
  lines.push("=== webkitdirectory / FileList ===");
  lines.push(`Modo devuelto: ${result.mode}`);
  lines.push(`Etiqueta: ${result.label ?? "—"}`);
  if (result.mapDir) lines.push(`mapDir: ${result.mapDir}`);
  if (result.folder) lines.push(`folder: ${result.folder}`);
  lines.push(`API carpeta nativa (showDirectoryPicker): ${typeof window.showDirectoryPicker === "function" ? "sí" : "no"}`);
  lines.push(`Navegador: ${navigator.userAgent}`);
  lines.push("");

  if (!result.fileMap?.size) {
    lines.push("fileMap vacío — el navegador no indexó archivos.");
    return lines;
  }

  lines.push(...summarizePathKeys([...result.fileMap.keys()]));
  return lines;
}

export async function describeFsaRoot(rootHandle) {
  const lines = [];
  lines.push("=== File System Access API ===");
  lines.push(`Carpeta raíz elegida: ${rootHandle.name}`);
  lines.push(`API showDirectoryPicker: sí`);
  lines.push(`Navegador: ${navigator.userAgent}`);
  lines.push("");

  const top = [];
  for await (const [name, handle] of rootHandle.entries()) {
    top.push({ name, kind: handle.kind });
  }
  top.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  lines.push(`Contenido raíz (${top.length} entradas):`);
  for (const e of top.slice(0, 50)) {
    lines.push(`  · ${e.name} [${e.kind}]`);
  }
  if (top.length > 50) lines.push(`  … y ${top.length - 50} más`);

  const mapsEntry = top.find((e) => e.kind === "directory" && e.name.toLowerCase() === "maps");
  lines.push("");
  if (!mapsEntry) {
    lines.push("maps/: NO encontrada en la raíz");
    return lines;
  }

  lines.push("maps/ — subcarpetas:");
  try {
    const mapsDir = await rootHandle.getDirectoryHandle(mapsEntry.name);
    const subs = [];
    for await (const [folderName, child] of mapsDir.entries()) {
      subs.push({ folderName, kind: child.kind });
    }
    subs.sort((a, b) => a.folderName.localeCompare(b.folderName, undefined, { sensitivity: "base" }));
    lines.push(`  Total entradas: ${subs.length}`);

    let withGlobal = 0;
    let withoutGlobal = 0;
    const noGlobalList = [];
    for (const sub of subs) {
      if (sub.kind !== "directory") {
        lines.push(`  · ${sub.folderName} [archivo — no es carpeta de mapa]`);
        continue;
      }
      if (sub.folderName.startsWith("_")) {
        lines.push(`  · ${sub.folderName}/ [omitida, empieza por _]`);
        continue;
      }
      try {
        let found = false;
        for await (const [fname, fh] of (await mapsDir.getDirectoryHandle(sub.folderName)).entries()) {
          if (fh.kind === "file" && fname.toLowerCase() === "global.cfg") {
            found = true;
            break;
          }
        }
        if (found) {
          withGlobal += 1;
          lines.push(`  · ${sub.folderName}/ → global.cfg OK`);
        } else {
          withoutGlobal += 1;
          noGlobalList.push(sub.folderName);
          lines.push(`  · ${sub.folderName}/ → sin global.cfg`);
        }
      } catch (err) {
        withoutGlobal += 1;
        lines.push(`  · ${sub.folderName}/ → error leyendo: ${err.message}`);
      }
    }
    lines.push("");
    lines.push(`Resumen maps/: ${withGlobal} con global.cfg, ${withoutGlobal} sin/error`);
    if (noGlobalList.length) {
      lines.push(`Sin global.cfg: ${noGlobalList.slice(0, 20).join(", ")}${noGlobalList.length > 20 ? "…" : ""}`);
    }
  } catch (err) {
    lines.push(`Error leyendo maps/: ${err.message}`);
  }

  return lines;
}

export async function describeFsaMapHandle(mapHandle) {
  const lines = [];
  lines.push("=== Carpeta de mapa (FSA) ===");
  lines.push(`Nombre: ${mapHandle.name}`);
  lines.push("");

  const entries = [];
  for await (const [name, handle] of mapHandle.entries()) {
    entries.push({ name, kind: handle.kind });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  lines.push(`Contenido (${entries.length}):`);
  for (const e of entries.slice(0, 80)) {
    lines.push(`  · ${e.name} [${e.kind}]`);
  }
  if (entries.length > 80) lines.push(`  … y ${entries.length - 80} más`);

  const hasGlobal = entries.some((e) => e.kind === "file" && e.name.toLowerCase() === "global.cfg");
  const tiles = entries.filter((e) => e.kind === "file" && /tile_-?\d+_-?\d+\.map$/i.test(e.name));
  lines.push("");
  lines.push(`global.cfg: ${hasGlobal ? "sí" : "NO"}`);
  lines.push(`Tiles tile_*.map en raíz: ${tiles.length}`);
  if (tiles.length) tiles.slice(0, 10).forEach((t) => lines.push(`  · ${t.name}`));

  return lines;
}

export function appendSection(baseLines, sectionLines) {
  return [...baseLines, "", ...sectionLines];
}
