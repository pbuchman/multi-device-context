import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowsUpdateFixture } from "./update-test-fixtures.js";

const fs = vi.hoisted(() => ({
  chmod: vi.fn(),
  lstat: vi.fn(),
  mkdir: vi.fn(),
  open: vi.fn(),
  realpath: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  unlink: vi.fn(),
}));
vi.mock("node:fs/promises", () => fs);

import { verifyDownloadedArtifact } from "./update-files.js";

function stat(overrides: Partial<Record<"dev" | "ino" | "size" | "mtimeNs" | "ctimeNs", bigint>> = {}) {
  return {
    dev: 7n,
    ino: 11n,
    size: 0n,
    mtimeNs: 13_000_000n,
    ctimeNs: 17_000_000n,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    ...overrides,
  };
}

const nativePlatform = process.platform;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: nativePlatform });
});

function emulatePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

it("accepts the measured Windows lstat dev zero while binding all other metadata", async () => {
  emulatePlatform("win32");
  const bytes = Buffer.from("verified desktop installer");
  const artifact = windowsUpdateFixture("0.5.5", bytes);
  const pathStat = stat({ dev: 0n, ino: 281_474_978_074_229n, size: BigInt(bytes.length), mtimeNs: 13_000_100n, ctimeNs: 17_000_100n });
  const handleStat = stat({ dev: 742_408_122n, ino: 281_474_978_074_229n, size: BigInt(bytes.length), mtimeNs: 13_000_100n, ctimeNs: 17_000_100n });
  fs.lstat.mockResolvedValue(pathStat);
  fs.realpath.mockResolvedValue("/cache/installer.exe");
  fs.open.mockResolvedValue({
    stat: vi.fn(async () => handleStat),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      if (position >= bytes.length) return { bytesRead: 0, buffer };
      const bytesRead = Math.min(length, bytes.length - position);
      bytes.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead, buffer };
    }),
    close: vi.fn(async () => {}),
  });

  await expect(verifyDownloadedArtifact("/cache/installer.exe", artifact)).resolves.toMatchObject({
    path: "/cache/installer.exe",
    identity: expect.stringContaining('"742408122","281474978074229"'),
  });
});

describe.each([
  ["inode", { ino: 12n }],
  ["size", { size: 27n }],
  ["modification time", { mtimeNs: 19_000_000n }],
  ["change time", { ctimeNs: 23_000_000n }],
] as const)("descriptor binding for %s", (_label, handleOverrides) => {
  it("rejects a swap before open even when the original path is restored", async () => {
    emulatePlatform("win32");
    const bytes = Buffer.from("verified desktop installer");
    const artifact = windowsUpdateFixture("0.5.5", bytes);
    const pathStat = stat({ dev: 0n, size: BigInt(bytes.length) });
    const handleStat = stat({ dev: 742_408_122n, size: BigInt(bytes.length), ...handleOverrides });
    fs.lstat.mockResolvedValue(pathStat);
    fs.realpath.mockResolvedValue("/cache/installer.exe");
    fs.open.mockResolvedValue({
      stat: vi.fn(async () => handleStat),
      read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
        if (position >= bytes.length) return { bytesRead: 0, buffer };
        const bytesRead = Math.min(length, bytes.length - position);
        bytes.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead, buffer };
      }),
      close: vi.fn(async () => {}),
    });

    await expect(verifyDownloadedArtifact("/cache/installer.exe", artifact)).rejects.toThrow(/path changed/i);
  });
});

it("rejects a cross-API device mismatch outside Windows", async () => {
  emulatePlatform("linux");
  const bytes = Buffer.from("verified desktop installer");
  const artifact = windowsUpdateFixture("0.5.5", bytes);
  const pathStat = stat({ dev: 0n, size: BigInt(bytes.length) });
  const handleStat = stat({ dev: 742_408_122n, size: BigInt(bytes.length) });
  fs.lstat.mockResolvedValue(pathStat);
  fs.realpath.mockResolvedValue("/cache/installer.exe");
  fs.open.mockResolvedValue({
    stat: vi.fn(async () => handleStat),
    close: vi.fn(async () => {}),
  });

  await expect(verifyDownloadedArtifact("/cache/installer.exe", artifact)).rejects.toThrow(/path changed/i);
});

it("rejects a nonzero cross-API device mismatch on Windows", async () => {
  emulatePlatform("win32");
  const bytes = Buffer.from("verified desktop installer");
  const artifact = windowsUpdateFixture("0.5.5", bytes);
  const pathStat = stat({ dev: 7n, size: BigInt(bytes.length) });
  const handleStat = stat({ dev: 742_408_122n, size: BigInt(bytes.length) });
  fs.lstat.mockResolvedValue(pathStat);
  fs.realpath.mockResolvedValue("/cache/installer.exe");
  fs.open.mockResolvedValue({
    stat: vi.fn(async () => handleStat),
    close: vi.fn(async () => {}),
  });

  await expect(verifyDownloadedArtifact("/cache/installer.exe", artifact)).rejects.toThrow(/path changed/i);
});

it("still rejects a replaced path leaf while an unchanged handle remains open", async () => {
  const bytes = Buffer.from("verified desktop installer");
  const artifact = windowsUpdateFixture("0.5.5", bytes);
  const firstPath = stat({ size: BigInt(bytes.length) });
  const replacedPath = stat({ ino: 12n, size: BigInt(bytes.length) });
  fs.lstat
    .mockResolvedValueOnce(firstPath)
    .mockResolvedValueOnce(replacedPath)
    .mockResolvedValue(replacedPath);
  fs.realpath.mockResolvedValue("/cache/installer.exe");
  fs.open.mockResolvedValue({
    stat: vi.fn(async () => firstPath),
    read: vi.fn(),
    close: vi.fn(async () => {}),
  });

  await expect(verifyDownloadedArtifact("/cache/installer.exe", artifact)).rejects.toThrow(/path changed/i);
});
