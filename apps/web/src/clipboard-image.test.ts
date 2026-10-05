// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, expect, it, vi } from "vitest";

import { browserCopyFile } from "./clipboard-image.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("copies a JPEG through the browser clipboard as a decoded PNG", async () => {
  const drawImage = vi.fn(), close = vi.fn();
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 640, height: 480, close })));
  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tagName: string, options?: ElementCreationOptions) => {
    if (tagName !== "canvas") return originalCreateElement(tagName, options);
    return {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob: (callback: BlobCallback) => callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })),
    } as unknown as HTMLCanvasElement;
  });
  class TestClipboardItem {
    static supports(type: string) { return type === "image/png"; }
    constructor(readonly entries: Record<string, Blob>) {}
  }
  const write = vi.fn(async (_items: ClipboardItem[]) => undefined);
  vi.stubGlobal("ClipboardItem", TestClipboardItem);
  vi.stubGlobal("navigator", { clipboard: { write } });

  await browserCopyFile({ name: "photo.jpg", contentType: "image/jpeg", bytes: new Uint8Array([255, 216, 255, 217]) });

  expect(createImageBitmap).toHaveBeenCalledTimes(1);
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  const clipboardItem = (write.mock.calls[0]![0] as unknown as TestClipboardItem[])[0]!;
  expect(Object.keys(clipboardItem.entries)).toEqual(["image/png"]);
  expect(clipboardItem.entries["image/png"]?.type).toBe("image/png");
});
