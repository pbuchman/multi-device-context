package com.multidevicecontext.mobile

import android.app.PendingIntent
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection

data class AndroidUpdateState(
 val status:String,
 val currentVersion:String=BuildConfig.VERSION_NAME,
 val availableVersion:String?=null,
 val transferred:Long?=null,
 val total:Long?=null,
 val message:String?=null,
) {
 fun json():JSONObject=JSONObject().put("status",status).put("platform","android").put("currentVersion",currentVersion).also { value ->
  availableVersion?.let {value.put("availableVersion",it)}
  if(transferred!=null && total!=null)value.put("progress",JSONObject().put("transferred",transferred).put("total",total).put("percent",if(total==0L)0.0 else transferred*100.0/total))
  message?.let {value.put("message",it.take(2048))}
 }
}

data class ApkIdentity(val packageName:String,val versionName:String,val versionCode:Long,val minimumSdk:Int,val signerDigests:Set<String>)

class ApkInspector(private val context:Context) {
 fun validate(file:File,offer:AndroidUpdateOffer):ApkIdentity {
  require(file.canonicalFile.parentFile==File(context.cacheDir,"updates").canonicalFile) {"Update is outside private cache"}
  val identity=inspectArchive(file)
  ApkIdentityPolicy.validate(identity,installed(),offer,Build.VERSION.SDK_INT)
  return identity
 }

 fun inspectArchive(file:File):ApkIdentity {
  @Suppress("DEPRECATION") val flags=if(Build.VERSION.SDK_INT>=28)PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
  val info=if(Build.VERSION.SDK_INT>=33) context.packageManager.getPackageArchiveInfo(file.absolutePath,PackageManager.PackageInfoFlags.of(flags.toLong()))
   else @Suppress("DEPRECATION") context.packageManager.getPackageArchiveInfo(file.absolutePath,flags)
  requireNotNull(info) {"Downloaded file is not an APK"}
  info.applicationInfo?.let {it.sourceDir=file.absolutePath;it.publicSourceDir=file.absolutePath}
  return identity(info)
 }

 fun installed():ApkIdentity {
  @Suppress("DEPRECATION") val flags=if(Build.VERSION.SDK_INT>=28)PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
  val info=if(Build.VERSION.SDK_INT>=33) context.packageManager.getPackageInfo(context.packageName,PackageManager.PackageInfoFlags.of(flags.toLong()))
   else @Suppress("DEPRECATION") context.packageManager.getPackageInfo(context.packageName,flags)
  return identity(info)
 }

 private fun identity(info:PackageInfo):ApkIdentity {
  val signatures=if(Build.VERSION.SDK_INT>=28) requireNotNull(info.signingInfo).apkContentsSigners.toList()
   else @Suppress("DEPRECATION") info.signatures?.toList().orEmpty()
  val digests=signatures.map {signature -> MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") {"%02x".format(it)}}.toSet()
  val code=if(Build.VERSION.SDK_INT>=28)info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
  return ApkIdentity(info.packageName,info.versionName ?: "",code,info.applicationInfo?.minSdkVersion ?: 0,digests)
 }

 companion object {const val PACKAGE_NAME="com.multidevicecontext.mobile"}
}

@SuppressLint("ApplySharedPref", "StaticFieldLeak")
class AndroidUpdateManager private constructor(private val context:Context,recover:Boolean) {
 private val work=Executors.newSingleThreadExecutor {r->Thread(r,"mdc-updates").apply {isDaemon=true}}
 private val timer:ScheduledExecutorService=Executors.newSingleThreadScheduledExecutor {r->Thread(r,"mdc-update-timer").apply {isDaemon=true}}
 private val cache=File(context.cacheDir,"updates")
 private val apk=File(cache,"update.apk")
 private val partial=File(cache,"update.apk.partial")
 private val prefs=context.getSharedPreferences("mdc-updates",Context.MODE_PRIVATE)
 private val inspector=ApkInspector(context)
 private val emitters=mutableMapOf<String,(JSONObject)->Unit>()
 @Volatile private var state=AndroidUpdateState("idle")
 @Volatile private var offer:AndroidUpdateOffer?=null
 private var verified:VerifiedUpdate?=null
 @Volatile private var lastCheckAt=0L

