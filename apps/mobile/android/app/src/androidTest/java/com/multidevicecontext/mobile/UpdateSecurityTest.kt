package com.multidevicecontext.mobile

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageInstaller
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
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

 private fun cacheCopy(source:File):File {
  val dir=File(target.cacheDir,"updates").apply {mkdirs()};return File(dir,"update.apk").also {source.copyTo(it,true)}
 }
}
