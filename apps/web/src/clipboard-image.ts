import type { NativeFile } from "@mdc/contracts";

const PNG = "image/png";

function bytesBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function pngName(name: string): string {
  const lastDot = name.lastIndexOf(".");
  return `${lastDot > 0 ? name.slice(0, lastDot) : name}.png`;
}

export async function clipboardImageFile(file: NativeFile): Promise<NativeFile> {
  if (!file.contentType.startsWith("image/") || file.contentType === "image/svg+xml" || file.contentType === PNG) return file;
  const bitmap = await createImageBitmap(new Blob([bytesBuffer(file.bytes)], { type: file.contentType }));
  try {
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This image cannot be copied in this browser.");
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("This image cannot be copied in this browser.")), PNG));
    return { name: pngName(file.name), contentType: PNG, bytes: new Uint8Array(await blob.arrayBuffer()) };
  } finally { bitmap.close(); }
}

export async function browserCopyFile(file: NativeFile): Promise<void> {
  if (!file.contentType.startsWith("image/") || file.contentType === "image/svg+xml" || !("ClipboardItem" in window)) {
    throw new Error("File copying is available in the desktop app. Use Save in this browser.");
  }
  const image = await clipboardImageFile(file);
  if (typeof ClipboardItem.supports === "function" && !ClipboardItem.supports(PNG)) throw new Error("Image copying is unavailable in this browser.");
  await navigator.clipboard.write([new ClipboardItem({ [PNG]: new Blob([bytesBuffer(image.bytes)], { type: PNG }) })]);
}
