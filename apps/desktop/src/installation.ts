import { DeviceSessionSchema, IdSchema } from '@mdc/contracts';
import type { NativeStore } from './store.js';
export function accessPanelUrl(origin: string, deviceId: string): string {
 const url = new URL(origin); if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('Invalid application origin.');
 return `${origin}/access?device=${IdSchema.parse(deviceId)}`;
}
export async function exchangeInstallationSession(store: NativeStore, origin: string, token: string, fetcher: typeof fetch = fetch) {
 if (typeof token !== 'string' || token.length > 32768) throw new Error('Invalid sign-in token.');
 // This claim partitions local storage only. The server authenticates every request.
 const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
 if (typeof claims.sub !== 'string' || !claims.sub.startsWith('google-oauth2|') || typeof claims.iss !== 'string' || !claims.aud) throw new Error('Invalid sign-in token.');
 const subject = `google-oauth2|${JSON.stringify([claims.iss, claims.aud, claims.azp, claims.sub])}`;
 const generation = store.accountGeneration();
 const installationGeneration = store.installationGeneration();
 const assertCurrent = () => { if (generation !== store.accountGeneration() || installationGeneration !== store.installationGeneration()) throw new Error('Account changed during session exchange.'); };
 const post = async (path: string, body: unknown) => {
  const response = await fetcher(new URL(path, origin), {method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`Installation authentication failed (${response.status}).`);
  const value: unknown = await response.json(); assertCurrent(); return value;
 };
 let proof = store.readInstallation(subject);
 if (!proof) {
  const value = await post('/api/devices/enroll',{name:store.device().name,platform:'desktop'}) as {device:{id:string};credential:string};
  IdSchema.parse(value.device.id);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value.credential)) throw new Error('Invalid installation credential.');
  proof = {deviceId:value.device.id,secret:value.credential};
  await store.writeInstallation(subject,proof,generation,installationGeneration); assertCurrent();
 }
 const result = DeviceSessionSchema.parse(await post('/api/session',{deviceId:proof.deviceId,credential:proof.secret}));
 if (result.device.id !== proof.deviceId) throw new Error('Installation identity mismatch.');
 return result;
}
