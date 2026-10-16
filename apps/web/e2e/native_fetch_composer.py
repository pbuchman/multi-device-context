"""Chromium regressions using the real Window.fetch and rendered composer.

The local HTTP fixture stubs identity SDKs only. App source and fetch remain
unchanged, and profile/update requests must reach the fixture HTTP server.
"""
import json
import os
import re
import ssl
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, build_opener

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("MDC_E2E_URL", "http://127.0.0.1:4173/e2e.html")
parsed_base = urlsplit(BASE_URL)
if parsed_base.scheme not in ("http", "https") or parsed_base.hostname not in ("127.0.0.1", "localhost") or parsed_base.username or parsed_base.password:
    raise ValueError("MDC_E2E_URL must be a loopback HTTP(S) fixture without credentials")
VITE_ORIGIN = f"{parsed_base.scheme}://{parsed_base.netloc}"
EVIDENCE = Path(os.environ.get("MDC_E2E_EVIDENCE", "/tmp/mdc-native-fetch-composer"))
EVIDENCE.mkdir(parents=True, exist_ok=True)
BUILD = "b" * 40
REQUESTS = []
DEVICE = {"id": "11111111-1111-4111-8111-111111111111", "name": "Synthetic phone", "platform": "android", "mode": "own", "version": 1, "createdAt": 1, "updatedAt": 1}
SDK = """
export const initializeApp = () => ({name:'synthetic'});
export const deleteApp = async () => {};
export const getAuth = () => ({});
export const initializeAuth = () => ({});
export const inMemoryPersistence = {};
export const signInWithCustomToken = async () => ({user:{uid:'synthetic',getIdToken:async ()=>'synthetic-firebase'}});
export const signOut = async () => {};
export const getFirestore = () => ({});
export const terminate = async () => {};
export const clearIndexedDbPersistence = async () => {};
"""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args):
        return None


opener = build_opener(NoRedirect)


def vite_source(path):
    with opener.open(VITE_ORIGIN + path, timeout=10) as response:
        return response.read().decode()


