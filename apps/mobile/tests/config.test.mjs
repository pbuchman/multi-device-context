import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../scripts/config.mjs';
const config={appOrigin:'https://mdc.example.com',auth0:{domain:'example.auth0.com',audience:'api',webClientId:'web',nativeClientId:'native',connection:'google-oauth2'},firebase:{apiKey:'public',authDomain:'example.firebaseapp.com',projectId:'example',storageBucket:'example.appspot.com'},limits:{maxTextBytes:262144,maxAttachmentBytes:104857600},bridgeVersion:1};
test('accepts exact trusted runtime configuration',()=>assert.deepEqual(validateConfig(config,config.appOrigin),config));
test('rejects mismatched origins and unsafe native auth domains',()=>{assert.throws(()=>validateConfig(config,'https://other.example'));assert.throws(()=>validateConfig({...config,auth0:{...config.auth0,domain:'evil.com/path'}},config.appOrigin));});
test('rejects drift and extra runtime configuration fields',()=>{assert.throws(()=>validateConfig({...config,extra:true},config.appOrigin));assert.throws(()=>validateConfig({...config,limits:{...config.limits,maxTextBytes:99}},config.appOrigin));});
test('bundled CSP pins network destinations and disallows remote scripts',async()=>{
 const {mobileCsp}=await import('../scripts/config.mjs');const csp=mobileCsp(config);
 assert.match(csp,/script-src 'self'/);assert.match(csp,/connect-src 'self' https:\/\/mdc.example.com/);assert.ok(!csp.includes('https:;'));assert.match(csp,/object-src 'none'/);
});
test('release refuses a fixture before fetching or writing config',async()=>{
 const {generateConfig}=await import('../scripts/config.mjs');const previous=process.env.MDC_MOBILE_CONFIG_FIXTURE;
 process.env.MDC_MOBILE_CONFIG_FIXTURE='explicit-fixture.json';
 try {await assert.rejects(generateConfig({release:true}),/Release refuses fixture/);}finally{if(previous===undefined)delete process.env.MDC_MOBILE_CONFIG_FIXTURE;else process.env.MDC_MOBILE_CONFIG_FIXTURE=previous;}
});
test('rejects noncanonical or insecure origins before fetching',async()=>{
 const {validateOrigin}=await import('../scripts/config.mjs');
 for(const value of ['http://mdc.example.com','https://user:password@mdc.example.com','https://mdc.example.com/path','https://mdc.example.com/','https://mdc.example.com?x=1'])assert.throws(()=>validateOrigin(value));
 assert.equal(validateOrigin(config.appOrigin),config.appOrigin);
});
test('fixture config is explicitly restricted to CI',async()=>{
 const {generateConfig}=await import('../scripts/config.mjs');const oldFixture=process.env.MDC_MOBILE_CONFIG_FIXTURE;const oldCI=process.env.CI;
 process.env.MDC_MOBILE_CONFIG_FIXTURE='fixture.json';delete process.env.CI;
 try {await assert.rejects(generateConfig(),/only allowed with CI=true/);}finally{if(oldFixture===undefined)delete process.env.MDC_MOBILE_CONFIG_FIXTURE;else process.env.MDC_MOBILE_CONFIG_FIXTURE=oldFixture;if(oldCI===undefined)delete process.env.CI;else process.env.CI=oldCI;}
});
