"""Synthetic context origin surfaces, source discovery, pin/search and compact regression."""
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

BASE_URL = os.environ.get("MDC_E2E_URL", "http://127.0.0.1:4173/e2e.html?deviceColors&pins")
assert urlparse(BASE_URL).hostname in ("127.0.0.1", "localhost", "::1"), "Use the local synthetic fixture only"
SCREENSHOTS = Path(os.environ.get("MDC_COLOR_SCREENSHOTS", "/tmp/mdc-context-colors-screenshots"))
SCREENSHOTS.mkdir(parents=True, exist_ok=True)
WEBSITE = "00000000-0000-4000-8000-000000000001"
DELL = "00000000-0000-4000-8000-000000000010"


def watch_errors(page, errors):
    page.on("pageerror", lambda error: errors.append(str(error)))

    def console(message):
        if message.type not in ("error", "warning"):
            return
        if urlparse(message.location.get("url", "")).path == "/favicon.ico" and "404" in message.text:
            return
        errors.append(f"{message.type}: {message.text}")

    def response(result):
        if result.status >= 400 and not (result.status == 404 and urlparse(result.url).path == "/favicon.ico"):
            errors.append(f"HTTP {result.status}: {result.url}")

    page.on("console", console)
    page.on("response", response)


def title(page, name):
    return page.get_by_role("button", name=name, exact=True)


def row(page, name):
    return page.locator(".context-row").filter(has=title(page, name))


def assert_rest(page, touch=False):
    expect(page.locator(".context-row")).to_have_count(5)
    expect(row(page, "Website handoff")).to_have_attribute("data-origin-color", "0")
    expect(row(page, "Design references")).to_have_attribute("data-origin-color", "0")
    expect(row(page, "Weekend ideas")).to_have_attribute("data-origin-color", "2")
    assert row(page, "Meeting notes").get_attribute("data-origin-color") is None
    text = page.get_by_role("navigation", name="Your chats").inner_text()
    assert all(name not in text for name in ("Dell Pro", "MacBook Pro", "Web browser", "Created on:", "Unknown device")), text
    for current in page.locator(".context-row").all():
        assert current.evaluate("el => el.scrollWidth <= el.clientWidth")
        assert current.evaluate("el => getComputedStyle(el).borderTopWidth") == "0px"
        box = current.bounding_box()
        assert box and box["height"] == (48 if touch else 32), box
        options = current.get_by_role("button", name="Options for ", exact=False)
        option_box = options.bounding_box()
        # Measure both rectangles in one frame; the drawer itself has an existing slide transition.
        assert current.evaluate("""el => {
            const row = el.getBoundingClientRect();
            const options = el.querySelector('.icon-button').getBoundingClientRect();
            return options.left >= row.left && options.right <= row.right + 1;
        }""")
        if touch:
            assert option_box["width"] >= 48 and option_box["height"] >= 48
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    assert page.evaluate("({id, origin}) => window.mdcOriginTest.records().find(context => context.id === id).originDeviceId === origin", {"id": WEBSITE, "origin": DELL})


def ensure_drawer(page):
    toggle = title(page, "Open chats menu")
    if toggle.get_attribute("aria-expanded") != "true":
        toggle.tap()
    expect(page.get_by_role("dialog", name="Chats sidebar")).to_be_visible()
    expect(page.locator(".sidebar")).to_have_css("transform", "matrix(1, 0, 0, 1, 0, 0)")


