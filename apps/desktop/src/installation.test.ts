import {expect,it,vi} from 'vitest';
import {exchangeInstallationSession,accessPanelUrl} from './installation.js';
import type {NativeStore} from './store.js';
const id='00000000-0000-4000-8000-000000000001';
const token=(sub='google-oauth2|one')=>`header.${Buffer.from(JSON.stringify({sub,iss:'https://auth.example/',aud:'api'})).toString('base64url')}.signature`;
const device={id,name:'Phone',platform:'desktop',mode:'own',version:1,createdAt:1,updatedAt:1};
it('persists proof before exchanging, does not expose it, and binds storage to account',async()=>{
 const proofs=new Map(); const store={installationGeneration:()=>0,accountGeneration:()=>0,device:()=>({name:'Desktop'}),readInstallation:(key:string)=>proofs.get(key),writeInstallation:async(key:string,value:unknown)=>{proofs.set(key,value)}} as unknown as NativeStore;
 const fetcher=vi.fn(async(url:URL,options:RequestInit)=>{
  if(url.pathname.endsWith('enroll'))return new Response(JSON.stringify({device,credential:'a'.repeat(43)}),{status:201});
  expect(proofs.size).toBeGreaterThan(0);expect(JSON.parse(options.body as string)).toEqual({deviceId:id,credential:'a'.repeat(43)});
  return new Response(JSON.stringify({uid:'owner',customToken:'custom',device}));
 });
 expect(await exchangeInstallationSession(store,'https://app.example',token(),fetcher as unknown as typeof fetch)).toEqual({uid:'owner',customToken:'custom',device});
 await exchangeInstallationSession(store,'https://app.example',token('google-oauth2|two'),fetcher as unknown as typeof fetch);
 expect(proofs.size).toBe(2);
 expect(fetcher.mock.calls.every(([,options])=>options.redirect==='error')).toBe(true);
});
it('does not enroll again for invalid saved proof',async()=>{
 const store={installationGeneration:()=>0,accountGeneration:()=>0,readInstallation:()=>({deviceId:id,secret:'a'.repeat(43)})} as unknown as NativeStore;
 const fetcher=vi.fn(async()=>new Response('',{status:403}));
 await expect(exchangeInstallationSession(store,'https://app.example',token(),fetcher as typeof fetch)).rejects.toThrow('403');expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects late enroll completion after sign-out',async()=>{
 let generation=0;const write=vi.fn();const store={installationGeneration:()=>0,accountGeneration:()=>generation,device:()=>({name:'Desktop'}),readInstallation:()=>undefined,writeInstallation:write} as unknown as NativeStore;
 const fetcher=async()=>{generation++;return new Response(JSON.stringify({device,credential:'a'.repeat(43)}));};
 await expect(exchangeInstallationSession(store,'https://app.example',token(),fetcher as typeof fetch)).rejects.toThrow('Account changed');expect(write).not.toHaveBeenCalled();
});
it('constructs only canonical trusted access URLs',()=>{
 expect(accessPanelUrl('https://app.example',id)).toBe(`https://app.example/access?device=${id}`);
 expect(()=>accessPanelUrl('http://app.example',id)).toThrow();expect(()=>accessPanelUrl('https://app.example','../escape')).toThrow();
});