react_path = re.search(r'from "([^"]+/react\.js\?[^\"]+)"', vite_source("/src/update-ui.tsx")).group(1)
root_path = re.search(r'from "([^"]+/react-dom_client\.js\?[^\"]+)"', vite_source("/src/e2e.tsx")).group(1)
HARNESS = """<!doctype html><html><head><title>Native fetch receiver regression</title>
<script type="module">import { injectIntoGlobalHook } from '/@react-refresh';
injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;</script>
</head><body><h1>Native fetch receiver regression</h1><div id="root"></div>
<script type="module" src="/receiver.js"></script></body></html>"""
SCRIPT = """
import React from REACT_PATH;
import ReactDOM from ROOT_PATH;
import { SessionManager } from '/src/auth.ts';
import { useUpdateController } from '/src/update-ui.tsx';
window.originalFetch = window.fetch;
window.receiverResults = [];
const platform = {kind:'android',native:{getAccessToken:async ()=>'synthetic-access'},
 exchangeSession:async ()=>({uid:'synthetic',customToken:'synthetic-custom',device:DEVICE}),dispose(){}};
window.runProfile = async method => {
 const manager = new SessionManager(undefined,{mobile:true,appOrigin:location.origin,platformFactory:async()=>platform});
 const session = await manager[method]();
 for(let i=0;i<200&&session.profile.getState().status!=='ready';i++) await new Promise(resolve=>setTimeout(resolve,10));
 const result={method,state:session.profile.getState(),profile:session.profile.getSnapshot()};
 manager.dispose();window.receiverResults.push(result);return result;
};
function Updates(){
 const updates=useUpdateController({platformKind:'browser',settle:async()=>{},freeze(){},reload(){},current:()=>true,canInstall:()=>true,scope:'native-fetch'});
 window.updates=updates;
 return React.createElement('section',null,
  React.createElement('p',{id:'hosted-build'},updates.hostedBuild||'Waiting for native fetch'),
  React.createElement('p',{id:'update-error'},updates.error||''),
  React.createElement('button',{onClick:()=>updates.check()},'Check for updates'));
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Updates));
window.harnessReady=true;
""".replace("REACT_PATH", json.dumps(react_path)).replace("ROOT_PATH", json.dumps(root_path)).replace("DEVICE", json.dumps(DEVICE))


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send(self, body, content_type="application/json", status=200):
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlsplit(self.path).path
        origin = f"https://127.0.0.1:{self.server.server_port}"
        if path in ("/api/config", "/mobile-config.json"):
            self.send({"appOrigin": origin, "auth0": {"domain": "login.example.test", "audience": "synthetic", "webClientId": "web", "nativeClientId": "native", "connection": "google-oauth2"}, "firebase": {"apiKey": "synthetic", "authDomain": "synthetic.firebaseapp.com", "projectId": "synthetic", "storageBucket": "synthetic"}, "limits": {"maxTextBytes": 262144, "maxAttachmentBytes": 104857600}, "bridgeVersion": 1})
        elif path == "/api/profile":
            assert self.headers.get("Authorization") == "Bearer synthetic-access"
            REQUESTS.append({"path": path, "authorization": "synthetic fixture token", "cacheControl": self.headers.get("Cache-Control")})
            self.send({"name": "Synthetic Browser User", "email": "browser@example.test"})
        elif path == "/api/version":
            REQUESTS.append({"path": path})
            self.send({"uiBuild": BUILD})
        elif path == "/":
            self.send(HARNESS, "text/html")
        elif path == "/receiver.js":
            self.send(SCRIPT, "text/javascript")
        elif re.search(r"/firebase_(app|auth|firestore)\.js$", path):
            self.send(SDK, "text/javascript")
        elif path == "/@vite/client":
            # HMR is irrelevant to this isolated HTTPS receiver fixture.
            self.send("export const injectQuery=(url)=>url; export const createHotContext=()=>({data:{},accept(){},prune(){},dispose(){},invalidate(){}});", "text/javascript")
        elif path == "/favicon.ico":
            self.send("", "image/x-icon", 204)
        else:
            try:
                with opener.open(VITE_ORIGIN + self.path, timeout=10) as response:
                    self.send(response.read().decode(), response.headers.get("Content-Type", "text/javascript"))
            except HTTPError as error:
                self.send(error.read().decode(), "text/plain", error.code)


def collect_errors(page):
    errors = []
    page.on("requestfailed", lambda request: errors.append(f"{request.url}: {request.failure}"))
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type in ("error", "warning") else None)
    return errors


def assert_local_request(route):
    if urlsplit(route.request.url).hostname in ("127.0.0.1", "localhost"):
        route.continue_()
    else:
        route.abort()


class FixtureServer(ThreadingHTTPServer):
    request_queue_size = 128


