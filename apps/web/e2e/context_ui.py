from pathlib import Path
from playwright.sync_api import sync_playwright

BASE_URL = "http://127.0.0.1:4173/e2e.html"
SCREENSHOTS = Path("/tmp/mdc-task3-screenshots")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 920}, color_scheme="light")
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type in ("error", "warning") else None)
    page.goto(BASE_URL, wait_until="networkidle")
    assert page.title() == "Contexts · UI test"
    page.get_by_role("heading", name="New context").wait_for()
    page.get_by_role("button", name="Website handoff", exact=True).click()
    page.get_by_role("heading", name="Website handoff").wait_for()
    assert page.get_by_text("Here’s the layout I was working on", exact=False).is_visible()
    assert not page.locator("vite-error-overlay").count()
    page.screenshot(path=str(SCREENSHOTS / "desktop-light.png"), full_page=True)

    composer = page.get_by_label("Paste to share instantly, or type a note")
    composer.fill("Browser interaction proof")
    composer.press("Enter")
    page.get_by_text("Browser interaction proof", exact=True).wait_for()
    page.get_by_label("Attach files").click()
    page.locator('input[type="file"]').set_input_files({"name": "handoff.txt", "mimeType": "text/plain", "buffer": b"exact bytes"})
    page.get_by_text("handoff.txt", exact=False).wait_for()

    page.get_by_label("Open settings").click()
    page.get_by_role("combobox", name="Theme").select_option("dark")
    assert page.locator("html").get_attribute("data-theme") == "dark"
    page.screenshot(path=str(SCREENSHOTS / "desktop-dark.png"), full_page=True)
    page.get_by_label("Close settings").click()

    page.set_viewport_size({"width": 390, "height": 844})
    page.get_by_label("Search contexts").fill("commands")
    assert page.get_by_role("button", name="Useful commands", exact=True).is_visible()
    page.get_by_role("button", name="Useful commands", exact=True).click()
    page.get_by_text("git status", exact=False).wait_for()
    page.screenshot(path=str(SCREENSHOTS / "narrow-dark.png"), full_page=True)
    assert not errors, errors
    browser.close()

print(f"PASS {BASE_URL} desktop light/dark + narrow interactions; screenshots={SCREENSHOTS}")
