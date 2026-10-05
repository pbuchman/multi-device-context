import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";

import {
  MAX_UPDATE_ARTIFACT_BYTES,
  MAX_UPDATE_CATALOG_BYTES,
  UPDATE_CATALOG_URL,
  UPDATE_CHECK_INTERVAL_MS,
  WINDOWS_UPDATE_FEED_URL,
  UpdateCatalogSchema,
  UpdateStateSchema,
  compareUpdateVersions,
  parseUpdateCatalog,
  selectUpdateArtifact,
  type DesktopBridge,
  type NativeUpdates,
  type UpdateCatalog,
  type UpdateState,
} from "./index.js";

const VERSION = "0.5.5";
const COMMIT = "a".repeat(40);
const ANDROID_VERSION_CODE = 10;
const PUBLISHED_AT = "2026-10-05T12:00:00.000Z";

type CatalogProducer = {
  buildCatalog(input: {
    directory: string;
    version: string;
    commit: string;
    androidVersionCode: number;
    publishedAt: string;
  }): Promise<unknown>;
};

let fixtureDirectory: string;
let generatedCatalog: unknown;
let removeFixture: () => Promise<void>;

beforeAll(async () => {
  const fsModule = "node:fs/promises";
  const osModule = "node:os";
  const pathModule = "node:path";
  const { mkdtemp, rm, writeFile } = (await import(fsModule)) as {
    mkdtemp(prefix: string): Promise<string>;
    rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
    writeFile(path: string, data: string): Promise<void>;
  };
  const { tmpdir } = (await import(osModule)) as { tmpdir(): string };
  const { join } = (await import(pathModule)) as { join(...parts: string[]): string };
  fixtureDirectory = await mkdtemp(join(tmpdir(), "mdc-contract-catalog-"));
  removeFixture = () => rm(fixtureDirectory, { recursive: true, force: true });
  for (const name of [
    `Multi-Device-Context-${VERSION}-mac-arm64.dmg`,
    `Multi-Device-Context-${VERSION}-win-x64.exe`,
    `Multi-Device-Context-${VERSION}-android-v${ANDROID_VERSION_CODE}-release.apk`,
  ]) {
    await writeFile(join(fixtureDirectory, name), `synthetic installer ${name}`);
  }

  const producerModuleUrl = new URL("../../../scripts/updates/catalog.mjs", import.meta.url).href;
  const { buildCatalog } = (await import(producerModuleUrl)) as CatalogProducer;
  generatedCatalog = await buildCatalog({
    directory: fixtureDirectory,
    version: VERSION,
    commit: COMMIT,
    androidVersionCode: ANDROID_VERSION_CODE,
    publishedAt: PUBLISHED_AT,
  });
});

afterAll(async () => {
  await removeFixture();
});

function catalogFixture(): UpdateCatalog {
  return structuredClone(UpdateCatalogSchema.parse(generatedCatalog));
}

describe("Preview update catalog", () => {
  it("round-trips the catalog generated from the producer's synthetic installers", () => {
    const serialized = JSON.stringify(generatedCatalog);

    expect(parseUpdateCatalog(serialized)).toEqual(generatedCatalog);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(MAX_UPDATE_CATALOG_BYTES);
    expect(UPDATE_CATALOG_URL).toBe(
      "https://pbuchman.github.io/multi-device-context/updates/preview.json",
    );
    expect(WINDOWS_UPDATE_FEED_URL).toBe(
      "https://pbuchman.github.io/multi-device-context/updates/preview/",
    );
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1_000);
  });

  it("rejects noncanonical and unsafe versions", () => {
    for (const version of ["1.2", "1.2.3-beta", "01.2.3", "1.2.3.4", "1.2.9999999", "../1.2.3"]) {
      const catalog = catalogFixture();
      catalog.version = version;
      expect(UpdateCatalogSchema.safeParse(catalog).success, version).toBe(false);
    }
  });

  it("rejects URLs outside the exact repository release and versioned filename", () => {
    const unsafeUrls = [
      "http://github.com/pbuchman/multi-device-context/releases/download/v0.5.5/Multi-Device-Context-0.5.5-mac-arm64.dmg",
      "https://evil.test/Multi-Device-Context-0.5.5-mac-arm64.dmg",
      "https://github.com/pbuchman/multi-device-context/releases/download/v0.5.4/Multi-Device-Context-0.5.5-mac-arm64.dmg",
      "https://github.com/pbuchman/multi-device-context/releases/download/v0.5.5/../payload.dmg",
      "https://github.com/pbuchman/multi-device-context/releases/download/v0.5.5/Multi-Device-Context-0.5.5-mac-arm64.dmg?token=secret",
    ];

    for (const url of unsafeUrls) {
      const catalog = catalogFixture();
      catalog.artifacts[0]!.url = url;
      expect(UpdateCatalogSchema.safeParse(catalog).success, url).toBe(false);
    }

    const catalog = catalogFixture();
    catalog.releaseUrl = "https://github.com/other/repository/releases/tag/v0.5.5";
    expect(UpdateCatalogSchema.safeParse(catalog).success).toBe(false);
  });

  it("rejects invalid hashes, excessive sizes, unknown keys, and a wrong platform definition", () => {
    const invalidSha256 = catalogFixture();
    invalidSha256.artifacts[0]!.sha256 = "A".repeat(64);
    expect(UpdateCatalogSchema.safeParse(invalidSha256).success).toBe(false);

    const invalidSha512 = catalogFixture();
    invalidSha512.artifacts[1]!.sha512 = "not-base64";
    expect(UpdateCatalogSchema.safeParse(invalidSha512).success).toBe(false);

    const excessiveSize = catalogFixture();
    excessiveSize.artifacts[0]!.size = MAX_UPDATE_ARTIFACT_BYTES + 1;
    expect(UpdateCatalogSchema.safeParse(excessiveSize).success).toBe(false);

    const unknownKey = { ...catalogFixture(), stable: true };
    expect(UpdateCatalogSchema.safeParse(unknownKey).success).toBe(false);

    const wrongPlatform = catalogFixture();
    wrongPlatform.artifacts[0] = {
      ...wrongPlatform.artifacts[0]!,
      platform: "win32",
    } as UpdateCatalog["artifacts"][number];
    expect(UpdateCatalogSchema.safeParse(wrongPlatform).success).toBe(false);
  });

  it("requires exactly one canonical artifact for every supported platform", () => {
    const missing = catalogFixture();
    missing.artifacts.pop();
    expect(UpdateCatalogSchema.safeParse(missing).success).toBe(false);

    const renamed = catalogFixture();
    renamed.artifacts[0]!.name = `Multi-Device-Context-${VERSION}-mac-x64.dmg`;
    expect(UpdateCatalogSchema.safeParse(renamed).success).toBe(false);

    const wrongMinimum = catalogFixture();
    const android = wrongMinimum.artifacts.find((artifact) => artifact.platform === "android")!;
    (android as { minimumSdk: number }).minimumSdk = 25;
    expect(UpdateCatalogSchema.safeParse(wrongMinimum).success).toBe(false);
  });

  it("enforces the client catalog byte limit before parsing JSON", () => {
    expect(() => parseUpdateCatalog("{".repeat(MAX_UPDATE_CATALOG_BYTES + 1))).toThrow(
      /at most 65536 UTF-8 bytes/,
    );
    expect(() => parseUpdateCatalog("not json")).toThrow(/valid JSON/);
  });
});

