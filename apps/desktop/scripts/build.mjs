import { build } from 'esbuild';
import { cp, mkdir, writeFile } from 'node:fs/promises';
const value=process.env.MDC_APP_ORIGIN;
let origin;
try {
 const url=new URL(value);
 if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error();
 origin=url.origin;
} catch {throw new Error('Set MDC_APP_ORIGIN to the trusted HTTPS application origin before building.');}
await mkdir('dist',{recursive:true});
for(const name of ['main','preload']) await build({entryPoints:[`src/${name}.ts`],outfile:`dist/${name}.cjs`,bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron'],define:{MDC_APP_ORIGIN:JSON.stringify(origin)},sourcemap:false,minify:false});
await cp('resources','dist/resources',{recursive:true});
await writeFile('dist/build-info.json',JSON.stringify({appOrigin:origin,bridgeVersion:1},null,2)+'\n');
