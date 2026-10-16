/** Initial enrollment only. Existing aliases always come from the verified server session. */
export function browserDeviceName(userAgent: string = globalThis.navigator?.userAgent ?? ""): string {
 const browser = /Edg(?:e|A|iOS)?\//.test(userAgent) ? "Edge" : /(?:Firefox|FxiOS)\//.test(userAgent) ? "Firefox" : /(?:Chrome|CriOS)\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) && /Version\//.test(userAgent) ? "Safari" : "Browser";
 const os = /iPhone|iPad|iPod/.test(userAgent) ? "iOS" : /Android/.test(userAgent) ? "Android" : /Windows/.test(userAgent) ? "Windows" : /Macintosh|Mac OS X/.test(userAgent) ? "macOS" : /Linux/.test(userAgent) ? "Linux" : undefined;
 return os ? `${browser} on ${os}` : browser;
}
