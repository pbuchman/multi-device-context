import { z } from "zod";

export const UPDATE_CATALOG_URL =
  "https://pbuchman.github.io/multi-device-context/updates/preview.json";
export const WINDOWS_UPDATE_FEED_URL =
  "https://pbuchman.github.io/multi-device-context/updates/preview/";
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const MAX_UPDATE_CATALOG_BYTES = 65_536;
export const MAX_UPDATE_ARTIFACT_BYTES = 1_073_741_824;

const RELEASE_REPOSITORY_URL = "https://github.com/pbuchman/multi-device-context";
const numericVersionPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export const UpdateVersionSchema = z.string().regex(numericVersionPattern);
export type UpdateVersion = z.infer<typeof UpdateVersionSchema>;

export const UpdatePlatformSchema = z.enum(["darwin", "win32", "android"]);
export type UpdatePlatform = z.infer<typeof UpdatePlatformSchema>;

const updateArtifactBase = z.object({
  name: z.string().min(1).max(255),
  url: z.string().min(1).max(1_024),
  size: z.number().int().positive().max(MAX_UPDATE_ARTIFACT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});

export const DarwinUpdateArtifactSchema = updateArtifactBase
  .extend({
    platform: z.literal("darwin"),
    arch: z.literal("arm64"),
    format: z.literal("dmg"),
    minimumSystemVersion: z.literal("13.0.0"),
  })
  .strict();

export const WindowsUpdateArtifactSchema = updateArtifactBase
  .extend({
    platform: z.literal("win32"),
    arch: z.literal("x64"),
    format: z.literal("exe"),
    minimumSystemVersion: z.literal("10.0.0"),
  })
  .strict();

export const AndroidUpdateArtifactSchema = updateArtifactBase
  .extend({
    platform: z.literal("android"),
    arch: z.literal("universal"),
    format: z.literal("apk"),
    versionCode: z.number().int().positive().max(2_100_000_000),
    minimumSdk: z.literal(26),
  })
  .strict();

export const UpdateArtifactSchema = z.discriminatedUnion("platform", [
  DarwinUpdateArtifactSchema,
  WindowsUpdateArtifactSchema,
  AndroidUpdateArtifactSchema,
]);
export type UpdateArtifact = z.infer<typeof UpdateArtifactSchema>;
export type DarwinUpdateArtifact = z.infer<typeof DarwinUpdateArtifactSchema>;
export type WindowsUpdateArtifact = z.infer<typeof WindowsUpdateArtifactSchema>;
export type AndroidUpdateArtifact = z.infer<typeof AndroidUpdateArtifactSchema>;

function isCanonicalIsoInstant(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

const updateCatalogFields = z
  .object({
    schemaVersion: z.literal(1),
    channel: z.literal("preview"),
    version: UpdateVersionSchema,
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    publishedAt: z.string().refine(isCanonicalIsoInstant, "Expected a canonical ISO publication time"),
    releaseUrl: z.string().min(1).max(1_024),
    artifacts: z.array(UpdateArtifactSchema).length(3),
  })
  .strict();

export const UpdateCatalogSchema = updateCatalogFields.superRefine((catalog, context) => {
  const expectedReleaseUrl = `${RELEASE_REPOSITORY_URL}/releases/tag/v${catalog.version}`;
  if (catalog.releaseUrl !== expectedReleaseUrl) {
    context.addIssue({
      code: "custom",
      path: ["releaseUrl"],
      message: `Expected ${expectedReleaseUrl}`,
    });
  }

  const android = catalog.artifacts.find((artifact) => artifact.platform === "android");
  const expectedNames: Partial<Record<UpdatePlatform, string>> = {
    darwin: `Multi-Device-Context-${catalog.version}-mac-arm64.dmg`,
    win32: `Multi-Device-Context-${catalog.version}-win-x64.exe`,
    ...(android
      ? {
          android: `Multi-Device-Context-${catalog.version}-android-v${android.versionCode}-release.apk`,
        }
      : {}),
  };

  for (const platform of UpdatePlatformSchema.options) {
    const matches = catalog.artifacts
      .map((artifact, index) => ({ artifact, index }))
      .filter(({ artifact }) => artifact.platform === platform);
    if (matches.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: `Expected exactly one ${platform} artifact`,
      });
      continue;
    }

    const match = matches[0]!;
    const expectedName = expectedNames[platform];
    if (match.artifact.name !== expectedName) {
      context.addIssue({
        code: "custom",
        path: ["artifacts", match.index, "name"],
        message: `Expected ${expectedName}`,
      });
    }

    const expectedUrl = `${RELEASE_REPOSITORY_URL}/releases/download/v${catalog.version}/${expectedName}`;
    if (match.artifact.url !== expectedUrl) {
      context.addIssue({
        code: "custom",
        path: ["artifacts", match.index, "url"],
        message: `Expected ${expectedUrl}`,
      });
    }
  }
});
export type UpdateCatalog = z.infer<typeof UpdateCatalogSchema>;

