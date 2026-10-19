"""Saved chat pin controls, responsive rows, and composer preservation."""
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

BASE_URL = os.environ.get("MDC_E2E_URL", "http://127.0.0.1:4173/e2e.html?pins")
SCREENSHOTS = Path("/tmp/mdc-pinning-screenshots")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)
WEBSITE = "00000000-0000-4000-8000-000000000001"
NOTES = "00000000-0000-4000-8000-000000000005"


def watch_errors(page, errors):
    page.on("pageerror", lambda error: errors.append(str(error)))

    def console(message):
        if message.type not in ("error", "warning"):
            return
        # The synthetic HTML has no favicon. Ignore only its known missing asset.
        if (urlparse(message.location.get("url", "")).path == "/favicon.ico"
                and message.text == "Failed to load resource: the server responded with a status of 404 (Not Found)"):
            return
        errors.append(f"{message.type}: {message.text} {message.location}")

    def response(result):
        if result.status < 400:
            return
        if result.status == 404 and urlparse(result.url).path == "/favicon.ico":
            return
        errors.append(f"HTTP {result.status}: {result.url}")

    page.on("console", console)
    page.on("response", response)


def assert_page(page):
    assert page.url == BASE_URL
    assert page.title() == "Contexts · UI test"
    expect(page.get_by_role("heading", name="New chat", exact=True)).to_be_visible()
    expect(page.locator("vite-error-overlay")).to_have_count(0)
    expect(page.locator(".context-select")).to_have_count(5)
    expect(page.locator(".context-select").first).to_have_attribute("aria-description", "Pinned chat. Unread messages")


def assert_pin(page, pinned):
    row = page.get_by_role("button", name="Website handoff", exact=True)
    expect(row.locator(".chat-pin")).to_have_count(1 if pinned else 0)
    assert page.evaluate("id => window.mdcPinTest.records().find(context => context.id === id).pinnedAt != null", WEBSITE) == pinned
    if pinned:
        expect(page.locator(".context-select").first).to_have_text("Website handoff")
    else:
        assert page.locator(".context-select").first.inner_text() != "Website handoff"


def assert_rows_fit(page, touch=False):
    for row in page.locator(".context-row").all():
        assert row.evaluate("el => el.scrollWidth <= el.clientWidth"), "Chat row overflows"
        box = row.bounding_box()
        assert box is not None
        options = row.get_by_role("button", name="Options for ", exact=False)
        option_box = options.bounding_box()
        assert option_box and option_box["x"] >= box["x"]
        assert option_box["x"] + option_box["width"] <= box["x"] + box["width"] + 1
        if touch:
            assert option_box["height"] >= 48 and option_box["width"] >= 48
        for pin in row.locator(".chat-pin").all():
            pin_box = pin.bounding_box()
            assert pin_box and pin_box["width"] == 14 and pin_box["height"] == 14, pin_box
            assert pin_box["x"] + pin_box["width"] <= option_box["x"]
    long_title = page.locator(".context-select > span:first-child").filter(has_text="Pinned chat with a very long title")
    assert long_title.evaluate("el => el.scrollWidth > el.clientWidth"), "Fixture must exercise title truncation"


