package com.multidevicecontext.mobile

import java.net.URI
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import java.io.InputStream
import java.io.OutputStream
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

data class AndroidUpdateOffer(
 val version:String,
 val versionCode:Long,
 val url:String,
 val name:String,
 val size:Long,
 val sha256:String,
 val sha512:String,
 val minimumSdk:Int,
)

object UpdateStream {
 fun copyAndVerify(input:InputStream,output:OutputStream,offer:AndroidUpdateOffer,progress:(Long)->Unit) {
  val sha256=MessageDigest.getInstance("SHA-256");val sha512=MessageDigest.getInstance("SHA-512")
  val buffer=ByteArray(64*1024);var transferred=0L
  while(true) {
   val count=input.read(buffer);if(count<0)break
   transferred+=count;require(transferred<=offer.size && transferred<=UpdatePolicy.MAX_ARTIFACT_BYTES) {"Update download exceeds declared size"}
   output.write(buffer,0,count);sha256.update(buffer,0,count);sha512.update(buffer,0,count);progress(transferred)
  }
  require(transferred==offer.size) {"Update download is incomplete"}
  require(sha256.digest().joinToString("") {"%02x".format(it)}==offer.sha256) {"Update SHA-256 does not match"}
  require(Base64.getEncoder().encodeToString(sha512.digest())==offer.sha512) {"Update SHA-512 does not match"}
 }
}

object ApkIdentityPolicy {
 fun validate(candidate:ApkIdentity,installed:ApkIdentity,offer:AndroidUpdateOffer,sdk:Int) {
  require(candidate.packageName==ApkInspector.PACKAGE_NAME) {"Update belongs to a different application"}
  require(candidate.versionName==offer.version && candidate.versionCode==offer.versionCode) {"Update version does not match the catalog"}
  require(candidate.versionCode>installed.versionCode) {"Update version code must increase"}
  require(candidate.minimumSdk<=sdk) {"Update requires a newer Android version"}
  require(candidate.signerDigests==installed.signerDigests && candidate.signerDigests.isNotEmpty()) {"Update signing certificate does not match"}
 }
}

object UpdatePolicy {
 const val CATALOG_URL="https://pbuchman.github.io/multi-device-context/updates/preview.json"
 const val CHECK_INTERVAL_MS=21_600_000L
 const val MAX_CATALOG_BYTES=65_536
 const val MAX_ARTIFACT_BYTES=1_073_741_824L
 private const val REPOSITORY="https://github.com/pbuchman/multi-device-context"
 private val versionPattern=Regex("^(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})$")
 private val sha256Pattern=Regex("^[a-f0-9]{64}$")
 private val sha512Pattern=Regex("^[A-Za-z0-9+/]{86}==$")
 private val commitPattern=Regex("^[a-f0-9]{40}$")
 private val instantPattern=Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$")

 fun parseCatalog(serialized:String,currentVersion:String,currentVersionCode:Long):AndroidUpdateOffer? {
  require(serialized.toByteArray(StandardCharsets.UTF_8).size<=MAX_CATALOG_BYTES) {"Update catalog exceeds 64 KiB"}
  val root=try {
   val tokens=JSONTokener(serialized);val parsed=tokens.nextValue() as? JSONObject ?: throw IllegalArgumentException("Catalog root must be an object")
   require(tokens.nextClean().code==0) {"Unexpected trailing catalog data"};parsed
  } catch(cause:Exception) {throw IllegalArgumentException("Invalid update catalog",cause)}
  exactKeys(root,setOf("schemaVersion","channel","version","commit","publishedAt","releaseUrl","artifacts"))
  require(integer(root,"schemaVersion")==1L && string(root,"channel")=="preview") {"Unsupported update catalog"}
  val version=string(root,"version");require(versionPattern.matches(version)) {"Invalid update version"}
  require(commitPattern.matches(string(root,"commit"))) {"Invalid update commit"}
  val published=string(root,"publishedAt");require(instantPattern.matches(published)) {"Invalid publication time"};Instant.parse(published)
  require(string(root,"releaseUrl")=="$REPOSITORY/releases/tag/v$version") {"Invalid release URL"}
  val artifacts=array(root,"artifacts");require(artifacts.length()==3) {"Expected one artifact per platform"}
  val seen=mutableSetOf<String>();var android:AndroidUpdateOffer?=null
  for(index in 0 until artifacts.length()) {
   val artifact=artifacts.get(index) as? JSONObject ?: throw IllegalArgumentException("Invalid artifact");val platform=string(artifact,"platform")
   require(seen.add(platform) && platform in setOf("darwin","win32","android")) {"Invalid artifact platform"}
   when(platform) {
    "darwin" -> validateDesktopArtifact(artifact,version,"arm64","dmg","mac-arm64.dmg","13.0.0")
    "win32" -> validateDesktopArtifact(artifact,version,"x64","exe","win-x64.exe","10.0.0")
    "android" -> android=parseAndroidArtifact(artifact,version)
   }
  }
  require(seen==setOf("darwin","win32","android") && android!=null) {"Expected one artifact per platform"}
  if(compareVersions(android!!.version,currentVersion)<=0 || android!!.versionCode<=currentVersionCode)return null
  return android
 }

