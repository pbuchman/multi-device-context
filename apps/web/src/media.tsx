import { useEffect, useState } from "react";
import type { Content, Id, NativeFile } from "@mdc/contracts";
import { ContentSchema, MAX_ATTACHMENT_BYTES } from "@mdc/contracts";
import type { ItemRecord } from "./model.js";
type Attachment = Extract<Content, { kind: "attachment" }>;
type Cloud = { attachmentBytes(contextId: Id, itemId: Id, content: Attachment): Promise<Uint8Array> };
const downloads = new WeakMap<Cloud, Map<string, Promise<Uint8Array>>>();
function download(cloud: Cloud, item: ItemRecord, content: Attachment) {
  let active = downloads.get(cloud); if (!active) { active = new Map(); downloads.set(cloud, active); }
  const key = `${item.contextId}/${item.id}/${content.contentType}/${content.size}`;
  let pending = active.get(key);
  if (!pending) { pending = cloud.attachmentBytes(item.contextId, item.id, content); active.set(key, pending); void pending.finally(() => active!.delete(key)).catch(() => {}); }
  return pending;
}
export function AttachmentPreview({ item, cloud }: { item: ItemRecord; cloud: Cloud }) {
  const content = item.content.kind === "attachment" ? item.content : undefined;
  const type = content?.contentType, size = content?.size, name = content?.name;
  const renderable = !!content && item.ready && type !== "image/svg+xml" && /^(image|audio|video)\//.test(type!);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    setUrl(undefined); if (!renderable || !content) return;
    let disposed = false, objectUrl: string | undefined;
    void download(cloud, item, content).then(bytes => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: type! })); setUrl(objectUrl);
    }).catch(() => {});
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [cloud, item.contextId, item.id, renderable, type, size]);
  if (!url || !renderable) return null;
  if (type!.startsWith("image/")) return <img className="attachment-preview" src={url} alt={name} />;
  if (type!.startsWith("audio/")) return <audio className="attachment-preview" src={url} controls />;
  return <video className="attachment-preview" src={url} controls />;
}
export async function fileParts(files: File[] | NativeFile[]): Promise<{ content: Content; bytes: Uint8Array }[]> {
  const browser = (file: File | NativeFile): file is File => typeof File !== "undefined" && file instanceof File;
  const sizes = files.map(file => browser(file) ? file.size : file.bytes.byteLength);
  if (files.length > 32 || sizes.some(size => size < 1 || size > MAX_ATTACHMENT_BYTES) || sizes.reduce((a,b) => a+b,0) > MAX_ATTACHMENT_BYTES) throw new Error("Choose up to 32 non-empty files, at most 100 MiB in total.");
  const metadata = files.map((file, i) => ContentSchema.parse({ kind: "attachment", name: file.name, contentType: (browser(file) ? file.type : file.contentType) || "application/octet-stream", size: sizes[i] }));
  const parts = [];
  for (const [i, file] of files.entries()) parts.push({ content: metadata[i]!, bytes: browser(file) ? new Uint8Array(await file.arrayBuffer()) : file.bytes });
  return parts;
}
export function dayLabel(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp), yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
}
