import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import Route, expect, sync_playwright


BASE_URL = os.environ.get(
    "MDC_SHOWCASE_URL", "http://127.0.0.1:4173/e2e.html?showcase=1"
)
OUTPUT = Path(
    os.environ.get(
        "MDC_SHOWCASE_DIR",
        Path(__file__).resolve().parents[3] / "docs" / "showcase",
    )
)
OUTPUT.mkdir(parents=True, exist_ok=True)


def add_demo_label(page) -> None:
    page.add_style_tag(
        content="""
        [data-showcase-demo] {
          position: fixed;
          right: 18px;
          bottom: 16px;
          z-index: 10000;
          padding: 7px 11px;
          border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
          border-radius: 999px;
          background: color-mix(in srgb, var(--surface) 90%, transparent);
          box-shadow: 0 6px 24px var(--shadow);
          color: var(--muted);
          font: 650 11px/1 system-ui, sans-serif;
          letter-spacing: .08em;
          text-transform: uppercase;
          backdrop-filter: blur(8px);
        }
        """
    )
    page.locator("body").evaluate(
        "body => { const badge = document.createElement('div'); "
        "badge.dataset.showcaseDemo = ''; badge.textContent = 'Demo data'; "
        "body.appendChild(badge); }"
    )


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(
        viewport={"width": 1440, "height": 900},
        color_scheme="light",
        locale="en-US",
        timezone_id="Europe/Warsaw",
    )
    blocked_requests: list[str] = []

    def local_only(route: Route) -> None:
        parsed = urlparse(route.request.url)
        if parsed.scheme in ("data", "blob") or parsed.hostname in (
            "127.0.0.1",
            "localhost",
        ):
            route.continue_()
        else:
            blocked_requests.append(route.request.url)
            route.abort()

    context.route("**/*", local_only)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on(
        "console",
        lambda message: errors.append(message.text)
        if message.type in ("error", "warning")
        else None,
    )
    page.goto(BASE_URL, wait_until="networkidle")
    assert page.title() == "Contexts · UI test"
    page.get_by_role("heading", name="New chat").wait_for()
    expect(page.get_by_text("Alex Demo", exact=True)).to_be_visible()
    expect(page.get_by_text("alex@example.com", exact=True)).to_be_visible()
    assert not page.locator("vite-error-overlay").count()
    add_demo_label(page)

    page.get_by_role("button", name="Project notes", exact=True).click()
    page.get_by_role("heading", name="Project notes", exact=True).wait_for()
    expect(page.get_by_text("Synced", exact=True)).to_be_visible()
    expect(page.get_by_text("Handoff checklist", exact=False)).to_be_visible()
    expect(page.get_by_text("https://docs.example.com/project-brief", exact=True)).to_be_visible()
    page.screenshot(
        path=str(OUTPUT / "hero-desktop.png"),
        full_page=False,
        animations="disabled",
    )

    page.set_viewport_size({"width": 390, "height": 844})
    page.get_by_role("button", name="Open chats menu").click()
    page.get_by_role("button", name="Weekend trip", exact=True).click()
    page.get_by_role("heading", name="Weekend trip", exact=True).wait_for()
    expect(page.get_by_text("Train leaves", exact=False)).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    page.screenshot(
        path=str(OUTPUT / "mobile-weekend-trip.png"),
        full_page=False,
        animations="disabled",
    )

    page.set_viewport_size({"width": 1440, "height": 900})
    page.get_by_role("button", name="Design references", exact=True).click()
    image = page.get_by_role("button", name="Open image calm-workspace-board.png")
    image.wait_for()
    image.click()
    preview = page.get_by_role(
        "dialog", name="Image preview: calm-workspace-board.png"
    )
    expect(preview).to_be_visible()
    expect(preview.get_by_role("img", name="calm-workspace-board.png")).to_be_visible()
    page.screenshot(
        path=str(OUTPUT / "image-preview.png"),
        full_page=False,
        animations="disabled",
    )
    page.keyboard.press("Escape")

    page.get_by_label("Open settings").click()
    page.get_by_role("combobox", name="Theme").select_option("dark")
    page.get_by_role("button", name="Close dialog").click()
    search = page.get_by_label("Search chat titles")
    search.fill("design")
    expect(page.get_by_role("button", name="Design references", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="Project notes", exact=True)).to_have_count(0)
    assert page.locator("html").get_attribute("data-theme") == "dark"
    page.screenshot(
        path=str(OUTPUT / "dark-search.png"),
        full_page=False,
        animations="disabled",
    )

    assert not blocked_requests, blocked_requests
    assert not errors, errors
    context.close()
    browser.close()

print(f"PASS {BASE_URL}; showcase screenshots={OUTPUT}")
