package com.multidevicecontext.mobile

import android.Manifest
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageInstaller
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class UpdateSecurityTest {
 private val target by lazy {ApplicationProvider.getApplicationContext<android.content.Context>()}

 @Test fun readsInstalledApkIdentityAndRejectsDowngrade() {
  val inspector=ApkInspector(target)
  val source=File(target.applicationInfo.sourceDir)
  val identity=inspector.inspectArchive(source)
  assertEquals(target.packageName,identity.packageName)
  assertEquals(BuildConfig.VERSION_NAME,identity.versionName)
  assertEquals(BuildConfig.VERSION_CODE.toLong(),identity.versionCode)
  assertTrue(identity.signerDigests.isNotEmpty())
  val cached=cacheCopy(source)
  val offer=AndroidUpdateOffer(identity.versionName,identity.versionCode,"https://github.com/pbuchman/multi-device-context/releases/download/v${identity.versionName}/fixture.apk","fixture.apk",cached.length(),"0".repeat(64),"A".repeat(86)+"==",26)
  val failure=assertThrows(IllegalArgumentException::class.java) {inspector.validate(cached,offer)}
  assertTrue(failure.message!!.contains("increase"))
 }

 @Test fun rejectsAnApkForTheInstrumentationPackageEvenWithTheSameDebugSigner() {
  val inspector=ApkInspector(target)
  val testApk=File(InstrumentationRegistry.getInstrumentation().context.applicationInfo.sourceDir)
  val identity=inspector.inspectArchive(testApk)
  assertNotEquals(target.packageName,identity.packageName)
  val cached=cacheCopy(testApk)
  val offer=AndroidUpdateOffer(identity.versionName,identity.versionCode,"https://github.com/pbuchman/multi-device-context/releases/download/v${identity.versionName}/fixture.apk","fixture.apk",cached.length(),"0".repeat(64),"A".repeat(86)+"==",26)
  val failure=assertThrows(IllegalArgumentException::class.java) {inspector.validate(cached,offer)}
  assertTrue(failure.message!!.contains("different application"))
 }

 @Test fun installPermissionIsDeclaredButNeverPreGrantedAndReceiverIsPrivate() {
  val requested=target.packageManager.getPackageInfo(target.packageName,android.content.pm.PackageManager.GET_PERMISSIONS).requestedPermissions.orEmpty().toSet()
  assertTrue(requested.contains(Manifest.permission.REQUEST_INSTALL_PACKAGES))
  assertFalse(target.packageManager.canRequestPackageInstalls())
  val receiver=target.packageManager.getReceiverInfo(ComponentName(target,UpdateInstallReceiver::class.java),0)
  assertFalse(receiver.exported)
 }

 @Test fun spoofedInstallerCallbackCannotChangeState() {
  val manager=AndroidUpdateManager.get(target);val before=manager.getState().toString()
  val prefs=target.getSharedPreferences("mdc-updates",android.content.Context.MODE_PRIVATE)
  prefs.edit().putInt("installerSession",123).putString("installerToken","real-token").putString("installerVersion","0.5.5").commit()
  try {
   val spoof=Intent(target,UpdateInstallReceiver::class.java).setAction(AndroidUpdateManager.ACTION_INSTALL_STATUS).setData(android.net.Uri.parse("mdc-update://install/spoofed"))
    .putExtra(PackageInstaller.EXTRA_SESSION_ID,123).putExtra(PackageInstaller.EXTRA_STATUS,PackageInstaller.STATUS_SUCCESS)
   manager.handleInstallStatus(spoof)
   assertEquals(before,manager.getState().toString())
   assertEquals("real-token",prefs.getString("installerToken",null))
  } finally {prefs.edit().clear().commit()}
 }

 @Test fun confirmationLaunchFailureClearsTheSessionAndLeavesRetryableError() {
  val manager=AndroidUpdateManager.get(target)
  val prefs=target.getSharedPreferences("mdc-updates",android.content.Context.MODE_PRIVATE)
  prefs.edit().putInt("installerSession",321).putString("installerToken","launch-token").putString("installerVersion","0.5.6").commit()
  val missing=Intent().setComponent(ComponentName(target,"com.multidevicecontext.mobile.MissingConfirmationActivity"))
  val callback=Intent(target,UpdateInstallReceiver::class.java).setAction(AndroidUpdateManager.ACTION_INSTALL_STATUS).setData(android.net.Uri.parse("mdc-update://install/launch-token"))
   .putExtra(PackageInstaller.EXTRA_SESSION_ID,321).putExtra(PackageInstaller.EXTRA_STATUS,PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT,missing)
  manager.handleInstallStatus(callback)
  assertEquals("error",manager.getState().getString("status"))
  assertFalse(prefs.contains("installerSession"));assertFalse(prefs.contains("installerToken"))
 }

 @Test fun recoveryAbandonsPersistedButUncommittedInstallerSession() {
  val installer=target.packageManager.packageInstaller
  val sessionId=installer.createSession(PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {setAppPackageName(target.packageName)})
  val prefs=target.getSharedPreferences("mdc-updates",android.content.Context.MODE_PRIVATE)
  prefs.edit().putInt("installerSession",sessionId).putString("installerToken","crash-token").putString("installerVersion","0.5.6").commit()
  val constructor=AndroidUpdateManager::class.java.getDeclaredConstructor(android.content.Context::class.java,Boolean::class.javaPrimitiveType).apply {isAccessible=true}
  val recovered=constructor.newInstance(target,true)
  assertEquals("idle",recovered.getState().getString("status"))
  assertNull(installer.getSessionInfo(sessionId))
  assertFalse(prefs.contains("installerSession"));assertFalse(prefs.contains("installerToken"))
 }

 @Test fun recoveryKeepsACommittedInstallerSessionWithoutANewMarker() {
  val installer=target.packageManager.packageInstaller;val source=File(target.applicationInfo.sourceDir)
  val sessionId=installer.createSession(PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {setAppPackageName(target.packageName);setSize(source.length());setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)})
  val prefs=target.getSharedPreferences("mdc-updates",android.content.Context.MODE_PRIVATE)
  try {
   installer.openSession(sessionId).use {session->source.inputStream().use {input->session.openWrite("base.apk",0,source.length()).use {output->input.copyTo(output);session.fsync(output)}}}
   prefs.edit().putInt("installerSession",sessionId).putString("installerToken","committed-token").putString("installerVersion",BuildConfig.VERSION_NAME).commit()
   val ignored=Intent(target,UpdateInstallReceiver::class.java).setAction("ignored")
   val callback=PendingIntent.getBroadcast(target,sessionId,ignored,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
   installer.openSession(sessionId).use {it.commit(callback.intentSender)}
   waitForCommittedSession(installer,sessionId)
   val constructor=AndroidUpdateManager::class.java.getDeclaredConstructor(android.content.Context::class.java,Boolean::class.javaPrimitiveType).apply {isAccessible=true}
   val recovered=constructor.newInstance(target,true)
   assertEquals("installing",recovered.getState().getString("status"))
   assertEquals("committed-token",prefs.getString("installerToken",null))
  } finally {try {installer.abandonSession(sessionId)} catch(_:Exception) {};prefs.edit().clear().commit()}
 }

 @Test fun tamperedCachedApkDoesNotRemainReadyForAnInstallRetryLoop() {
  val constructor=AndroidUpdateManager::class.java.getDeclaredConstructor(android.content.Context::class.java,Boolean::class.javaPrimitiveType).apply {isAccessible=true}
  val manager=constructor.newInstance(target,false)
  val source=File(target.applicationInfo.sourceDir);val cached=cacheCopy(source)
  val bytes=cached.readBytes();val offer=AndroidUpdateOffer(
   BuildConfig.VERSION_NAME,BuildConfig.VERSION_CODE.toLong()+1,
   "https://github.com/pbuchman/multi-device-context/releases/download/v${BuildConfig.VERSION_NAME}/fixture.apk","fixture.apk",cached.length(),
   MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") {"%02x".format(it)},
   Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-512").digest(bytes)),26,
  )
  val verifiedType=Class.forName("${AndroidUpdateManager::class.java.name}\$VerifiedUpdate")
  val verified=verifiedType.getDeclaredConstructor(AndroidUpdateOffer::class.java,File::class.java).apply {isAccessible=true}.newInstance(offer,cached)
  val verifiedField=AndroidUpdateManager::class.java.getDeclaredField("verified").apply {isAccessible=true};verifiedField.set(manager,verified)
  cached.appendBytes(byteArrayOf(0))
  assertThrows(IllegalArgumentException::class.java) {manager.install()}
  assertEquals("error",manager.getState().getString("status"))
  assertFalse(cached.exists());assertNull(verifiedField.get(manager))
 }

 private fun cacheCopy(source:File):File {
  val dir=File(target.cacheDir,"updates").apply {mkdirs()};return File(dir,"update.apk").also {source.copyTo(it,true)}
 }
 private fun waitForCommittedSession(installer:PackageInstaller,id:Int) {
  repeat(40) {
   installer.getSessionInfo(id)?.let {info->if(if(android.os.Build.VERSION.SDK_INT>=29)info.isCommitted else @Suppress("DEPRECATION") info.isSealed)return}
   Thread.sleep(50)
  }
  throw AssertionError("Installer session was not committed")
 }
}
