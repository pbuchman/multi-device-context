"""Run against Vite dev server: MDC_E2E_URL=http://127.0.0.1:4173/e2e.html?deviceNames python device_names.py."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("MDC_E2E_URL", "http://127.0.0.1:4173/e2e.html?deviceNames")
SHOTS = Path("/tmp/mdc-device-name-screenshots")
SHOTS.mkdir(exist_ok=True)

def settings(page, mobile=False):
    if mobile:
        page.get_by_role("button", name="Open chats menu").click()
    page.get_by_role("button", name="Open settings").click()

def rename(page, name):
    page.get_by_role("button", name="Rename device", exact=True).click()
    page.get_by_role("textbox", name="Device name", exact=True).fill(name)
    with page.expect_response(lambda response: "/__e2e/api/device" in response.url and response.request.method == "PATCH") as response:
        page.get_by_role("button", name="Save device name").click()
    assert response.value.status == 200
    assert response.value.json()["name"] == name.strip()
    expect(page.get_by_text(name.strip(), exact=True)).to_be_visible()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for mobile, viewport in [(False, {"width": 1440, "height": 1000}), (True, {"width": 390, "height": 844})]:
        page = browser.new_page(viewport=viewport)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(BASE, wait_until="networkidle")
        page.evaluate("window.mdcDeviceTest.reset()")
        page.reload(wait_until="networkidle")
        message = page.get_by_role("textbox", name="Message to yourself")
        message.fill("Queued before rename")
        page.get_by_role("button", name="Send", exact=True).click()
        page.wait_for_function("async () => (await window.mdcDeviceTest.queued()).length === 1")
        message.fill("Draft survives rename")
        settings(page, mobile)
        rename(page, " Łódź MacBook ")
        assert page.evaluate("async () => (await window.mdcDeviceTest.queued())[0].device.name") == "Dell Pro"
        page.screenshot(path=str(SHOTS / ("mobile-settings.png" if mobile else "desktop-settings.png")))
        page.get_by_role("button", name="Close dialog").click()
        if mobile:
            page.get_by_role("button", name="Close chats menu", exact=True).click()
        expect(message).to_have_value("Draft survives rename")
        page.get_by_role("button", name="Send", exact=True).click()
        page.wait_for_function("async () => (await window.mdcDeviceTest.queued()).length === 2")
        assert page.evaluate("async () => (await window.mdcDeviceTest.queued()).map(x=>x.device.name)") == ["Dell Pro", "Łódź MacBook"]
        page.reload(wait_until="networkidle")
        settings(page, mobile)
        expect(page.get_by_text("Łódź MacBook", exact=True)).to_be_visible()
        page.get_by_role("button", name="Rename device", exact=True).click()
        page.get_by_role("textbox", name="Device name").fill("   ")
        page.get_by_role("button", name="Save device name").click()
        expect(page.get_by_role("alert")).to_contain_text("1–80")
        page.get_by_role("textbox", name="Device name").fill("Recovered name")
        page.evaluate("window.mdcDeviceTest.failNext()")
        page.get_by_role("button", name="Save device name").click()
        expect(page.get_by_role("alert")).to_contain_text("Try again")
        page.get_by_role("button", name="Save device name").click()
        expect(page.get_by_text("Recovered name", exact=True)).to_be_visible()
        page.goto(BASE + "&access", wait_until="networkidle")
        page.get_by_role("button", name="Rename device MacBook Pro", exact=True).click()
        page.get_by_role("textbox", name="Device name").fill("Remote Mac")
        page.get_by_role("button", name="Save device name").click()
        expect(page.get_by_role("heading", name="Remote Mac", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="Allow all contexts on Remote Mac", exact=True)).to_be_visible()
        page.reload(wait_until="networkidle")
        expect(page.get_by_role("heading", name="Remote Mac", exact=True)).to_be_visible()
        assert not errors, errors
        page.close()
    browser.close()
print(f"Device names: desktop/mobile persistence, validation/retry, passkey rename, draft and queue snapshots passed. Screenshots: {SHOTS}")
