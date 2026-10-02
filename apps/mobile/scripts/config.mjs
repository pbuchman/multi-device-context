import { RuntimeConfigSchema } from '../../../packages/contracts/src/index.ts';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export function validateOrigin(origin) {
 const parsed=new URL(origin);
 if(parsed.protocol!=='https:' || parsed.origin!==origin || parsed.username || parsed.password) throw new Error('MDC_APP_ORIGIN must be a canonical HTTPS origin');
 return origin;
}
export function validateConfig(value, origin) {
 const config=RuntimeConfigSchema.parse(value);
 if(config.appOrigin!==origin) throw new Error('Runtime app origin differs from trusted MDC_APP_ORIGIN');
 return config;
}
const escapeXml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export async function generateConfig({release=false}={}) {
 const fixture=process.env.MDC_MOBILE_CONFIG_FIXTURE;
 if(release && fixture) throw new Error('Release refuses fixture configuration');
 if(fixture && process.env.CI!=='true') throw new Error('Fixture config is only allowed with CI=true');
 const origin=process.env.MDC_APP_ORIGIN;
 if(!origin) throw new Error('Set MDC_APP_ORIGIN to the trusted HTTPS application origin');
 validateOrigin(origin);
 const response=fixture ? JSON.parse(await readFile(fixture,'utf8')) : await fetch(new URL('/api/config',origin),{redirect:'error',signal:AbortSignal.timeout(15000)}).then(r=>{if(!r.ok)throw new Error(`Config fetch failed: ${r.status}`);return r.json();});
 const config=validateConfig(response,origin);
 const publicDir=new URL('../../web/public/',import.meta.url); await mkdir(publicDir,{recursive:true});
 await writeFile(new URL('mobile-config.json',publicDir),JSON.stringify(config));
 const dir=new URL('../android/app/src/main/res/values/',import.meta.url); await mkdir(dir,{recursive:true});
 const values={mdc_app_origin:origin,com_auth0_domain:config.auth0.domain,com_auth0_client_id:config.auth0.nativeClientId,mdc_audience:config.auth0.audience,mdc_connection:config.auth0.connection,mdc_fixture:fixture?'true':'false'};
 await writeFile(new URL('mobile_config.xml',dir),`<resources>\n${Object.entries(values).map(([k,v])=>`<string name="${k}" translatable="false">${escapeXml(v)}</string>`).join('\n')}\n</resources>\n`);
 return config;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) await generateConfig({release:process.argv.includes('--release')});
export function mobileCsp(config) {
 return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' ${config.appOrigin} https://${config.auth0.domain} https://firestore.googleapis.com https://firebasestorage.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`;
}