 private data class VerifiedUpdate(val offer:AndroidUpdateOffer,val file:File)

 init {
  cache.mkdirs();partial.delete();apk.delete();if(recover)recoverSessions()
  timer.scheduleWithFixedDelay({automaticCheck()},UpdatePolicy.CHECK_INTERVAL_MS,UpdatePolicy.CHECK_INTERVAL_MS,TimeUnit.MILLISECONDS)
 }

 fun attach(owner:String,emitter:(JSONObject)->Unit) {
  synchronized(emitters) {emitters[owner]=emitter}
  emitter(state.json())
  if(lastCheckAt==0L && context.getString(R.string.mdc_fixture)!="true")automaticCheck()
 }
 fun detach(owner:String) {synchronized(emitters) {emitters.remove(owner)}}
 fun foreground() {if(context.getString(R.string.mdc_fixture)!="true" && System.currentTimeMillis()-lastCheckAt>=UpdatePolicy.CHECK_INTERVAL_MS)automaticCheck()}
 fun getState()=state.json()
 fun execute(block:()->Unit)=work.execute(block)

 fun check():JSONObject {
  if(state.status in setOf("downloading","ready","installing"))return state.json()
  if(System.currentTimeMillis()-lastCheckAt<1_000 && state.status!="error")return state.json()
  publish(AndroidUpdateState("checking"))
  return try {
   val catalog=String(fetchBytes(UpdatePolicy.CATALOG_URL,UpdatePolicy.MAX_CATALOG_BYTES.toLong(),true),Charsets.UTF_8)
   val next=UpdatePolicy.parseCatalog(catalog,BuildConfig.VERSION_NAME,BuildConfig.VERSION_CODE.toLong())
   lastCheckAt=System.currentTimeMillis()
   if(next==null) {
    clearCache();offer=null;publish(AndroidUpdateState("up-to-date"))
   } else {
    if(offer!=next)clearCache();offer=next
    publish(AndroidUpdateState("available",availableVersion=next.version,transferred=0,total=next.size))
   }
   state.json()
  } catch(cause:Exception) {
   lastCheckAt=System.currentTimeMillis();publish(failure("Could not check for updates",cause));throw cause
  }
 }

 fun startUpdate():JSONObject {
  verified?.let {if(revalidate(it))return state.json() else clearCache()}
  val selected=requireNotNull(offer) {"Check for updates before downloading"}
  publish(AndroidUpdateState("downloading",availableVersion=selected.version,transferred=0,total=selected.size))
  partial.delete();cache.mkdirs()
  try {
   download(selected)
   require(partial.renameTo(apk)) {"Could not finalize update download"}
   val ready=VerifiedUpdate(selected,apk);revalidateOrThrow(ready);verified=ready
   publish(AndroidUpdateState("ready",availableVersion=selected.version,transferred=selected.size,total=selected.size))
   return state.json()
  } catch(cause:Exception) {
   partial.delete();apk.delete();verified=null;publish(failure("Could not download and verify the update",cause,selected));throw cause
  }
 }

 fun permissionDenied() {val selected=offer;publish(if(selected==null) AndroidUpdateState("error",message="Installation permission was not granted") else AndroidUpdateState("ready",availableVersion=selected.version,transferred=selected.size,total=selected.size,message="Installation permission was not granted. You can retry."))}

 fun install():JSONObject {
  val ready=requireNotNull(verified) {"Download and verify the update before installing"}
  try {revalidateOrThrow(ready)} catch(cause:Exception) {
   clearCache();publish(invalidCachedUpdate(ready.offer));throw cause
  }
  publish(AndroidUpdateState("installing",availableVersion=ready.offer.version,transferred=ready.offer.size,total=ready.offer.size))
  try {
   commit(ready)
   verified=null;apk.delete()
   return state.json()
  } catch(cause:Exception) {
   if(revalidate(ready))publish(AndroidUpdateState("ready",availableVersion=ready.offer.version,transferred=ready.offer.size,total=ready.offer.size,message="Could not open the Android installer. Retry when ready."))
   else {clearCache();publish(invalidCachedUpdate(ready.offer))}
   throw cause
  }
 }

