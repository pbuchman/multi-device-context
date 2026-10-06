"""Synthetic local fixture only: file drops and keyboard confirmation."""
import os
from playwright.sync_api import sync_playwright, expect

BASE_URL = os.environ.get("MDC_E2E_URL", "http://127.0.0.1:4173/e2e.html")
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for theme, width in [("light", 1440), ("dark", 1440), ("light", 390)]:
        page = browser.new_page(viewport={"width": width, "height": 900}, color_scheme=theme)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(BASE_URL)
        composer = page.get_by_role("textbox", name="Message to yourself")
        composer.fill("keep my draft")
        files = page.evaluate_handle("""() => {
            const data = new DataTransfer();
            data.items.add(new File(['hello'], 'drop-test.txt', {type: 'text/plain'}));
            return data;
        }""")
        page.get_by_role("main").dispatch_event("dragover", {"dataTransfer": files})
        expect(page.get_by_text("Drop files to review and send")).to_be_visible()
        page.get_by_role("main").dispatch_event("drop", {"dataTransfer": files})
        dialog = page.get_by_role("dialog", name="Send dropped files?")
        expect(dialog).to_be_visible()
        page.keyboard.press("Enter")
        expect(dialog).to_have_count(0)
        expect(page.locator(".file-detail").filter(has_text="drop-test.txt")).to_have_count(1)
        expect(composer).to_have_value("keep my draft")
        composer.evaluate("""element => {
            const data = new DataTransfer();
            const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), c => c.charCodeAt(0));
            data.items.add(new File([png], 'paste-test.png', {type: 'image/png'}));
            element.dispatchEvent(new ClipboardEvent('paste', {clipboardData:data, bubbles:true, cancelable:true}));
        }""")
        pasted = page.get_by_role("dialog", name="Send pasted files?")
        expect(pasted).to_be_visible()
        page.keyboard.press("Enter")
        expect(pasted).to_have_count(0)
        expect(page.locator(".file-detail").filter(has_text="paste-test.png")).to_have_count(1)
        expect(composer).to_have_value("keep my draft")
        page.get_by_role("main").dispatch_event("drop", {"dataTransfer": files})
        expect(dialog).to_be_visible()
        page.keyboard.press("Escape")
        expect(dialog).to_have_count(0)
        expect(page.locator(".file-detail").filter(has_text="drop-test.txt")).to_have_count(1)
        assert not errors, errors
        print(f"PASS {theme} {width}px: file drop, pasted image, Enter, retained draft, Escape")
        page.close()
    browser.close()