export function parseUpdateCatalog(serialized: string): UpdateCatalog {
  if (typeof serialized !== "string") {
    throw new TypeError("Update catalog must be a JSON string");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_UPDATE_CATALOG_BYTES) {
    throw new Error(`Update catalog must be at most ${MAX_UPDATE_CATALOG_BYTES} UTF-8 bytes`);
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Update catalog must be valid JSON");
  }
  return UpdateCatalogSchema.parse(value);
}

export function compareUpdateVersions(left: string, right: string): -1 | 0 | 1 {
  const leftParts = UpdateVersionSchema.parse(left).split(".").map(Number);
  const rightParts = UpdateVersionSchema.parse(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference < 0) return -1;
    if (difference > 0) return 1;
  }
  return 0;
}

export type UpdateArtifactFor<Platform extends UpdatePlatform> = Extract<
  UpdateArtifact,
  { platform: Platform }
>;

export function selectUpdateArtifact<Platform extends UpdatePlatform>(
  catalog: UpdateCatalog,
  platform: Platform,
): UpdateArtifactFor<Platform> {
  const parsedPlatform = UpdatePlatformSchema.safeParse(platform);
  if (!parsedPlatform.success) {
    throw new Error(`Unsupported update platform: ${String(platform)}`);
  }
  const parsedCatalog = UpdateCatalogSchema.parse(catalog);
  const artifact = parsedCatalog.artifacts.find((candidate) => candidate.platform === parsedPlatform.data);
  if (!artifact) {
    throw new Error(`Catalog does not contain a ${parsedPlatform.data} artifact`);
  }
  return artifact as UpdateArtifactFor<Platform>;
}

export const UpdateStatusSchema = z.enum([
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "ready",
  "installing",
  "error",
]);
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

export const UpdateProgressSchema = z
  .object({
    transferred: z.number().int().nonnegative().max(MAX_UPDATE_ARTIFACT_BYTES),
    total: z.number().int().nonnegative().max(MAX_UPDATE_ARTIFACT_BYTES),
    percent: z.number().min(0).max(100),
  })
  .strict()
  .refine((progress) => progress.transferred <= progress.total, {
    message: "Transferred bytes cannot exceed total bytes",
    path: ["transferred"],
  });
export type UpdateProgress = z.infer<typeof UpdateProgressSchema>;

export const UpdateStateSchema = z
  .object({
    status: UpdateStatusSchema,
    platform: UpdatePlatformSchema,
    currentVersion: UpdateVersionSchema,
    availableVersion: UpdateVersionSchema.optional(),
    progress: UpdateProgressSchema.optional(),
    message: z.string().min(1).max(2_048).optional(),
  })
  .strict();
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export interface NativeUpdates {
  /** Return the latest in-memory native update state without starting work. */
  getUpdateState(): Promise<UpdateState>;
  /** Refresh availability metadata without downloading an installer. */
  checkForUpdates(): Promise<UpdateState>;
  /** Download and verify an available installer, resolving only when it is ready to install. */
  startUpdate(): Promise<UpdateState>;
  /** Install only the already downloaded and verified cached installer. */
  installUpdate(): Promise<void>;
  /** Subscribe to native state changes and return an unsubscribe function. */
  onUpdateState(listener: (state: UpdateState) => void): () => void;
}
