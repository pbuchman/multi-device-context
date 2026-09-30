import { fileURLToPath } from 'node:url';
import { ContentSchema, MAX_ATTACHMENT_BYTES, isTrustedAppUrl, type NativeFile, type ClipboardSnapshot } from '@mdc/contracts';

export const MAX_SNAPSHOT_FILES = 32;
export const MAX_SNAPSHOT_BYTES = MAX_ATTACHMENT_BYTES;
export function assertTrustedSender(url: string, topLevel: boolean, appOrigin: string): void {
  if (!topLevel || !isTrustedAppUrl(url, appOrigin)) throw new Error('This window cannot use native features.');
}
export function safeExternalUrl(candidate: string): string {
  const url = new URL(candidate);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only web links can open in the browser.');
  return url.href;
}
export function nativeFilePath(candidate: string, platform: NodeJS.Platform): string {
  const url = new URL(candidate);
  // Even file://localhost is rejected: only absolute, local clipboard paths.
  if (!candidate.startsWith('file:///') || url.protocol !== 'file:' || url.hostname || url.username || url.password || url.search || url.hash)
    throw new Error('Only local files can be shared. Network locations are unsupported.');
  const path = fileURLToPath(url, { windows: platform === 'win32' });
  if (platform === 'win32' && (!/^[a-z]:\\/iu.test(path) || path.slice(2).includes(':'))) throw new Error('Only ordinary local drive files can be shared.');
  return path;
}
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw new Error('Invalid native request.');
  return value as Record<string, unknown>;
}
export function validateNativeFile(value: unknown): NativeFile {
  const input = object(value, ['name', 'contentType', 'bytes']);
  if (!(input.bytes instanceof Uint8Array)) throw new Error('File bytes are required.');
  const content = ContentSchema.parse({ kind: 'attachment', name: input.name, contentType: input.contentType, size: input.bytes.byteLength });
  if (content.kind !== 'attachment') throw new Error('Invalid attachment.');
  return { name: content.name, contentType: content.contentType, bytes: Uint8Array.from(input.bytes) };
}
export function validateSnapshot(value: unknown): ClipboardSnapshot {
  const input = object(value, ['text', 'files']);
  if (!Array.isArray(input.files) || input.files.length > MAX_SNAPSHOT_FILES) throw new Error(`Share at most ${MAX_SNAPSHOT_FILES} files at once.`);
  const files = input.files.map(validateNativeFile);
  let text: string | undefined;
  if (input.text !== undefined) {
    const content = ContentSchema.parse({kind:'text',text:input.text});
    if (content.kind === 'attachment') throw new Error('Invalid clipboard text.');
    text = content.text;
  }
  if (!text && files.length === 0) throw new Error('The clipboard has no supported text, image or files.');
  if (files.reduce((size,file) => size + file.bytes.byteLength, 0) > MAX_SNAPSHOT_BYTES) throw new Error('Share at most 100 MiB of files at once.');
  return text === undefined ? { files } : { text, files };
}
export function safeFilename(name: string): string {
  let safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').replace(/[. ]+$/u, '').slice(0,240);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(safe)) safe = `_${safe}`;
  return safe || 'attachment';
}
