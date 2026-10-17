import { build } from "../../web/node_modules/vite/dist/node/index.js";
import { fileURLToPath } from "node:url";
const entry=fileURLToPath(new URL("../tests/android-dictation-hook.tsx",import.meta.url));
const outDir=fileURLToPath(new URL("../android/app/src/androidTest/assets",import.meta.url));
await build({configFile:false,logLevel:"warn",define:{"process.env.NODE_ENV":JSON.stringify("production")},build:{lib:{entry,name:"DictationHookFixture",formats:["iife"],fileName:()=>"dictation-hook-fixture.js"},outDir,emptyOutDir:false,minify:false}});