 private fun invalidCachedUpdate(selected:AndroidUpdateOffer)=AndroidUpdateState("error",availableVersion=selected.version,message="The cached update could not be verified. Check again to download it.")

 private fun automaticCheck() {if(context.getString(R.string.mdc_fixture)=="true")return;execute {try {check()} catch(_:Exception) {}}}
 private fun publish(next:AndroidUpdateState) {
  state=next;val json=next.json();val listeners=synchronized(emitters) {emitters.values.toList()}
  listeners.forEach {listener->try {listener(JSONObject(json.toString()))} catch(_:Exception) {}}
 }
 private fun failure(prefix:String,cause:Exception,selected:AndroidUpdateOffer?=offer)=AndroidUpdateState("error",availableVersion=selected?.version,message="$prefix. ${safeReason(cause)}")
 private fun safeReason(cause:Exception)=when {
  cause.message?.contains("certificate",true)==true -> "The signing certificate did not match."
  cause.message?.contains("version",true)==true -> "The package version was invalid."
  cause.message?.contains("size",true)==true || cause.message?.contains("incomplete",true)==true -> "The downloaded size did not match."
  cause.message?.contains("SHA-",true)==true -> "The downloaded digest did not match."
  else -> "Check your connection and try again."
 }

 private fun download(selected:AndroidUpdateOffer) {
  var current=selected.url;var redirects=0;val deadline=UpdateDeadline.afterMillis(UpdatePolicy.DOWNLOAD_DEADLINE_MS)
  while(true) {
   deadline.check()
   require(if(redirects==0)UpdatePolicy.allowedArtifactUrl(current) else UpdatePolicy.allowedArtifactRedirect(current)) {"Update download URL is not allowed"}
   val connection=open(current,deadline);val cancellation=disconnectAtDeadline(connection,deadline)
   try {
    val code=connection.responseCode
    deadline.check()
    if(code in REDIRECTS) {require(redirects++<5) {"Too many update redirects"};current=redirect(current,connection.getHeaderField("Location"));continue}
    require(code==HttpURLConnection.HTTP_OK) {"Update download failed"}
    val length=connection.contentLengthLong;require(length==-1L || length==selected.size) {"Update size changed"}
    connection.inputStream.use {input->FileOutputStream(partial).use {output->
     var last=-1;UpdateStream.copyAndVerify(input,output,selected,deadline) {transferred->
      connection.readTimeout=deadline.remainingMillis(READ_TIMEOUT_MS)
      val percent=(transferred*100/selected.size).toInt();if(percent!=last) {last=percent;publish(AndroidUpdateState("downloading",availableVersion=selected.version,transferred=transferred,total=selected.size))}
     };output.fd.sync()
    }}
    deadline.check()
    return
   } finally {cancellation.cancel(false);connection.disconnect()}
  }
 }

