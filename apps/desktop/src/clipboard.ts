import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { MAX_ATTACHMENT_BYTES, type ClipboardSnapshot, type NativeFile } from '@mdc/contracts';
import { nativeFilePath, MAX_SNAPSHOT_FILES, MAX_SNAPSHOT_BYTES, validateSnapshot } from './security.js';
export type ClipboardEntry={types:readonly string[];getType(type:string):Promise<Blob|{title:string;url:string}>};
const types:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.pdf':'application/pdf','.txt':'text/plain','.md':'text/markdown','.json':'application/json','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime'};
async function blob(entry:ClipboardEntry,type:string):Promise<Blob> {
 const value=await entry.getType(type);
 if(!(value instanceof Blob) || value.size>MAX_ATTACHMENT_BYTES) throw new Error('This clipboard item is too large or unsupported.');
 return value;
}
type FileIdentity={dev:bigint;ino:bigint;size:bigint};
export function sameFileIdentity(before:FileIdentity,after:FileIdentity,platform:NodeJS.Platform):boolean {
 // Windows path metadata can omit VolumeSerialNumber (0), while handle metadata
 // supplies it. Keep exact 64-bit file IDs and compare known volume IDs.
 const sameVolume=before.dev===after.dev || platform==='win32' && (before.dev===0n || after.dev===0n);
 return sameVolume && before.ino===after.ino && before.size===after.size;
}
async function readFile(path:string,remaining:number):Promise<NativeFile> {
 const before=await lstat(path,{bigint:true});
 if(!before.isFile() || before.isSymbolicLink()) throw new Error('Only regular files can be shared. Folders and links are unsupported.');
 if(before.size<1n || before.size>BigInt(remaining)) throw new Error('Empty files and file selections over 100 MiB are unsupported.');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {
  const info=await file.stat({bigint:true});
  if(!info.isFile() || !sameFileIdentity(before,info,process.platform)) throw new Error('The file changed while being shared. Try again.');
  const bytes=Buffer.alloc(Number(info.size)+1);let offset=0;
  while(offset<bytes.length) {
   const result=await file.read(bytes,offset,bytes.length-offset,null);
   if(result.bytesRead===0) break;offset+=result.bytesRead;
  }
  const after=await file.stat({bigint:true});
  if(BigInt(offset)!==info.size || after.size!==info.size || after.mtimeNs!==info.mtimeNs) throw new Error('The file changed while being shared. Try again.');
  return {name:basename(path),contentType:types[extname(path).toLowerCase()]??'application/octet-stream',bytes:Uint8Array.from(bytes.subarray(0,offset))};
 } finally {await file.close();}
}
export async function captureClipboard(entries:readonly ClipboardEntry[],platform:NodeJS.Platform):Promise<ClipboardSnapshot> {
 if(entries.length>MAX_SNAPSHOT_FILES) throw new Error(`Share at most ${MAX_SNAPSHOT_FILES} items at once.`);
 const files:NativeFile[]=[];const text:string[]=[];let size=0;
 for(const entry of entries) {
  if(entry.types.includes('text/uri-list')) {
   const uris=(await (await blob(entry,'text/uri-list')).text()).split(/\r?\n/u).filter(line=>line && !line.startsWith('#'));
   if(uris.some(uri=>uri.startsWith('file:'))) {
    if(files.length+uris.length>MAX_SNAPSHOT_FILES) throw new Error(`Share at most ${MAX_SNAPSHOT_FILES} files at once.`);
    for(const uri of uris) {
     const file=await readFile(nativeFilePath(uri,platform),MAX_SNAPSHOT_BYTES-size);files.push(file);size+=file.bytes.byteLength;
    }
    continue;
   }
   if(!entry.types.includes('text/plain') && uris.length) {text.push(uris.join('\n'));continue;}
  }
  if(entry.types.includes('image/png')) {
   const image=await blob(entry,'image/png');size+=image.size;
   if(size>MAX_SNAPSHOT_BYTES) throw new Error('Share at most 100 MiB of files at once.');
   files.push({name:`Screenshot ${new Date().toISOString().replace(/[:.]/gu,'-')}.png`,contentType:'image/png',bytes:new Uint8Array(await image.arrayBuffer())});
  } else if(entry.types.includes('text/plain')) {
   const plain=await (await blob(entry,'text/plain')).text();if(plain) text.push(plain);
  }
 }
 return validateSnapshot(text.length?{text:text.join('\n'),files}:{files});
}
