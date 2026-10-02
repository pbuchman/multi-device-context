import type { ClipboardSnapshot, Content } from "@mdc/contracts";
import { ContentSchema } from "@mdc/contracts";
import { fileParts } from "./media.js";

export type SharePart = { content: Content; bytes?: Uint8Array };
export type SelectionSnapshot = { text: string; start: number; end: number };

export function insertClipboardText(selection: SelectionSnapshot, pasted: string) {
  const start = Math.max(0, Math.min(selection.text.length, selection.start));
  const end = Math.max(start, Math.min(selection.text.length, selection.end));
  return { text: selection.text.slice(0, start) + pasted + selection.text.slice(end), caret: start + pasted.length };
}

export function keyboardSends(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }, android: boolean, code: boolean): boolean {
  if (event.key !== "Enter" || event.isComposing || event.altKey) return false;
  if (event.ctrlKey || event.metaKey) return true;
  return !android && !code && !event.shiftKey;
}

/** Validate before prompting; detach mutable native byte arrays from the clipboard. */
export async function frozenClipboardParts(snapshot: ClipboardSnapshot, code: boolean): Promise<SharePart[]> {
  const text = snapshot.text;
  const files = snapshot.files.map(file => ({ ...file, bytes: file.bytes.slice() }));
  const attachments = await fileParts(files);
  return [
    ...(text?.length ? [{ content: ContentSchema.parse({ kind: code ? "code" : "text", text }) }] : []),
    ...attachments.map(part => ({ content: part.content, bytes: part.bytes.slice() })),
  ];
}
