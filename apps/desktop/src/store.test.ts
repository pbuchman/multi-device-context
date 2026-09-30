import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { NativeStore, type Encryption } from './store.js';
const folders:string[]=[];
const key=randomBytes(32);
const encryption:Encryption={available:()=>true,encrypt:text=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([cipher.update(text),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]);},decrypt:bytes=>{const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');}};
afterEach(async()=>{await Promise.all(folders.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function open(){const path=await mkdtemp(join(tmpdir(),'mdc-store-'));folders.push(path);return {path,store:await NativeStore.open(path,'https://context.example.com','Test computer',encryption)};}
describe('durable native clipboard queue',()=>{
 it('persists exact bytes before returning and replays them after restart without plaintext',async()=>{
  const {path,store}=await open();
  const pending=await store.enqueue({text:' secret whitespace \n',files:[{name:'original.bin',contentType:'application/octet-stream',bytes:new Uint8Array([0,255,128])}]});
  const file=await readFile(join(path,'private-state.bin'));expect(file.includes(Buffer.from('secret whitespace'))).toBe(false);
  const restored=await NativeStore.open(path,'https://context.example.com','Renamed computer',encryption);
  expect(restored.pendingShares()).toEqual([pending]);expect(restored.device()).toEqual(store.device());
  await restored.acknowledge(pending.id);
  expect((await NativeStore.open(path,'https://context.example.com','Test',encryption)).pendingShares()).toEqual([]);
 });
 it('serializes concurrent captures and prevents account mixing',async()=>{
  const {path,store}=await open();
  await Promise.all(['one','two','three'].map(text=>store.enqueue({text,files:[]})));
  await store.writeSession({uid:'owner_one',subject:'google-oauth2|one',refreshToken:'refresh1',authScope:'X'.repeat(43)});
  await store.clearSession();expect(store.pendingShares()).toHaveLength(3);
  await expect(store.writeSession({uid:'owner_two',subject:'google-oauth2|two',refreshToken:'refresh2',authScope:'X'.repeat(43)})).rejects.toThrow(/Sign out/);
  expect(store.pendingShares()).toHaveLength(3);
  await store.clearAccount();
  await store.writeSession({uid:'owner_two',subject:'google-oauth2|two',refreshToken:'refresh2',authScope:'X'.repeat(43)});
  const restored=await NativeStore.open(path,'https://context.example.com','Test',encryption);
  expect(restored.pendingShares()).toEqual([]);expect(restored.readSession()?.uid).toBe('owner_two');
 });
 it('rejects a clipboard capture that finishes after account logout',async()=>{
  const {store}=await open();
  const generation=store.accountGeneration();
  await store.clearAccount();
  await expect(store.enqueue({text:'Previous account clipboard',files:[]},generation)).rejects.toThrow(/account changed/);
  expect(store.pendingShares()).toEqual([]);
 });
 it('refuses plaintext fallback and a different app scope',async()=>{
  const {path}=await open();
  await expect(NativeStore.open(path,'https://other.example.com','Test',encryption)).rejects.toThrow(/different/);
  await expect(NativeStore.open(path,'https://context.example.com','Test',{...encryption,available:()=>false})).rejects.toThrow(/encryption/);
 });
});
