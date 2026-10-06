package com.multidevicecontext.mobile

import java.security.MessageDigest
import java.util.Base64
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.SocketTimeoutException
import org.junit.Assert.*
import org.junit.Test

class UpdatePolicyTest {
 private val apk = "apk bytes".toByteArray()
 private val sha256 = hex(MessageDigest.getInstance("SHA-256").digest(apk))
 private val sha512 = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-512").digest(apk))

 @Test fun acceptsTheFixedPreviewAndroidArtifact() {
  val offer=UpdatePolicy.parseCatalog(catalog(),"0.5.4",9)
  assertNotNull(offer)
  assertEquals("0.5.5",offer!!.version)
  assertEquals(10,offer.versionCode)
  assertEquals(apk.size.toLong(),offer.size)
 }

 @Test fun rejectsOversizeMalformedAndNonPreviewCatalogs() {
  assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.parseCatalog(" ".repeat(65_537),"0.5.4",9) }
  assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.parseCatalog("{", "0.5.4",9) }
  assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.parseCatalog(catalog()+" trailing", "0.5.4",9) }
  assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.parseCatalog(catalog().replace("\"preview\"","\"stable\""),"0.5.4",9) }
  assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.parseCatalog(catalog().replace("\"publishedAt\":\"2026-10-05T00:00:00.000Z\",","\"publishedAt\":\"2026-10-05T00:00:00.000Z\",\"extra\":true,"),"0.5.4",9) }
  assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.parseCatalog(catalog().replace("\"schemaVersion\":1","\"schemaVersion\":\"1\""),"0.5.4",9) }
  assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.parseCatalog(catalog().replace("\"channel\":\"preview\"","\"channel\":true"),"0.5.4",9) }
  assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.parseCatalog(catalog().replace("\"size\":${apk.size}","\"size\":\"${apk.size}\""),"0.5.4",9) }
 }

 @Test fun rejectsWrongPlatformRepositoryUrlAndApkShape() {
  assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.parseCatalog(catalog().replace("\"platform\":\"android\"","\"platform\":\"linux\""),"0.5.4",9) }
  assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.parseCatalog(catalog().replace("github.com/pbuchman/multi-device-context","evil.example/project"),"0.5.4",9) }
  assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.parseCatalog(catalog().replace("\"minimumSdk\":26","\"minimumSdk\":25"),"0.5.4",9) }
  assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.parseCatalog(catalog().replace("\"format\":\"apk\"","\"format\":\"aab\""),"0.5.4",9) }
  assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.parseCatalog(catalog().replace("\"size\":${apk.size}","\"size\":1073741825"),"0.5.4",9) }
 }

 @Test fun ignoresSameOrOlderVersionsAndRequiresMonotonicVersionCode() {
  assertNull(UpdatePolicy.parseCatalog(catalog().replace("0.5.5","0.5.4"),"0.5.4",9))
  assertNull(UpdatePolicy.parseCatalog(catalog().replace("0.5.5","0.5.3"),"0.5.4",9))
  assertNull(UpdatePolicy.parseCatalog(catalog().replace("v10-release","v9-release").replace("\"versionCode\":10","\"versionCode\":9"),"0.5.4",9))
 }

 @Test fun permitsOnlyExpectedHttpsRedirectTargets() {
  assertEquals("https://pbuchman.github.io/multi-device-context/updates/preview.json",UpdatePolicy.CATALOG_URL)
  assertEquals(21_600_000L,UpdatePolicy.CHECK_INTERVAL_MS)
  assertTrue(UpdatePolicy.allowedCatalogUrl(UpdatePolicy.CATALOG_URL))
  assertFalse(UpdatePolicy.allowedCatalogUrl("http://pbuchman.github.io/multi-device-context/updates/preview.json"))
  assertFalse(UpdatePolicy.allowedCatalogUrl("https://pbuchman.github.io.evil.example/multi-device-context/updates/preview.json"))
  assertTrue(UpdatePolicy.allowedArtifactUrl("https://github.com/pbuchman/multi-device-context/releases/download/v0.5.5/Multi-Device-Context-0.5.5-android-v10-release.apk"))
  assertTrue(UpdatePolicy.allowedArtifactRedirect("https://release-assets.githubusercontent.com/github-production-release-asset/1/file?token=short-lived"))
  assertTrue(UpdatePolicy.allowedArtifactRedirect("https://objects.githubusercontent.com/github-production-release-asset/file"))
  assertFalse(UpdatePolicy.allowedArtifactRedirect("https://githubusercontent.com.evil.example/file"))
  assertFalse(UpdatePolicy.allowedArtifactRedirect("https://raw.githubusercontent.com/pbuchman/multi-device-context/main/file.apk"))
 }

 @Test fun verifiesBothDigestsAndExactSize() {
  assertTrue(UpdatePolicy.verify(apk,apk.size.toLong(),sha256,sha512))
  assertFalse(UpdatePolicy.verify(apk,apk.size.toLong()+1,sha256,sha512))
  assertFalse(UpdatePolicy.verify(apk,apk.size.toLong(),"0".repeat(64),sha512))
  assertFalse(UpdatePolicy.verify(apk,apk.size.toLong(),sha256,Base64.getEncoder().encodeToString(ByteArray(64))))
 }

 @Test fun streamsExactBytesWithProgressAndRejectsPartialOversizeOrWrongDigest() {
  val offer=AndroidUpdateOffer("0.5.5",10,"https://github.com/pbuchman/multi-device-context/releases/download/v0.5.5/Multi-Device-Context-0.5.5-android-v10-release.apk","update.apk",apk.size.toLong(),sha256,sha512,26)
  val progress=mutableListOf<Long>();val output=ByteArrayOutputStream()
  UpdateStream.copyAndVerify(ByteArrayInputStream(apk),output,offer) {progress.add(it)}
  assertArrayEquals(apk,output.toByteArray());assertEquals(apk.size.toLong(),progress.last())
  assertThrows(IllegalArgumentException::class.java) { UpdateStream.copyAndVerify(ByteArrayInputStream(apk.copyOf(apk.size-1)),ByteArrayOutputStream(),offer) {} }
  assertThrows(IllegalArgumentException::class.java) { UpdateStream.copyAndVerify(ByteArrayInputStream(apk+byteArrayOf(1)),ByteArrayOutputStream(),offer) {} }
  assertThrows(IllegalArgumentException::class.java) { UpdateStream.copyAndVerify(ByteArrayInputStream(apk),ByteArrayOutputStream(),offer.copy(sha256="0".repeat(64))) {} }
 }

 @Test fun propagatesAnInterruptedNetworkStreamWithoutAcceptingPartialBytes() {
  val offer=AndroidUpdateOffer("0.5.5",10,"https://github.com/pbuchman/multi-device-context/releases/download/v0.5.5/Multi-Device-Context-0.5.5-android-v10-release.apk","update.apk",apk.size.toLong(),sha256,sha512,26)
  var reads=0
  val disconnected=object:InputStream() {
   override fun read():Int=throw UnsupportedOperationException()
   override fun read(buffer:ByteArray,offset:Int,length:Int):Int {
    if(reads++>0)throw IOException("network disconnected")
    buffer[offset]=apk[0];return 1
   }
  }
  val output=ByteArrayOutputStream()
  assertThrows(IOException::class.java) {UpdateStream.copyAndVerify(disconnected,output,offer) {}}
  assertEquals(1,output.size())
 }

 @Test fun stopsATrickleStreamAtTheWholeOperationDeadline() {
  val bytes=ByteArray(10) {it.toByte()}
  val offer=AndroidUpdateOffer("0.5.5",10,"https://github.com/pbuchman/multi-device-context/releases/download/v0.5.5/Multi-Device-Context-0.5.5-android-v10-release.apk","update.apk",bytes.size.toLong(),hex(MessageDigest.getInstance("SHA-256").digest(bytes)),Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-512").digest(bytes)),26)
  var now=0L;var offset=0
  val trickle=object:InputStream() {
   override fun read():Int=throw UnsupportedOperationException()
   override fun read(buffer:ByteArray,start:Int,length:Int):Int {
    if(offset==bytes.size)return -1
    buffer[start]=bytes[offset++];now+=100_000_000L;return 1
   }
  }
  val output=ByteArrayOutputStream()
  val deadline=UpdateDeadline.afterMillis(250) {now}
  assertThrows(SocketTimeoutException::class.java) {UpdateStream.copyAndVerify(trickle,output,offer,deadline) {}}
  assertEquals(2,output.size())
 }

 @Test fun stopsATrickleCatalogAtTheWholeOperationDeadline() {
  var now=0L;var reads=0
  val trickle=object:InputStream() {
   override fun read():Int=throw UnsupportedOperationException()
   override fun read(buffer:ByteArray,start:Int,length:Int):Int {
    buffer[start]='x'.code.toByte();reads++;now+=100_000_000L;return 1
   }
  }
  val deadline=UpdateDeadline.afterMillis(250) {now}
  assertThrows(SocketTimeoutException::class.java) {UpdateStream.readBounded(trickle,UpdatePolicy.MAX_CATALOG_BYTES.toLong(),deadline) {}}
  assertEquals(3,reads)
 }

 @Test fun apkIdentityRequiresExactPackageCatalogVersionSupportedSdkAndInstalledCertificate() {
  val offer=AndroidUpdateOffer("0.5.5",10,"https://github.com/pbuchman/multi-device-context/releases/download/v0.5.5/update.apk","update.apk",1,"0".repeat(64),"A".repeat(86)+"==",26)
  val installed=ApkIdentity("com.multidevicecontext.mobile","0.5.4",9,26,setOf("trusted"))
  val update=ApkIdentity("com.multidevicecontext.mobile","0.5.5",10,26,setOf("trusted"))
  ApkIdentityPolicy.validate(update,installed,offer,36)
  assertThrows(IllegalArgumentException::class.java) {ApkIdentityPolicy.validate(update.copy(packageName="other.app"),installed,offer,36)}
  assertThrows(IllegalArgumentException::class.java) {ApkIdentityPolicy.validate(update.copy(versionName="0.5.6"),installed,offer,36)}
  assertThrows(IllegalArgumentException::class.java) {ApkIdentityPolicy.validate(update.copy(versionCode=9),installed,offer.copy(versionCode=9),36)}
  assertThrows(IllegalArgumentException::class.java) {ApkIdentityPolicy.validate(update.copy(minimumSdk=37),installed,offer,36)}
  assertThrows(IllegalArgumentException::class.java) {ApkIdentityPolicy.validate(update.copy(signerDigests=setOf("attacker")),installed,offer,36)}
 }

 private fun catalog():String {
  val version="0.5.5";val code=10
  fun artifact(platform:String,arch:String,format:String,name:String,minimum:String)=
   "{\"platform\":\"$platform\",\"arch\":\"$arch\",\"format\":\"$format\",\"name\":\"$name\",\"url\":\"https://github.com/pbuchman/multi-device-context/releases/download/v$version/$name\",\"size\":${apk.size},\"sha256\":\"$sha256\",\"sha512\":\"$sha512\",$minimum}"
  val mac="Multi-Device-Context-$version-mac-arm64.dmg"
  val win="Multi-Device-Context-$version-win-x64.exe"
  val android="Multi-Device-Context-$version-android-v$code-release.apk"
  return "{\"schemaVersion\":1,\"channel\":\"preview\",\"version\":\"$version\",\"commit\":\"${"a".repeat(40)}\",\"publishedAt\":\"2026-10-05T00:00:00.000Z\",\"releaseUrl\":\"https://github.com/pbuchman/multi-device-context/releases/tag/v$version\",\"artifacts\":[${artifact("darwin","arm64","dmg",mac,"\"minimumSystemVersion\":\"13.0.0\"")},${artifact("win32","x64","exe",win,"\"minimumSystemVersion\":\"10.0.0\"")},${artifact("android","universal","apk",android,"\"versionCode\":$code,\"minimumSdk\":26")}]}"
 }
 private fun hex(bytes:ByteArray)=bytes.joinToString("") { "%02x".format(it) }
}
