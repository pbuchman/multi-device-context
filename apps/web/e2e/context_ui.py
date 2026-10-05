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
    expect(page.get_by_role("button", name="Open new chat")).to_have_count(0)
    expect(page.get_by_role("button", name="Clear search")).to_have_count(0)
    page.get_by_role("button", name="Website handoff", exact=True).click()
    page.get_by_role("heading", name="Website handoff").wait_for()
    assert page.get_by_text("Here’s the layout I was working on", exact=False).is_visible()
    assert page.get_by_role("button", name="Delete message").count() >= 2
    assert page.locator(".account .avatar img").is_visible()
    assert not page.locator("vite-error-overlay").count()
    page.screenshot(path=str(SCREENSHOTS / "desktop-light.png"), full_page=True)

    search = page.get_by_label("Search chat titles")
    search.fill("website")
    expect(page.get_by_role("button", name="Clear search")).to_have_count(1)
    assert search.evaluate("el => getComputedStyle(el).outlineStyle") == "none"
    assert page.locator(".search").evaluate("el => getComputedStyle(el).boxShadow") != "none"
    controls = [page.get_by_role("button", name="Clear search"), page.get_by_role("button", name="Refresh chats and messages"), page.get_by_role("button", name="Options for Website handoff")]
    centers = [control.bounding_box()["x"] + control.bounding_box()["width"] / 2 for control in controls]
    assert max(centers) - min(centers) < 1, centers
    page.screenshot(path=str(SCREENSHOTS / "search-focused.png"), full_page=True)
    page.get_by_role("button", name="Clear search").click()

    # Keep real refresh work pending so progress remains visible in both themes.
    for theme in ("light", "dark"):
        page.get_by_label("Open settings").click()
        page.get_by_role("combobox", name="Theme").select_option(theme)
        page.get_by_role("button", name="Close dialog").click()
        page.evaluate("window.mdcRefreshTest.pause()")
        page.get_by_role("button", name="Refresh chats and messages", exact=True).click()
        expect(page.get_by_text("Refreshing…", exact=True).first).to_be_visible()
        expect(page.get_by_role("button", name="Refresh chats and messages", exact=True)).to_be_disabled()
        page.screenshot(path=str(SCREENSHOTS / f"refresh-{theme}.png"), full_page=True)
        page.evaluate("window.mdcRefreshTest.finish()")
        expect(page.get_by_role("button", name="Refresh chats and messages", exact=True)).to_be_enabled()
        expect(page.get_by_text("Refresh complete", exact=True)).to_be_visible()
    page.get_by_label("Open settings").click()
    page.get_by_role("combobox", name="Theme").select_option("light")
    page.get_by_role("button", name="Close dialog").click()

    page.evaluate("window.mdcProfileTest.fail()")
    page.get_by_label("Open settings").click()
    expect(page.get_by_text("Account provider test failure", exact=True)).to_be_visible()
    page.get_by_role("button", name="Retry account details", exact=True).click()
    expect(page.get_by_role("button", name="Refresh account details", exact=True)).to_be_enabled()
    expect(page.get_by_text("Account provider test failure", exact=True)).to_have_count(0)
    expect(page.get_by_role("dialog").get_by_text("alex@example.com", exact=True)).to_be_visible()
    page.get_by_role("button", name="Close dialog").click()
    page.evaluate("window.mdcDeletionTest.pause()")
    page.get_by_role("button", name="Meeting notes", exact=True).click(button="right")
    page.get_by_role("menuitem", name="Delete chat…", exact=True).click()
    page.get_by_role("button", name="Delete chat", exact=True).click()
    expect(page.get_by_text("Deleting…", exact=True)).to_be_visible()
    expect(page.locator(".error-banner")).to_have_count(0)
    page.screenshot(path=str(SCREENSHOTS / "deletion-pending.png"), full_page=True)
    page.evaluate("window.mdcDeletionTest.finish()")
    expect(page.get_by_role("dialog")).to_have_count(0)
    expect(page.get_by_role("button", name="Meeting notes", exact=True)).to_have_count(0)
    expect(page.get_by_text("Deleting…", exact=True)).to_have_count(0)
    expect(page.locator(".error-banner")).to_have_count(0)

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
    composer.fill("Keep this draft")
    target = page.get_by_role("button", name="Useful commands", exact=True)
    target.click(button="right")
    menu = page.get_by_role("menu", name="Options for Useful commands")
    expect(menu).to_be_visible()
    expect(composer).to_have_value("Keep this draft")
    expect(page.get_by_role("heading", name="Website handoff")).to_be_visible()
    menu.press("Escape")
    expect(target).to_be_focused()
    target.press("Shift+F10")
    page.get_by_role("menuitem", name="Rename chat").click()
    page.get_by_label("Chat name", exact=True).fill("Commands renamed")
    page.get_by_role("button", name="Save", exact=True).click()
    expect(page.get_by_role("button", name="Commands renamed", exact=True)).to_be_visible()
    expect(composer).to_have_value("Keep this draft")
    # Deliberately open at the viewport edge to exercise menu clamping.
    page.get_by_role("button", name="Commands renamed", exact=True).evaluate("el => el.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:1438, clientY:918}))")
    bounds = page.get_by_role("menu").bounding_box()
    assert bounds["x"] + bounds["width"] <= 1440
    assert bounds["y"] + bounds["height"] <= 920
    page.screenshot(path=str(SCREENSHOTS / "context-menu-light.png"), full_page=True)
    page.get_by_role("menu").press("Escape")
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
    assert page.get_by_role("combobox", name="Theme").evaluate("el => el.getBoundingClientRect().height") == 36
    assert page.get_by_role("checkbox", name="Launch at login").evaluate("el => el.getBoundingClientRect().height") == 40
    assert page.get_by_role("dialog").locator(".avatar img").is_visible()
    assert page.locator("html").get_attribute("data-theme") == "dark"
    page.screenshot(path=str(SCREENSHOTS / "desktop-dark.png"), full_page=True)
    page.get_by_role("button", name="Close dialog").click()

    page.set_viewport_size({"width": 390, "height": 844})
    expect(page.locator(".sidebar")).to_have_attribute("inert", "")
    expect(page.get_by_label("Search chat titles")).not_to_be_in_viewport()
    page.get_by_role("button", name="Open chats menu").click()
    page.get_by_label("Search chat titles").fill("commands")
    assert page.get_by_role("button", name="Commands renamed", exact=True).is_visible()
    page.get_by_role("button", name="Commands renamed", exact=True).click()
    page.get_by_text("git status", exact=False).wait_for()
    assert page.get_by_role("button", name="Open chats menu").get_attribute("aria-expanded") == "false"
    expect(page.locator(".sidebar")).to_have_attribute("inert", "")
    expect(page.get_by_label("Search chat titles")).not_to_be_in_viewport()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    page.screenshot(path=str(SCREENSHOTS / "narrow-dark.png"), full_page=True)
    assert not errors, errors
    browser.close()

print(f"PASS {BASE_URL} desktop light/dark + narrow interactions; screenshots={SCREENSHOTS}")
