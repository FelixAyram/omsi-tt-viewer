#!/usr/bin/env python3
"""
Pruebas Selenium del visor OMSI 2.

Incluye:
- UI + demo JSON precargado
- Procesador webkit con fixture real (maps/Test_Lat30 + Splines/Sceneryobjects)
- Detección de errores de consola

Uso:
  python tools/prepare_e2e_fixture.py
  python tools/test_selenium_omsi.py
  python tools/test_selenium_omsi.py --loop 3
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
FIXTURE = DOCS / "e2e" / "fixture"
MANIFEST = DOCS / "e2e" / "manifest.json"
PORT = 8765
BASE = f"http://127.0.0.1:{PORT}"


class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DOCS), **kwargs)

    def log_message(self, fmt, *args):
        pass


def wait_url(url: str, timeout: float = 20) -> None:
    for _ in range(int(timeout * 10)):
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError(f"No responde: {url}")


def console_errors(driver, ignore=frozenset({"favicon"})) -> list[str]:
    out = []
    for e in driver.get_log("browser"):
        if e.get("level") not in ("SEVERE", "ERROR"):
            continue
        msg = e.get("message", "")
        if any(x in msg.lower() for x in ignore):
            continue
        out.append(msg)
    return out


def make_driver(headless: bool = True):
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
    from webdriver_manager.chrome import ChromeDriverManager

    opts = Options()
    if headless:
        opts.add_argument("--headless=new")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--window-size=1280,900")
    opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
    return webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=opts)


class TestRunner:
    def __init__(self, driver):
        self.driver = driver
        self.errors: list[str] = []
        self.passed: list[str] = []

    def ok(self, name: str, detail: str = "") -> None:
        self.passed.append(name)
        print(f"  PASS  {name}" + (f" — {detail}" if detail else ""))

    def fail(self, name: str, detail: str) -> None:
        self.errors.append(f"{name}: {detail}")
        print(f"  FAIL  {name} — {detail}")

    def test_ui_buttons(self) -> None:
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import WebDriverWait

        self.driver.get(f"{BASE}/index.html?selenium=1")
        wait = WebDriverWait(self.driver, 15)
        wait.until(EC.presence_of_element_located((By.ID, "pickOmsiBtn")))
        wait.until(EC.presence_of_element_located((By.ID, "pickMapFolderBtn")))
        wait.until(EC.presence_of_element_located((By.ID, "pickGlobalCfgBtn")))
        wait.until(EC.presence_of_element_located((By.ID, "debugLog")))
        self.ok("ui_buttons")

    def test_demo_json(self) -> None:
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import Select, WebDriverWait

        self.driver.get(f"{BASE}/index.html?selenium=2")
        wait = WebDriverWait(self.driver, 15)
        demo = wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, "details.demo-fallback")),
        )
        self.driver.execute_script("arguments[0].open = true;", demo)
        wait.until(lambda d: len(Select(d.find_element(By.ID, "mapSelect")).options) > 1)
        Select(self.driver.find_element(By.ID, "mapSelect")).select_by_index(1)
        time.sleep(2)
        stats = self.driver.find_element(By.ID, "stats").text
        if "264" in stats or "riel" in stats.lower():
            self.ok("demo_json", stats[:80])
        else:
            self.fail("demo_json", stats)

    def test_e2e_webkit_processor(self) -> None:
        if not MANIFEST.is_file() or not FIXTURE.is_dir():
            self.fail("e2e_webkit", "Ejecuta tools/prepare_e2e_fixture.py primero")
            return

        from selenium.webdriver.support.ui import WebDriverWait

        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        if not manifest.get("files"):
            self.fail("e2e_webkit", "manifest vacío")
            return

        self.driver.get(f"{BASE}/e2e.html")
        wait = WebDriverWait(self.driver, 30)
        wait.until(lambda d: d.execute_script("return typeof window.runE2eLoad === 'function'"))

        result = self.driver.execute_async_script(
            """
            const done = arguments[arguments.length - 1];
            runE2eLoad('/e2e/manifest.json')
              .then(r => done(r))
              .catch(e => done({ ok: false, error: e.message, stack: e.stack }));
            """
        )

        if not result or result.get("error"):
            self.fail("e2e_webkit", result.get("error", "sin resultado") if result else "null")
            if result and result.get("stack"):
                print("    ", result["stack"][:400])
            return

        rails = int(result.get("rails", 0))
        root_tiles = int(result.get("rootTiles", 0))
        if root_tiles < 1:
            self.fail("e2e_webkit", f"sin tiles en raíz (rootTiles={root_tiles})")
            return
        if rails < 50:
            self.fail("e2e_webkit", f"pocos rieles: {rails} (esperado >= 50, ideal ~264)")
            return

        self.ok(
            "e2e_webkit",
            f"{rails} rieles, {result.get('free')} libres, tiles raíz={root_tiles}, fileMap={result.get('fileMapSize')}",
        )

    def test_e2e_autorun_page(self) -> None:
        if not MANIFEST.is_file():
            self.fail("e2e_autorun", "sin manifest")
            return
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import WebDriverWait

        self.driver.get(f"{BASE}/e2e.html?autorun=1")
        deadline = time.time() + 120
        while time.time() < deadline:
            status = self.driver.find_element(By.ID, "status").text
            if "OK procesador webkit" in status:
                self.ok("e2e_autorun", status.split("\n")[1] if "\n" in status else status[:60])
                return
            if status.startswith("ERROR:"):
                self.fail("e2e_autorun", status[:200])
                return
            time.sleep(0.5)
        self.fail("e2e_autorun", "timeout 120s")

    def test_no_console_errors_on_demo(self) -> None:
        errs = console_errors(self.driver)
        if errs:
            self.fail("console_clean", errs[0][:200])
        else:
            self.ok("console_clean")

    def run_all(self) -> int:
        print("\n=== Selenium OMSI viewer ===")
        tests = [
            self.test_ui_buttons,
            self.test_demo_json,
            self.test_e2e_webkit_processor,
            self.test_e2e_autorun_page,
            self.test_no_console_errors_on_demo,
        ]
        for fn in tests:
            try:
                fn()
            except Exception as exc:
                self.fail(fn.__name__, str(exc))

        print(f"\nResumen: {len(self.passed)} OK, {len(self.errors)} FAIL")
        for p in self.passed:
            print(f"  + {p}")
        for e in self.errors:
            print(f"  ! {e}")
        return 1 if self.errors else 0


def ensure_js_utf8() -> None:
    """omsi_text.js must be UTF-8; UTF-16 breaks Chrome module loading."""
    p = DOCS / "js" / "omsi_text.js"
    raw = p.read_bytes()
    if len(raw) >= 2 and raw[1] == 0 and raw[0] not in (0xFF, 0xFE, 0x00):
        p.write_text(raw.decode('utf-16-le'), encoding="utf-8", newline="\n")
        print("  fix   omsi_text.js re-encoded UTF-16 → UTF-8")


def prepare_fixture() -> None:
    script = ROOT / "tools" / "prepare_e2e_fixture.py"
    print("Preparando fixture E2E…")
    subprocess.run([sys.executable, str(script)], check=False, cwd=str(ROOT))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", type=int, default=1, help="Repetir suite N veces")
    parser.add_argument("--no-fixture", action="store_true", help="No regenerar fixture")
    parser.add_argument("--headed", action="store_true", help="Chrome visible")
    args = parser.parse_args()

    if not args.no_fixture:
        prepare_fixture()

    ensure_js_utf8()

    server = ThreadingHTTPServer(("127.0.0.1", PORT), QuietHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    wait_url(f"{BASE}/index.html")

    exit_code = 0
    for attempt in range(1, args.loop + 1):
        if args.loop > 1:
            print(f"\n--- Intento {attempt}/{args.loop} ---")
        driver = make_driver(headless=not args.headed)
        try:
            code = TestRunner(driver).run_all()
            if code != 0:
                exit_code = code
        finally:
            driver.quit()
        if code == 0 and args.loop > 1:
            break

    server.shutdown()
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