describe("update helpers", () => {
  it.each([
    ["1.2.3", "1.2.3", 0],
    ["1.2.4", "1.2.3", 1],
    ["2.0.0", "10.0.0", -1],
    ["1.10.0", "1.2.999999", 1],
    ["999999.0.0", "1.999999.999999", 1],
  ] as const)("compares numeric versions %s and %s", (left, right, expected) => {
    expect(compareUpdateVersions(left, right)).toBe(expected);
  });

  it.each(["1.2", "v1.2.3", "1.2.3-beta", "01.2.3", "1000000.0.0"])(
    "rejects unsafe comparison input %s",
    (version) => expect(() => compareUpdateVersions(version, "1.2.3")).toThrow(),
  );

  it("selects only the canonical asset for the requested platform", () => {
    const catalog = catalogFixture();

    expect(selectUpdateArtifact(catalog, "darwin").format).toBe("dmg");
    expect(selectUpdateArtifact(catalog, "win32").format).toBe("exe");
    expect(selectUpdateArtifact(catalog, "android").format).toBe("apk");
    expect(() => selectUpdateArtifact(catalog, "linux" as "darwin")).toThrow(/Unsupported update platform/);
  });
});

describe("native update lifecycle", () => {
  it("exports a required native interface and optional DesktopBridge v1 methods", () => {
    expectTypeOf<NativeUpdates["getUpdateState"]>().toEqualTypeOf<() => Promise<UpdateState>>();
    expectTypeOf<NativeUpdates["checkForUpdates"]>().toEqualTypeOf<() => Promise<UpdateState>>();
    expectTypeOf<NativeUpdates["startUpdate"]>().toEqualTypeOf<() => Promise<UpdateState>>();
    expectTypeOf<NativeUpdates["installUpdate"]>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<NativeUpdates["onUpdateState"]>().toEqualTypeOf<
      (listener: (state: UpdateState) => void) => () => void
    >();
    expectTypeOf<DesktopBridge["version"]>().toEqualTypeOf<1>();
    expectTypeOf<DesktopBridge["getUpdateState"]>().toEqualTypeOf<
      NativeUpdates["getUpdateState"] | undefined
    >();
  });

  it.each([
    "idle",
    "checking",
    "up-to-date",
    "available",
    "downloading",
    "ready",
    "installing",
    "error",
  ] as const)("accepts the %s state", (status) => {
    expect(
      UpdateStateSchema.parse({
        status,
        platform: "android",
        currentVersion: "0.5.4",
        availableVersion: "0.5.5",
        progress: { transferred: 50, total: 100, percent: 50 },
        message: "Update state",
      }),
    ).toEqual({
      status,
      platform: "android",
      currentVersion: "0.5.4",
      availableVersion: "0.5.5",
      progress: { transferred: 50, total: 100, percent: 50 },
      message: "Update state",
    });
  });

  it("rejects unsafe state values and impossible progress", () => {
    for (const state of [
      { status: "paused", platform: "darwin", currentVersion: "0.5.4" },
      { status: "idle", platform: "linux", currentVersion: "0.5.4" },
      { status: "idle", platform: "darwin", currentVersion: "v0.5.4" },
      {
        status: "downloading",
        platform: "win32",
        currentVersion: "0.5.4",
        progress: { transferred: 101, total: 100, percent: 101 },
      },
      { status: "idle", platform: "darwin", currentVersion: "0.5.4", extra: true },
    ]) {
      expect(UpdateStateSchema.safeParse(state).success).toBe(false);
    }
  });
});