server = FixtureServer(("127.0.0.1", 0), Fixture)
certificate_dir = tempfile.TemporaryDirectory(prefix="mdc-synthetic-tls-")
certificate = str(Path(certificate_dir.name) / "certificate.pem")
key = str(Path(certificate_dir.name) / "key.pem")
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate, "-days", "1", "-subj", "/CN=localhost"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls.load_cert_chain(certificate, key)
server.socket = tls.wrap_socket(server.socket, server_side=True)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
results = {"browserPlugin": "Browser plugin not available; regular Playwright", "nativeFetch": {}, "composer": []}
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get("MDC_E2E_CHROMIUM"))
        context = browser.new_context(viewport={"width": 1280, "height": 900}, ignore_https_errors=True)
        context.route("**/*", assert_local_request)
        page = context.new_page()
        errors = collect_errors(page)
        fixture_url = f"https://127.0.0.1:{server.server_port}"
        page.goto(fixture_url, wait_until="networkidle")
        assert page.title() == "Native fetch receiver regression"
        assert not errors, errors
        page.wait_for_function("window.harnessReady === true")
        assert page.evaluate("fetch === originalFetch && Function.prototype.toString.call(fetch).includes('[native code]')")
        # Prove the real engine rejects exactly the receiver used before the fix.
        bad_receiver = page.evaluate("""async () => {try {await ({fetcher:fetch}).fetcher('/api/profile');return 'unexpected success';}catch(error){return String(error)}}""")
        assert "Illegal invocation" in bad_receiver, bad_receiver
        for method in ("restore", "login"):
            result = page.evaluate("method => window.runProfile(method)", method)
            assert result["state"]["status"] == "ready", result
            assert result["profile"]["email"] == "browser@example.test", result
            results["nativeFetch"][method] = result
        expect(page.locator("#hosted-build")).to_have_text(BUILD)
        initial_updates = len([request for request in REQUESTS if request["path"] == "/api/version"])
        page.get_by_role("button", name="Check for updates").click()
        page.wait_for_function("window.updates.checking === false")
        assert len([request for request in REQUESTS if request["path"] == "/api/version"]) > initial_updates
        expect(page.locator("#update-error")).to_be_empty()
        assert len([request for request in REQUESTS if request["path"] == "/api/profile"]) == 2
        assert not page.locator("vite-error-overlay").count()
        assert not errors, errors
        page.screenshot(path=str(EVIDENCE / "native-fetch-receiver.png"))
        results["nativeFetch"].update({"negativeControl": bad_receiver, "fetchRemainedNative": True, "requests": REQUESTS, "errors": errors})
        print("PASS native browser fetch receiver: restore, login, automatic/manual update checks", flush=True)
        context.close()

        for name, options in (("desktop", {"viewport": {"width": 1440, "height": 920}}), ("mobile-touch", {"viewport": {"width": 390, "height": 844}, "is_mobile": True, "has_touch": True})):
            context = browser.new_context(**options)
            context.route("**/*", assert_local_request)
            page = context.new_page()
            errors = collect_errors(page)
            page.goto(BASE_URL, wait_until="networkidle")
            assert page.title() == "Contexts · UI test"
            page.get_by_role("heading", name="New chat", exact=True).wait_for()
            composer = page.get_by_role("textbox", name="Message to yourself")
            draft = "Caret regression draft with selectable words"
            composer.fill(draft)
            page.locator(".titlebar h1").click()
            assert composer.evaluate("el => document.activeElement !== el")
            action = composer.tap if name == "mobile-touch" else composer.click
            action(position={"x": 14, "y": 20})
            first = composer.evaluate("el => [el.selectionStart, el.selectionEnd]")
            assert first == [len(draft), len(draft)], (name, first)
            page.screenshot(path=str(EVIDENCE / f"composer-{name}-first-tap.png"))
            # Separate touch gestures so Chromium does not treat this as double tap.
            if name == "mobile-touch":
                page.wait_for_timeout(600)
            action(position={"x": 14, "y": 20})
            later = composer.evaluate("el => [el.selectionStart, el.selectionEnd]")
            assert later[0] < len(draft) and later[0] == later[1], (name, later)
            # A real double click on the focused field keeps native word selection.
            composer.dblclick(position={"x": 58, "y": 20})
            selection = composer.evaluate("el => [el.selectionStart, el.selectionEnd]")
            assert selection[1] > selection[0], (name, selection)
            expect(composer).to_have_value(draft)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            assert not page.locator("vite-error-overlay").count()
            assert not errors, errors
            page.screenshot(path=str(EVIDENCE / f"composer-{name}-selection.png"))
            results["composer"].append({"viewport": name, "firstTap": first, "laterTap": later, "selection": selection, "draftUnchanged": True, "errors": errors})
            context.close()
        browser.close()
finally:
    server.shutdown()
    server.server_close()
    certificate_dir.cleanup()

(EVIDENCE / "native-fetch-composer.json").write_text(json.dumps(results, indent=2) + "\n")
print(f"PASS native browser fetch receiver (restore/login/update check), desktop/mobile composer; evidence={EVIDENCE}")