 fun compareVersions(left:String,right:String):Int {
  require(versionPattern.matches(left) && versionPattern.matches(right)) {"Invalid update version"}
  val l=left.split('.').map(String::toInt);val r=right.split('.').map(String::toInt)
  for(i in 0..2) if(l[i]!=r[i])return l[i].compareTo(r[i])
  return 0
 }

 fun allowedCatalogUrl(value:String)=value==CATALOG_URL
 fun allowedArtifactUrl(value:String):Boolean {
  val uri=parseHttps(value) ?: return false
  return uri.host=="github.com" && uri.rawQuery==null && uri.rawFragment==null && uri.path.startsWith("/pbuchman/multi-device-context/releases/download/v")
 }
 fun allowedArtifactRedirect(value:String):Boolean {
  val uri=parseHttps(value) ?: return false
  return uri.host in setOf("github.com","objects.githubusercontent.com","release-assets.githubusercontent.com","github-releases.githubusercontent.com")
 }

 fun verify(bytes:ByteArray,size:Long,sha256:String,sha512:String):Boolean =
  bytes.size.toLong()==size && digest("SHA-256",bytes)==sha256 && Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-512").digest(bytes))==sha512

 fun digest(algorithm:String,bytes:ByteArray)=MessageDigest.getInstance(algorithm).digest(bytes).joinToString("") {"%02x".format(it)}

 private fun validateDesktopArtifact(value:JSONObject,version:String,arch:String,format:String,suffix:String,minimum:String) {
  exactKeys(value,setOf("platform","arch","format","name","url","size","sha256","sha512","minimumSystemVersion"))
  val name="Multi-Device-Context-$version-$suffix"
  require(string(value,"arch")==arch && string(value,"format")==format && string(value,"name")==name) {"Invalid artifact identity"}
  require(string(value,"minimumSystemVersion")==minimum) {"Invalid minimum system version"}
  validateCommon(value,version,name)
 }
 private fun parseAndroidArtifact(value:JSONObject,version:String):AndroidUpdateOffer {
  exactKeys(value,setOf("platform","arch","format","name","url","size","sha256","sha512","versionCode","minimumSdk"))
  val code=integer(value,"versionCode");require(code in 1..2_100_000_000) {"Invalid Android version code"}
  val name="Multi-Device-Context-$version-android-v$code-release.apk"
  require(string(value,"arch")=="universal" && string(value,"format")=="apk" && string(value,"name")==name) {"Invalid Android artifact"}
  require(integer(value,"minimumSdk")==26L) {"Invalid Android minimum SDK"}
  validateCommon(value,version,name)
  return AndroidUpdateOffer(version,code,string(value,"url"),name,integer(value,"size"),string(value,"sha256"),string(value,"sha512"),26)
 }
 private fun validateCommon(value:JSONObject,version:String,name:String) {
  val size=integer(value,"size");require(size in 1..MAX_ARTIFACT_BYTES) {"Invalid artifact size"}
  require(sha256Pattern.matches(string(value,"sha256")) && sha512Pattern.matches(string(value,"sha512"))) {"Invalid artifact digest"}
  val expected="$REPOSITORY/releases/download/v$version/$name"
  require(string(value,"url")==expected && allowedArtifactUrl(expected)) {"Invalid artifact URL"}
 }
 private fun exactKeys(value:JSONObject,expected:Set<String>) {
  val keys=value.keys().asSequence().toSet();require(keys==expected) {"Unexpected catalog fields"}
 }
 private fun string(value:JSONObject,key:String)=value.get(key) as? String ?: throw IllegalArgumentException("$key must be a string")
 private fun array(value:JSONObject,key:String)=value.get(key) as? JSONArray ?: throw IllegalArgumentException("$key must be an array")
 private fun integer(value:JSONObject,key:String):Long {
  val number=value.get(key) as? Number ?: throw IllegalArgumentException("$key must be a number")
  val double=number.toDouble();require(double.isFinite() && double%1.0==0.0 && double>=Long.MIN_VALUE && double<=Long.MAX_VALUE) {"$key must be an integer"}
  return number.toLong()
 }
 private fun parseHttps(value:String):URI?=try {
  URI(value).takeIf {it.scheme=="https" && it.userInfo==null && it.host!=null && it.port==-1}
 } catch(_:Exception) {null}
}
