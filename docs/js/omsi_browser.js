/**
 * Selección de carpeta OMSI 2 nativa (File System Access API o input directory).
 */

export async function pickOmsiFolder(onProgress = null) {
  if (typeof window.showDirectoryPicker === "function") {
    try {
      const handle = await window.showDirectoryPicker({
        id: "omsi2-root",
        mode: "read",
      });
      if (onProgress) onProgress("Leyendo archivos de OMSI 2… (puede tardar)");
      return {
        label: handle.name,
        fileMap: await walkDirectoryHandle(handle, "", onProgress),
      };
    } catch (err) {
      if (err?.name === "AbortError") return null;
      throw err;
    }
  }
  return pickViaInput(onProgress);
}

function pickViaInput(onProgress = null) {
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
      const fileMap = new Map();
      let label = "OMSI 2";
      for (const f of files) {
        const rel = (f.webkitRelativePath || f.name).replace(/\\/g, "/");
        if (rel) {
          fileMap.set(rel, f);
          if (rel.includes("/")) label = rel.split("/")[0];
        }
      }
      if (onProgress) onProgress(`Indexando… ${fileMap.size} archivos`);
      resolve({ label, fileMap });
    });
    input.click();
  });
}

async function walkDirectoryHandle(dirHandle, prefix = "", onProgress = null) {
  const fileMap = new Map();
  for await (const [name, handle] of dirHandle.entries()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "file") {
      fileMap.set(rel, await handle.getFile());
      if (fileMap.size % 5000 === 0 && onProgress) {
        onProgress(`Indexando… ${fileMap.size} archivos`);
      }
    } else if (handle.kind === "directory") {
      const nested = await walkDirectoryHandle(handle, rel, onProgress);
      for (const [k, v] of nested) fileMap.set(k, v);
    }
  }
  return fileMap;
}
