// Exercise the production guard against real resolved Gradle graphs without touching APK assets/config.
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const temporary=await mkdtemp(join(tmpdir(),'mdc-release-guard-'));
const wrapper=fileURLToPath(new URL('../android/gradlew',import.meta.url));
const guard=fileURLToPath(new URL('../android/release-guard.gradle',import.meta.url));
try {
 await writeFile(join(temporary,'settings.gradle'),"rootProject.name = 'mdc-guard-probe'\n");
 await writeFile(join(temporary,'build.gradle'),`
ext.mdcReleaseSigningAvailable = project.findProperty('signed') == 'true'
ext.mdcProductionConfigAvailable = project.findProperty('production') == 'true'
ext.mdcAcceptanceConfigured = project.findProperty('acceptance') == 'true'
ext.mdcAcceptanceCi = project.findProperty('ci') == 'true'
ext.mdcAcceptanceFixtureBuild = project.findProperty('fixture') == 'true'
ext.mdcAcceptancePrivateSigningConfigured = project.findProperty('signed') == 'true'
ext.mdcAcceptanceVersionNameValid = project.findProperty('versionNameValid') == 'true'
ext.mdcAcceptanceVersionCodeValid = project.findProperty('versionCodeValid') == 'true'
ext.mdcAcceptanceUsesGenericDebugSigning = project.findProperty('genericDebugSigning') == 'true'
apply from: '${guard.replaceAll("'","\\'")}'
tasks.register('packageRelease')
tasks.register('assembleRelease') { dependsOn 'packageRelease' }
tasks.register('assembleDebug')
tasks.register('testDebugUnitTest')
tasks.register('packageAcceptance')
tasks.register('assembleAcceptance') { dependsOn 'packageAcceptance' }
tasks.register('assemble') { dependsOn 'assembleDebug', 'assembleRelease', 'assembleAcceptance' }
tasks.register('build') { dependsOn 'assemble', 'testDebugUnitTest' }
`);
 let count=0;
 for(const task of ['assembleRelease','assR']) {
  for(const [signed,production,acceptance] of [[false,true,false],[true,false,false],[false,false,false],[true,true,false],[true,true,true]]) {
   const result=spawnSync(wrapper,['-p',temporary,task,'--dry-run',`-Psigned=${signed}`,`-Pproduction=${production}`,`-Pacceptance=${acceptance}`],{encoding:'utf8',env:process.env});
   const expected=signed&&production&&!acceptance;
   assert.equal(result.status===0,expected,`${task}, signed=${signed}, production=${production}, acceptance=${acceptance}: ${result.stdout}\n${result.stderr}`);
   if(expected)assert.match(result.stdout,/:packageRelease SKIPPED/);
   else assert.match(result.stdout+result.stderr,/Release (?:requires|rejects)/);
   count++;
  }
 }
 const safeAcceptance=['-Psigned=false','-Pproduction=false','-Pacceptance=true','-Pci=true','-Pfixture=true','-PversionNameValid=true','-PversionCodeValid=true','-PgenericDebugSigning=true'];
 for(const task of ['assembleAcceptance','assA']) {
  const result=spawnSync(wrapper,['-p',temporary,task,'--dry-run',...safeAcceptance],{encoding:'utf8',env:process.env});
  assert.equal(result.status,0,`${task}: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout,/:packageAcceptance SKIPPED/);count++;
 }
 for(const task of ['assemble','build']) {
  const result=spawnSync(wrapper,['-p',temporary,task,'--dry-run','-Psigned=true','-Pproduction=true','-Pacceptance=false','-Pci=false','-Pfixture=false','-PversionNameValid=false','-PversionCodeValid=false','-PgenericDebugSigning=false'],{encoding:'utf8',env:process.env});
  assert.notEqual(result.status,0,`${task} unexpectedly scheduled acceptance`);
  assert.match(result.stdout+result.stderr,/Android update acceptance/);count++;
 }
 for(const unsafe of [
  ['private signing','-Psigned=true',...safeAcceptance.slice(1)],
  ['non-CI',...safeAcceptance.filter(value=>value!=='-Pci=true'),'-Pci=false'],
  ['non-fixture',...safeAcceptance.filter(value=>value!=='-Pfixture=true'),'-Pfixture=false'],
  ['missing version',...safeAcceptance.filter(value=>value!=='-PversionNameValid=true'),'-PversionNameValid=false'],
  ['non-debug signing',...safeAcceptance.filter(value=>value!=='-PgenericDebugSigning=true'),'-PgenericDebugSigning=false'],
 ]) {
  const [description,...properties]=unsafe;
  const result=spawnSync(wrapper,['-p',temporary,'assembleAcceptance','--dry-run',...properties],{encoding:'utf8',env:process.env});
  assert.notEqual(result.status,0,`${description} unexpectedly scheduled acceptance`);
  assert.match(result.stdout+result.stderr,/Android update acceptance/);count++;
 }
 const debug=spawnSync(wrapper,['-p',temporary,'testDebugUnitTest','--dry-run','-Psigned=false','-Pproduction=false','-Pacceptance=true'],{encoding:'utf8',env:process.env});
 assert.equal(debug.status,0,debug.stdout+debug.stderr);count++;
 console.log(`${count} Android task graph guard checks passed (aggregate, build, abbreviation, signing, fixture, debug)`);
} finally {await rm(temporary,{recursive:true,force:true});}
