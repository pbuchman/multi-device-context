import { createHash } from "node:crypto";
import { UpdateCatalogSchema, selectUpdateArtifact, type UpdateCatalog } from "@mdc/contracts";

export function updateCatalogFixture(
  version = "0.5.5",
  bytes = Buffer.from("verified desktop installer"),
): UpdateCatalog {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const release = `https://github.com/pbuchman/multi-device-context/releases/download/v${version}`;
  return UpdateCatalogSchema.parse({
    schemaVersion: 1,
    channel: "preview",
    version,
    commit: "a".repeat(40),
    publishedAt: "2026-10-05T00:00:00.000Z",
    releaseUrl: `https://github.com/pbuchman/multi-device-context/releases/tag/v${version}`,
    artifacts: [
      {
        platform: "darwin",
        arch: "arm64",
        format: "dmg",
        minimumSystemVersion: "13.0.0",
        name: `Multi-Device-Context-${version}-mac-arm64.dmg`,
        url: `${release}/Multi-Device-Context-${version}-mac-arm64.dmg`,
        size: bytes.length,
        sha256,
        sha512,
      },
      {
        platform: "win32",
        arch: "x64",
        format: "exe",
        minimumSystemVersion: "10.0.0",
        name: `Multi-Device-Context-${version}-win-x64.exe`,
        url: `${release}/Multi-Device-Context-${version}-win-x64.exe`,
        size: bytes.length,
        sha256,
        sha512,
      },
      {
        platform: "android",
        arch: "universal",
        format: "apk",
        minimumSdk: 26,
        versionCode: 9,
        name: `Multi-Device-Context-${version}-android-v9-release.apk`,
        url: `${release}/Multi-Device-Context-${version}-android-v9-release.apk`,
        size: bytes.length,
        sha256,
        sha512,
      },
    ],
  });
}

export function darwinUpdateFixture(version = "0.5.5", bytes = Buffer.from("verified desktop installer")) {
  return selectUpdateArtifact(updateCatalogFixture(version, bytes), "darwin");
}

export function windowsUpdateFixture(version = "0.5.5", bytes = Buffer.from("verified desktop installer")) {
  return selectUpdateArtifact(updateCatalogFixture(version, bytes), "win32");
}
