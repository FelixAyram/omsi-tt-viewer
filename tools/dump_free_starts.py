#!/usr/bin/env python3
"""Lista todos los path (.sli + .sco) con inicio/fin y candidatos a inicio libre (±10 cm)."""
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


def fmt_pt(p) -> str:
    if not p:
        return "—"
    return f"({p[0]:.2f}, {p[2]:.2f})"


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
            import('./js/map_processor.js?v=19').then(async (m) => {
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
              cb(json);
            }).catch((e) => cb({ error: String(e) }));
            """
        )
        if data.get("error"):
            raise SystemExit(data["error"])

        legs = data.get("pathLegs") or []
        free = [l for l in legs if l.get("isOmsiSpawn")]
        raw = [l for l in legs if l.get("isFreeStart")]
        print(f"Paths/sentidos: {len(legs)} | candidatos ±10cm: {len(raw)} | spawn OMSI: {len(free)}")
        print(f"Stats: {json.dumps(data.get('stats', {}), indent=2)}")
        print("\n--- SPAWN OMSI (splines vehiculo) ---")
        for leg in sorted(free, key=lambda x: x["id"]):
            print(
                f"  {leg['id']} [{leg.get('leg')}] {leg.get('direction')} "
                f"inicio {fmt_pt(leg.get('start'))} -> fin {fmt_pt(leg.get('end'))}"
            )
        print("\n--- TODOS LOS PATHS ---")
        for leg in sorted(legs, key=lambda x: (x["id"], x.get("leg", ""))):
            mark = " LIBRE" if leg.get("isFreeStart") else ""
            inc = leg.get("incomingCount", 0)
            print(
                f"  {leg['id']} [{leg.get('leg')}] {leg.get('kind')} {leg.get('direction')} "
                f"inicio {fmt_pt(leg.get('start'))} -> fin {fmt_pt(leg.get('end'))}"
                f" | entradas: {inc}{mark}"
            )
    finally:
        driver.quit()
        srv.shutdown()


if __name__ == "__main__":
    main()
