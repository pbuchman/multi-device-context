import json
import tempfile
from playwright.sync_api import sync_playwright

with tempfile.TemporaryDirectory(prefix="mdc-history-") as profile, sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(profile, headless=True)
    page = browser.pages[0]
    page.goto("http://127.0.0.1:4173/history-test.html?legacy")
    page.wait_for_function("window.historyProof")
    page.evaluate("historyProof.seed()")
    assert page.evaluate("historyProof.cache()") == "SYNTHETIC_OLD_HISTORY"
    browser.close()
    browser = p.chromium.launch_persistent_context(profile, headless=True)
    page = browser.pages[0]
    page.goto("http://127.0.0.1:4173/history-test.html")
    page.wait_for_function("window.historyProof", timeout=25000)
    assert page.evaluate("historyProof.cache()") is None
    local = page.evaluate("historyProof.local()")
    assert "SYNTHETIC_UNSENT_DRAFT" in json.dumps(local["drafts"])
    assert "SYNTHETIC_UNSENT_QUEUE" in json.dumps(local["queue"])
    assert not any((d.get("name") or "").startswith("firestore/") for d in local["databases"])
    page.reload()
    page.wait_for_function("window.historyProof")
    assert page.evaluate("historyProof.cache()") is None
    browser.close()
print("PASS R1: legacy persistent profile migrated; history cache absent across restart; drafts and queue preserved")
