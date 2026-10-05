import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE_URL = os.environ.get("MDC_E2E_URL", "http://127.0.0.1:4173/e2e.html")
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
    page.get_by_role("heading", name="New chat").wait_for()
    page.get_by_role("button", name="Website handoff", exact=True).click()
    page.get_by_role("heading", name="Website handoff").wait_for()
    assert page.get_by_text("Here’s the layout I was working on", exact=False).is_visible()
    assert not page.locator("vite-error-overlay").count()
    page.screenshot(path=str(SCREENSHOTS / "desktop-light.png"), full_page=True)

    # Density follows the primary pointer, independently of the viewport width.
    for width in (1440, 390):
        page.set_viewport_size({"width": width, "height": 920})
        for selector in (".context-row", ".context-select", ".context-row .icon-button"):
            assert page.locator(selector).first.evaluate("el => el.getBoundingClientRect().height") == 32, selector
    page.set_viewport_size({"width": 1440, "height": 920})
    touch = browser.new_context(has_touch=True, viewport={"width": 1440, "height": 920})
    touch_page = touch.new_page()
    touch_page.goto(BASE_URL, wait_until="networkidle")
    for selector in (".context-row", ".context-select", ".context-row .icon-button"):
        assert touch_page.locator(selector).first.evaluate("el => el.getBoundingClientRect().height") == 48, selector
    touch.close()

    separator = page.get_by_role("separator", name="Resize chats sidebar")
    separator.focus()
    separator.press("End")
    expect(separator).to_have_attribute("aria-valuenow", "480")
    page.goto(BASE_URL, wait_until="networkidle")
    expect(separator).to_have_attribute("aria-valuenow", "480")
    page.set_viewport_size({"width": 390, "height": 844})
    expect(separator).to_have_count(0)
    page.set_viewport_size({"width": 1440, "height": 920})
    expect(separator).to_have_attribute("aria-valuenow", "480")
    boundary = page.locator(".sidebar").bounding_box()
    x = boundary["x"] + boundary["width"]
    page.mouse.move(x, 400)
    page.mouse.down()
    page.mouse.move(x - 130, 400, steps=5)
    page.mouse.up()
    expect(separator).to_have_attribute("aria-valuenow", "350")
    page.goto(BASE_URL, wait_until="networkidle")
    expect(separator).to_have_attribute("aria-valuenow", "350")
    page.mouse.dblclick(350, 400)
    expect(separator).to_have_attribute("aria-valuenow", "274")
    page.get_by_role("button", name="Website handoff", exact=True).click()

    composer = page.get_by_label("Message to yourself")
    composer.fill("Browser interaction proof")
    composer.press("Enter")
    page.get_by_text("Browser interaction proof", exact=True).wait_for()
    page.get_by_role("button", name="Add files or code").click()
    with page.expect_file_chooser() as chooser:
        page.get_by_role("button", name=re.compile(r"^Choose and send files")).click()
    chooser.value.set_files({"name": "handoff.txt", "mimeType": "text/plain", "buffer": b"exact bytes"})
    page.get_by_text("handoff.txt", exact=False).wait_for()

    page.get_by_label("Open settings").click()
    page.get_by_role("combobox", name="Theme").select_option("dark")
    assert page.locator("html").get_attribute("data-theme") == "dark"
    page.screenshot(path=str(SCREENSHOTS / "desktop-dark.png"), full_page=True)
    page.get_by_role("button", name="Close dialog").click()

    page.set_viewport_size({"width": 390, "height": 844})
    expect(page.locator(".sidebar")).to_have_attribute("inert", "")
    expect(page.get_by_label("Search chat titles")).not_to_be_in_viewport()
    page.get_by_role("button", name="Open chats menu").click()
    page.get_by_label("Search chat titles").fill("commands")
    assert page.get_by_role("button", name="Useful commands", exact=True).is_visible()
    page.get_by_role("button", name="Useful commands", exact=True).click()
    page.get_by_text("git status", exact=False).wait_for()
    assert page.get_by_role("button", name="Open chats menu").get_attribute("aria-expanded") == "false"
    expect(page.locator(".sidebar")).to_have_attribute("inert", "")
    expect(page.get_by_label("Search chat titles")).not_to_be_in_viewport()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    page.screenshot(path=str(SCREENSHOTS / "narrow-dark.png"), full_page=True)
    assert not errors, errors
    browser.close()

print(f"PASS {BASE_URL} desktop light/dark + narrow interactions; screenshots={SCREENSHOTS}")