with sync_playwright() as playwright:
    launch = {"headless": True}
    if os.environ.get("MDC_CHROMIUM_EXECUTABLE"):
        launch["executable_path"] = os.environ["MDC_CHROMIUM_EXECUTABLE"]
    browser = playwright.chromium.launch(**launch)
    errors = []
    for theme in ("light", "dark"):
        context = browser.new_context(viewport={"width": 1280, "height": 800}, color_scheme=theme)
        page = context.new_page()
        watch_errors(page, errors)
        page.goto(BASE_URL, wait_until="networkidle")
        page.mouse.move(1000, 100)
        assert_rest(page)
        expect(row(page, "Website handoff")).to_have_css("background-color", "rgb(232, 240, 248)" if theme == "light" else "rgb(41, 56, 71)")
        expect(row(page, "Design references")).to_have_css("background-color", "rgb(232, 240, 248)" if theme == "light" else "rgb(41, 56, 71)")
        assert page.locator('[role="tooltip"]').count() == 0
        title(page, "Website handoff").hover()
        assert page.locator('[role="tooltip"]').count() == 0
        title(page, "Options for Website handoff").hover()
        expect(page.get_by_role("tooltip")).to_have_text("Created on: Dell Pro")
        page.mouse.move(1000, 100)
        expect(page.get_by_role("tooltip")).to_have_count(0)
        options = title(page, "Options for Website handoff")
        options.focus()
        expect(page.get_by_role("tooltip")).to_have_text("Created on: Dell Pro")
        options.press("Escape")
        expect(page.get_by_role("tooltip")).to_have_count(0)
        title(page, "Website handoff").click()
        field = page.get_by_role("textbox", name="Message to yourself")
        field.fill("Keep composer text while pinning")
        page.mouse.move(1000, 100)
        expect(row(page, "Website handoff")).to_have_css("background-color", "rgb(213, 228, 242)" if theme == "light" else "rgb(52, 75, 96)")
        title(page, "Website handoff").press("Shift+F10")
        menu = page.get_by_role("menu", name="Options for Website handoff")
        expect(menu.get_by_text("Created on: Dell Pro", exact=True)).to_be_visible()
        expect(menu.get_by_role("menuitem", name="Rename chat")).to_be_focused()
        menu.get_by_role("menuitem", name="Pin chat").click()
        expect(title(page, "Website handoff").locator(".chat-pin")).to_have_count(1)
        expect(field).to_have_value("Keep composer text while pinning")
        expect(row(page, "Website handoff")).to_have_attribute("data-origin-color", "0")
        search = page.get_by_role("searchbox", name="Search chat titles")
        search.fill("Design")
        expect(page.locator(".context-row")).to_have_count(1)
        expect(row(page, "Design references")).to_have_attribute("data-origin-color", "0")
        search.fill("")
        page.evaluate("({id, name}) => window.mdcOriginTest.rename(id, name)", {"id": DELL, "name": "Renamed Dell"})
        title(page, "Refresh chats and messages").click()
        expect(title(page, "Refresh chats and messages")).to_be_enabled()
        title(page, "Options for Website handoff").click()
        expect(page.get_by_role("menu").get_by_text("Created on: Renamed Dell", exact=True)).to_be_visible()
        page.keyboard.press("Escape")
        field.focus()
        page.evaluate("window.mdcOriginTest.failNext()")
        title(page, "Refresh chats and messages").click()
        expect(title(page, "Refresh chats and messages")).to_be_enabled()
        expect(page.locator(".error-banner")).to_have_count(0)
        field.focus()
        page.mouse.move(1000, 100)
        assert_rest(page)
        page.screenshot(path=str(SCREENSHOTS / f"desktop-{theme}.png"))
        # Explicit theme overrides system, and forced-colors delegates surfaces to system colors.
        page.evaluate("document.documentElement.dataset.theme = 'light'")
        expect(row(page, "Design references")).to_have_css("background-color", "rgb(232, 240, 248)")
        page.emulate_media(forced_colors="active")
        assert row(page, "Website handoff").evaluate("el => getComputedStyle(el).backgroundColor") != "rgb(213, 228, 242)"
        context.close()
    for width in (390, 320):
        for theme in ("light", "dark"):
            context = browser.new_context(viewport={"width": width, "height": 844}, is_mobile=True, has_touch=True, color_scheme=theme)
            page = context.new_page()
            watch_errors(page, errors)
            page.goto(BASE_URL, wait_until="networkidle")
            ensure_drawer(page)
            assert_rest(page, touch=True)
            title(page, "Options for Website handoff").tap()
            dialog = page.get_by_role("dialog", name="Chat options", exact=True)
            expect(dialog.get_by_text("Created on: Dell Pro", exact=True)).to_be_visible()
            expect(page.get_by_role("tooltip")).to_have_count(0)
            dialog.get_by_role("button", name="Pin chat", exact=True).tap()
            ensure_drawer(page)
            expect(title(page, "Website handoff").locator(".chat-pin")).to_have_count(1)
            expect(row(page, "Website handoff")).to_have_attribute("data-origin-color", "0")
            title(page, "Options for Meeting notes").tap()
            expect(page.get_by_text("Created on: Unknown device", exact=True)).to_be_visible()
            title(page, "Close dialog").tap()
            ensure_drawer(page)
            # Closing the dialog restores focus to its ellipsis; dismiss that focus tooltip for the resting capture.
            page.keyboard.press("Escape")
            expect(page.get_by_role("tooltip")).to_have_count(0)
            assert_rest(page, touch=True)
            page.screenshot(path=str(SCREENSHOTS / f"touch-{width}-{theme}.png"))
            title(page, "Website handoff").tap()
            field = page.get_by_role("textbox", name="Message to yourself")
            field.fill("Touch composer remains available")
            expect(field).to_have_value("Touch composer remains available")
            assert field.bounding_box()["width"] > 150
            context.close()
    assert not errors, errors
    browser.close()
    print(f"PASS: context colors, metadata, pin/search/composer; screenshots: {SCREENSHOTS}")