def ensure_drawer_open(page):
    # The chat options dialog closes after pinning; its enclosing drawer may stay open.
    toggle = page.get_by_role("button", name="Open chats menu", exact=True)
    if toggle.get_attribute("aria-expanded") != "true":
        toggle.tap()
    expect(page.get_by_role("dialog", name="Chats sidebar", exact=True)).to_be_visible()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    desktop = browser.new_context(viewport={"width": 1280, "height": 720}, color_scheme="light")
    page = desktop.new_page()
    watch_errors(page, errors)
    page.goto(BASE_URL, wait_until="networkidle")
    assert_page(page)
    separator = page.get_by_role("separator", name="Resize chats sidebar")
    separator.focus()
    page.keyboard.press("Home")
    expect(page.locator(".sidebar")).to_have_css("width", "220px")
    page.get_by_role("button", name="Website handoff", exact=True).click()
    field = page.get_by_role("textbox", name="Message to yourself")
    field.fill("Keep this text and selected range")
    field.evaluate("el => el.setSelectionRange(5, 9)")
    page.evaluate("id => window.mdcPinTest.remote(id, Date.now())", NOTES)
    expect(field).to_be_focused()
    expect(field).to_have_value("Keep this text and selected range")
    assert field.evaluate("el => [el.selectionStart, el.selectionEnd]") == [5, 9]
    expect(page.get_by_role("heading", name="Website handoff", exact=True)).to_be_visible()

    # Keyboard menu, explicit state, and delayed acknowledgment.
    website_row = page.get_by_role("button", name="Website handoff", exact=True)
    website_row.focus()
    website_row.press("Shift+F10")
    expect(page.get_by_role("menu", name="Options for Website handoff")).to_be_visible()
    page.evaluate("window.mdcPinTest.pause()")
    page.get_by_role("menuitem", name="Pin chat", exact=True).click()
    assert_pin(page, False)
    page.get_by_role("button", name="Options for Website handoff", exact=True).click()
    expect(page.get_by_role("menuitem", name="Pin chat", exact=True)).to_be_disabled()
    page.get_by_role("menu").press("Escape")
    page.evaluate("window.mdcPinTest.finish()")
    expect(page.get_by_text("Chat pinned", exact=True)).to_be_visible()
    assert_pin(page, True)
    expect(field).to_have_value("Keep this text and selected range")
    page.get_by_role("button", name="Website handoff", exact=True).click(button="right")
    page.get_by_role("menuitem", name="Unpin chat", exact=True).click()
    expect(page.get_by_text("Chat unpinned", exact=True)).to_be_visible()
    assert_pin(page, False)
    assert_rows_fit(page)
    page.screenshot(path=str(SCREENSHOTS / "sidebar-220-light.png"), full_page=True)

    page.get_by_label("Open settings").click()
    page.get_by_role("combobox", name="Theme").select_option("dark")
    page.get_by_role("button", name="Close dialog").click()
    edge = page.locator(".sidebar").bounding_box()
    page.mouse.dblclick(edge["x"] + edge["width"], edge["y"] + 120)
    expect(page.locator(".sidebar")).to_have_css("width", "274px")
    assert_rows_fit(page)
    page.screenshot(path=str(SCREENSHOTS / "sidebar-274-dark.png"), full_page=True)
    expect(page.locator("vite-error-overlay")).to_have_count(0)

    touch = browser.new_context(viewport={"width": 360, "height": 800}, has_touch=True, is_mobile=True, color_scheme="light")
    mobile = touch.new_page()
    watch_errors(mobile, errors)
    mobile.goto(BASE_URL, wait_until="networkidle")
    assert_page(mobile)
    ensure_drawer_open(mobile)
    mobile.get_by_role("button", name="Website handoff", exact=True).tap()
    mobile_field = mobile.get_by_role("textbox", name="Message to yourself")
    mobile_field.fill("Touch draft survives pins")
    ensure_drawer_open(mobile)
    mobile.get_by_role("button", name="Options for Website handoff", exact=True).tap()
    expect(mobile.get_by_role("dialog", name="Chat options", exact=True)).to_be_visible()
    mobile.get_by_role("button", name="Pin chat", exact=True).tap()
    expect(mobile.get_by_role("dialog", name="Chat options", exact=True)).to_have_count(0)
    ensure_drawer_open(mobile)
    assert_pin(mobile, True)
    assert_rows_fit(mobile, touch=True)
    expect(mobile_field).to_have_value("Touch draft survives pins")
    mobile.screenshot(path=str(SCREENSHOTS / "mobile-touch-pinned.png"), full_page=True)
    mobile.get_by_role("button", name="Options for Website handoff", exact=True).tap()
    mobile.get_by_role("button", name="Unpin chat", exact=True).tap()
    ensure_drawer_open(mobile)
    assert_pin(mobile, False)
    expect(mobile_field).to_have_value("Touch draft survives pins")
    expect(mobile.locator("vite-error-overlay")).to_have_count(0)
    assert not errors, errors
    browser.close()
    print("PASS: desktop/touch pin acknowledgment, menus, pin/unpin state, reorder, draft/cursor, 220px/274px rows, themes, relevant console health")
