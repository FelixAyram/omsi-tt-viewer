#!/usr/bin/env python3
"""Pruebas Selenium del visor (demo JSON + UI)."""

import json
import sys
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
PORT = 8765
BASE = f"http://127.0.0.1:{PORT}"


class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DOCS), **kwargs)

    def log_message(self, fmt, *args):
        pass


def wait_server(timeout=15):
    for _ in range(timeout * 10):
        try:
            with urllib.request.urlopen(f"{BASE}/index.html", timeout=1) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("Servidor local no respondió")


def run_tests():
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.support.ui import Select, WebDriverWait
    from webdriver_manager.chrome import ChromeDriverManager

    server = ThreadingHTTPServer(("127.0.0.1", PORT), QuietHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    wait_server()

    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--window-size=1280,900")
    opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=opts)
    errors = []

    try:
        driver.get(f"{BASE}/index.html?v=selenium")
        wait = WebDriverWait(driver, 15)

        wait.until(EC.presence_of_element_located((By.ID, "pickOmsiBtn")))
        wait.until(EC.presence_of_element_located((By.ID, "pickMapFolderBtn")))
        print("OK: botones OMSI y mapa presentes")

        demo = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "details.demo-fallback")))
        driver.execute_script("arguments[0].open = true;", demo)
        wait.until(lambda d: len(Select(d.find_element(By.ID, "mapSelect")).options) > 1)
        Select(driver.find_element(By.ID, "mapSelect")).select_by_index(1)
        time.sleep(2)

        stats_text = driver.find_element(By.ID, "stats").text
        print(f"Stats: {stats_text}")
        if "264" not in stats_text and "riel" not in stats_text.lower():
            errors.append(f"Demo no muestra rieles: {stats_text!r}")

        manifest = json.loads((DOCS / "data" / "manifest.json").read_text(encoding="utf-8"))
        demo_file = manifest["maps"][0]["file"]
        data = json.loads((DOCS / "data" / demo_file).read_text(encoding="utf-8"))
        print(f"OK: JSON demo = {len(data.get('rails', []))} rieles")

        for e in driver.get_log("browser"):
            if e.get("level") not in ("SEVERE", "ERROR"):
                continue
            msg = e.get("message", "")
            if "favicon" in msg.lower():
                continue
            errors.append(f"Consola: {msg}")

        if errors:
            print("FALLOS:")
            for err in errors:
                print(" ", err)
            return 1
        print("Todas las pruebas Selenium pasaron.")
        return 0
    finally:
        driver.quit()
        server.shutdown()


if __name__ == "__main__":
    sys.exit(run_tests())
