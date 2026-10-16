import { expect, it } from "vitest";
import { browserDeviceName } from "./device-name.js";
it.each([
 ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", "Safari on macOS"],
 ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0", "Edge on Windows"],
 ["Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "Firefox on Linux"],
 ["Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
 ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0 Mobile Safari/604.1", "Chrome on iOS"],
 ["unknown", "Browser"], ["", "Browser"],
])("names a new browser from its browser and operating system", (agent, expected) => expect(browserDeviceName(agent)).toBe(expected));
