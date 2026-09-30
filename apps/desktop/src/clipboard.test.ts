import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { captureClipboard, sameFileIdentity, fileClipboardRepresentations } from "./clipboard.js";
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
function item(parts: Record<string, string | Uint8Array>) {
  return {
    types: Object.keys(parts),
    getType: async (type: string) => new Blob([parts[type] as BlobPart]),
  };
}
describe("clipboard normalization", () => {
  it("preserves code whitespace and does not execute rich content", async () => {
    expect(
      await captureClipboard(
        [
          item({
            "text/plain": "  const a=1;\n",
            "text/html": "<script>evil()</script>",
          }),
        ],
        "darwin",
      ),
    ).toEqual({ text: "  const a=1;\n", files: [] });
  });
  it("captures file bytes and omits the alternate local path text", async () => {
    const folder = await mkdtemp(join(tmpdir(), "mdc-clipboard-"));
    folders.push(folder);
    const file = join(folder, "original.bin");
    await writeFile(file, new Uint8Array([0, 1, 255]));
    const result = await captureClipboard(
      [item({ "text/uri-list": pathToFileURL(file).href, "text/plain": file })],
      process.platform,
    );
    expect(result.text).toBeUndefined();
    expect(result.files).toEqual([
      {
        name: "original.bin",
        contentType: "application/octet-stream",
        bytes: new Uint8Array([0, 1, 255]),
      },
    ]);
    await symlink(file, join(folder, "linked.bin"));
    await expect(
      captureClipboard(
        [
          item({
            "text/uri-list": pathToFileURL(join(folder, "linked.bin")).href,
          }),
        ],
        process.platform,
      ),
    ).rejects.toThrow(/regular/);
    await expect(
      captureClipboard(
        [item({ "text/uri-list": pathToFileURL(folder).href })],
        process.platform,
      ),
    ).rejects.toThrow(/regular/);
  });
  it("handles an unavailable Windows volume ID without losing exact inode checks", () => {
    const file = { dev: 0n, ino: 562949954783006n, size: 3n };
    expect(sameFileIdentity(file, { ...file, dev: 742408122n }, "win32")).toBe(
      true,
    );
    expect(
      sameFileIdentity(file, { ...file, ino: file.ino + 1n }, "win32"),
    ).toBe(false);
    expect(
      sameFileIdentity({ ...file, dev: 1n }, { ...file, dev: 2n }, "win32"),
    ).toBe(false);
    expect(sameFileIdentity(file, { ...file, dev: 742408122n }, "darwin")).toBe(
      false,
    );
  });
  it("supports screenshot PNG and ordinary URL clipboard lists", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    expect(
      (await captureClipboard([item({ "image/png": bytes })], "win32")).files[0]
        ?.bytes,
    ).toEqual(bytes);
    expect(
      await captureClipboard(
        [item({ "text/uri-list": "https://example.com/path" })],
        "darwin",
      ),
    ).toEqual({ text: "https://example.com/path", files: [] });
    await expect(
      captureClipboard(
        [item({ "application/custom": "unsupported" })],
        "win32",
      ),
    ).rejects.toThrow(/supported/);
  });
});


describe("native copied-file representations", () => {
  it("keeps the macOS PNG representation on the same copied-file pasteboard item", async () => {
    const file = { name: "shot.png", contentType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) };
    const path = "/private/export/shot.png";
    const formats = fileClipboardRepresentations(file, path, "darwin");
    expect(Object.keys(formats)).toEqual(["text/uri-list", 'electron application/osclipboard;format="public.png"']);
    expect(formats["text/uri-list"]).toBe(pathToFileURL(path).href);
    expect(new Uint8Array(await (formats['electron application/osclipboard;format="public.png"'] as Blob).arrayBuffer())).toEqual(file.bytes);
    expect(Object.keys(fileClipboardRepresentations(file, path, "win32"))).toEqual(["text/uri-list", "image/png"]);
    expect(Object.keys(fileClipboardRepresentations({ ...file, contentType: "application/octet-stream" }, path, "darwin"))).toEqual(["text/uri-list"]);
  });
});