 private fun fetchBytes(initial:String,maximum:Long,catalog:Boolean):ByteArray {
  var current=initial;var redirects=0;val deadline=UpdateDeadline.afterMillis(UpdatePolicy.CATALOG_DEADLINE_MS)
  while(true) {
   deadline.check()
   require(if(catalog)UpdatePolicy.allowedCatalogUrl(current) else UpdatePolicy.allowedArtifactRedirect(current)) {"Update URL is not allowed"}
   val connection=open(current,deadline);val cancellation=disconnectAtDeadline(connection,deadline)
   try {
    val code=connection.responseCode
    deadline.check()
    if(code in REDIRECTS) {require(redirects++<5) {"Too many update redirects"};current=redirect(current,connection.getHeaderField("Location"));continue}
    require(code==HttpURLConnection.HTTP_OK) {"Update request failed"}
    val length=connection.contentLengthLong;require(length==-1L || length<=maximum) {"Update response exceeds limit"}
    return connection.inputStream.use {input->
     UpdateStream.readBounded(input,maximum,deadline) {connection.readTimeout=deadline.remainingMillis(READ_TIMEOUT_MS)}
    }
   } finally {cancellation.cancel(false);connection.disconnect()}
  }
 }
 private fun disconnectAtDeadline(connection:HttpsURLConnection,deadline:UpdateDeadline)=timer.schedule({connection.disconnect()},deadline.remainingNanos(),TimeUnit.NANOSECONDS)
 private fun open(value:String,deadline:UpdateDeadline)=(URL(value).openConnection() as HttpsURLConnection).apply {
  instanceFollowRedirects=false;connectTimeout=deadline.remainingMillis(CONNECT_TIMEOUT_MS);readTimeout=deadline.remainingMillis(READ_TIMEOUT_MS);requestMethod="GET";useCaches=false
  setRequestProperty("Accept","application/json, application/vnd.android.package-archive;q=0.9")
  setRequestProperty("User-Agent","Multi-Device-Context/${BuildConfig.VERSION_NAME} Android")
 }
 private fun redirect(current:String,location:String?):String {
  require(!location.isNullOrBlank()) {"Update redirect is missing a location"}
  val resolved=URI(current).resolve(location).toString();require(resolved.startsWith("https://")) {"Update redirect must use HTTPS"};return resolved
 }

 private fun revalidate(value:VerifiedUpdate)=try {revalidateOrThrow(value);true} catch(_:Exception) {false}
 private fun revalidateOrThrow(value:VerifiedUpdate) {
  require(value.file==apk && value.file.exists() && value.file.length()==value.offer.size) {"Cached update size changed"}
  value.file.inputStream().use {input->UpdateStream.copyAndVerify(input,OutputStreamSink,value.offer) {}}
  inspector.validate(value.file,value.offer)
 }
 private fun clearCache() {verified=null;partial.delete();apk.delete()}

 private fun commit(value:VerifiedUpdate) {
  val installer=context.packageManager.packageInstaller
  val params=PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
   setAppPackageName(ApkInspector.PACKAGE_NAME);setSize(value.offer.size)
   if(Build.VERSION.SDK_INT>=31)setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
  }
  val sessionId=installer.createSession(params);val token=UUID.randomUUID().toString()
  var committed=false
  try {
   installer.openSession(sessionId).use {session->
    value.file.inputStream().use {input->session.openWrite("base.apk",0,value.offer.size).use {output->UpdateStream.copyAndVerify(input,output,value.offer) {};session.fsync(output)}}
    inspector.validate(value.file,value.offer)
    check(prefs.edit().putInt(KEY_SESSION,sessionId).putString(KEY_TOKEN,token).putString(KEY_VERSION,value.offer.version).commit())
    val callback=Intent(context,UpdateInstallReceiver::class.java).setAction(ACTION_INSTALL_STATUS).setData(Uri.parse("mdc-update://install/$token")).setPackage(context.packageName)
    val flags=PendingIntent.FLAG_UPDATE_CURRENT or if(Build.VERSION.SDK_INT>=31)PendingIntent.FLAG_MUTABLE else 0
    val pending=PendingIntent.getBroadcast(context,sessionId,callback,flags)
    session.commit(pending.intentSender);committed=true
   }
  } finally {
   if(!committed) {prefs.edit().remove(KEY_SESSION).remove(KEY_TOKEN).remove(KEY_VERSION).commit();try {installer.abandonSession(sessionId)} catch(_:Exception) {}}
  }
 }

