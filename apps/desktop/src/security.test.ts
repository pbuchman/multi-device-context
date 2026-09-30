import { describe, expect, it } from 'vitest';
import { assertTrustedSender, safeExternalUrl, nativeFilePath, validateNativeFile, validateSnapshot, safeFilename } from './security.js';

describe('native privilege boundary', () => {
  it('accepts only the trusted top-level HTTPS frame', () => {
    expect(() => assertTrustedSender('https://context.example.com/context/1', true, 'https://context.example.com')).not.toThrow();
    for (const url of ['https://context.example.com.evil.test','http://context.example.com','file:///private/file','https://user@context.example.com','about:blank'])
      expect(() => assertTrustedSender(url,true,'https://context.example.com')).toThrow();
    expect(() => assertTrustedSender('https://context.example.com',false,'https://context.example.com')).toThrow();
  });
  it('opens only credential-free web links', () => {
    expect(safeExternalUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
    for (const url of ['javascript:alert(1)','file:///etc/passwd','multi-device-context://auth/callback','https://x:y@example.com']) expect(() => safeExternalUrl(url)).toThrow();
  });
  it('rejects remote file locations before touching the filesystem', () => {
    expect(nativeFilePath('file:///C:/Users/Person/image.png','win32')).toBe('C:\\Users\\Person\\image.png');
    expect(nativeFilePath('file:///Users/person/example.txt','darwin')).toBe('/Users/person/example.txt');
    for(const url of ['file://server/share/file','file://localhost/share/file','https://example.com/file','file:///C:/file?query','file:///C:/file#fragment']) expect(() => nativeFilePath(url,'win32')).toThrow();
  });
  it('validates and copies byte input and rejects path or limit violations', () => {
    const input={name:'example.bin',contentType:'application/octet-stream',bytes:new Uint8Array([0,255,32])};
    const file=validateNativeFile(input); input.bytes[0]=1; expect(file.bytes[0]).toBe(0);
    expect(() => validateNativeFile({...input,name:'../secret'})).toThrow();
    expect(() => validateNativeFile({...input,bytes:[]})).toThrow();
    expect(() => validateNativeFile({...input,extra:true})).toThrow();
    expect(() => validateSnapshot({text:'é'.repeat(131073),files:[]})).toThrow();
    expect(validateSnapshot({text:'  code\n',files:[]})).toEqual({text:'  code\n',files:[]});
  });
  it('produces safe local filenames across both platforms', () => {
    expect(safeFilename('CON.txt')).toBe('_CON.txt');
    expect(safeFilename('example?.txt ')).toBe('example_.txt');
    expect(safeFilename('photo.png')).toBe('photo.png');
  });
});
