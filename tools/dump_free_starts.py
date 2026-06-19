#!/usr/bin/env python3
"""Lista IDs de inicio libre del procesador web (fixture E2E)."""
from __future__ import annotations

import json
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
PORT = 8767


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DOCS), **kwargs)

    def log_message(self, fmt, *args):
        pass


def main() -> None:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
    from webdriver_manager.chrome import ChromeDriverManager

    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    time.sleep(0.3)

    opts = Options()
    opts.add_argument("--headless=new")
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=opts)
    try:
        driver.get(f"http://127.0.0.1:{PORT}/e2e.html")
        data = driver.execute_async_script(
            """
            const cb = arguments[arguments.length - 1];
            import('./js/map_processor.js?v=17').then(async (m) => {
              const manifest = await fetch('./e2e/manifest.json').then((r) => r.json());
              const base = './e2e/';
              const fileMap = new Map();
              for (const rel of manifest.files) {
                const res = await fetch(base + 'fixture/' + rel);
                const blob = await res.blob();
                fileMap.set(rel, new File([blob], rel.split('/').pop()));
              }
              const mapDir = manifest.mapDir;
              const globals = [...fileMap.keys()].filter((k) => /global\\.cfg$/i.test(k));
              const globalKey =
                globals.find((k) => k.toLowerCase().startsWith(mapDir.toLowerCase() + '/')) ||
                globals[0];
              const json = await m.loadMapLazy(
                { mode: 'webkit', fileMap },
                mapDir,
                () => {},
                { globalCfgFile: fileMap.get(globalKey) },
              );
              const free = json.rails.filter((r) => r.freeStart).map((r) => r.id).sort();
              cb({ freeCount: free.length, free });
            }).catch((e) => cb({ error: String(e) }));
            """
        )
        if data.get("error"):
            raise SystemExit(data["error"])
        print(json.dumps(data, indent=2))
    finally:
        driver.quit()
        srv.shutdown()


if __name__ == "__main__":
    main()