 fun handleInstallStatus(intent:Intent) {
  val sessionId=intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID,-1);val token=intent.data?.lastPathSegment
  if(intent.action!=ACTION_INSTALL_STATUS || sessionId<0 || sessionId!=prefs.getInt(KEY_SESSION,-2) || token==null || token!=prefs.getString(KEY_TOKEN,null))return
  val version=prefs.getString(KEY_VERSION,null)
  when(intent.getIntExtra(PackageInstaller.EXTRA_STATUS,PackageInstaller.STATUS_FAILURE)) {
   PackageInstaller.STATUS_PENDING_USER_ACTION -> {
    val confirmation=if(Build.VERSION.SDK_INT>=33)intent.getParcelableExtra(Intent.EXTRA_INTENT,Intent::class.java) else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT) as? Intent
    if(confirmation==null)failConfirmation(sessionId,version,"Android did not provide an installation confirmation.")
    else try {context.startActivity(confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))}
    catch(_:Exception) {failConfirmation(sessionId,version,"Android could not open the installation confirmation. Check again to retry.")}
   }
   PackageInstaller.STATUS_SUCCESS -> finishSession(AndroidUpdateState("idle"))
   PackageInstaller.STATUS_FAILURE_ABORTED -> finishSession(AndroidUpdateState("error",availableVersion=version,message="Installation was cancelled. Check again to retry."))
   else -> finishSession(AndroidUpdateState("error",availableVersion=version,message="Android could not install the update. Check again to retry."))
  }
 }
 private fun failConfirmation(sessionId:Int,version:String?,message:String) {
  try {context.packageManager.packageInstaller.abandonSession(sessionId)} catch(_:Exception) {}
  finishSession(AndroidUpdateState("error",availableVersion=version,message=message))
 }
 private fun finishSession(next:AndroidUpdateState) {prefs.edit().remove(KEY_SESSION).remove(KEY_TOKEN).remove(KEY_VERSION).commit();publish(next)}
 private fun recoverSessions() {
  val installer=context.packageManager.packageInstaller;val active=prefs.getInt(KEY_SESSION,-1);val activeInfo=if(active>=0)installer.getSessionInfo(active) else null
  for(session in installer.mySessions)if(session.sessionId!=active)try {installer.abandonSession(session.sessionId)} catch(_:Exception) {}
  if(activeInfo!=null && isCommitted(activeInfo))state=AndroidUpdateState("installing",availableVersion=prefs.getString(KEY_VERSION,null))
  else {
   if(activeInfo!=null)try {installer.abandonSession(active)} catch(_:Exception) {}
   prefs.edit().remove(KEY_SESSION).remove(KEY_TOKEN).remove(KEY_VERSION).commit()
  }
 }

 private fun isCommitted(info:PackageInstaller.SessionInfo)=if(Build.VERSION.SDK_INT>=29)info.isCommitted else @Suppress("DEPRECATION") info.isSealed

 companion object {
  private const val CONNECT_TIMEOUT_MS=15_000
  private const val READ_TIMEOUT_MS=30_000
  private val REDIRECTS=setOf(301,302,303,307,308)
  private const val KEY_SESSION="installerSession"
  private const val KEY_TOKEN="installerToken"
  private const val KEY_VERSION="installerVersion"
  const val ACTION_INSTALL_STATUS="com.multidevicecontext.mobile.UPDATE_INSTALL_STATUS"
  @Volatile private var singleton:AndroidUpdateManager?=null
  fun get(context:Context)=singleton ?: synchronized(this) {singleton ?: AndroidUpdateManager(context.applicationContext,true).also {singleton=it}}
  fun forInstallCallback(context:Context)=singleton ?: synchronized(this) {singleton ?: AndroidUpdateManager(context.applicationContext,false).also {singleton=it}}
 }
}

private object OutputStreamSink:java.io.OutputStream() {override fun write(value:Int){};override fun write(bytes:ByteArray,offset:Int,length:Int){}}

class UpdateInstallReceiver:BroadcastReceiver() {
 override fun onReceive(context:Context,intent:Intent) {
  val pending=goAsync();val manager=AndroidUpdateManager.forInstallCallback(context);manager.execute {try {manager.handleInstallStatus(intent)} finally {pending.finish()}}
 }
}
