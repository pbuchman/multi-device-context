package com.multidevicecontext.mobile

import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Binder
import android.os.IBinder
import android.os.Parcel
import android.os.SystemClock
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID

/** No extras/text/chat supplied by the caller can reach the renderer. */
class DictationBridgeService: Service() {
 companion object {
  const val DESCRIPTOR="com.multidevicecontext.mobile.IDictationBridge.v1"
  const val ADAPTER="com.pbuchman.wisprsteering"
  // Existing code10 signing certificate, verified from its frozen APK.
  const val CERT="a3828430c276645d823cd2afb7a2835a1e3b39ce02d0fc4a49b7c119a5c37bab"
 }
 private fun trusted(uid:Int):Boolean {
  val names=packageManager.getPackagesForUid(uid) ?: return false
  if(names.size!=1 || names.single()!=ADAPTER) return false
  @Suppress("DEPRECATION")
  val certs=if(android.os.Build.VERSION.SDK_INT>=28) packageManager.getPackageInfo(ADAPTER,PackageManager.GET_SIGNING_CERTIFICATES).signingInfo?.apkContentsSigners
   else packageManager.getPackageInfo(ADAPTER,PackageManager.GET_SIGNATURES).signatures
  val digests=certs?.map { signature -> MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") {"%02x".format(it)} } ?: emptyList()
  return DictationTrust.approved(names,digests)
 }
 private val endpoint=object:Binder() {
  override fun onTransact(code:Int,data:Parcel,reply:Parcel?,flags:Int):Boolean {
   // Check the actual transaction caller, never bind-time identity or extras.
   if(!trusted(Binder.getCallingUid())) throw SecurityException("Unapproved dictation caller")
   if(code==IBinder.INTERFACE_TRANSACTION) {reply?.writeString(DESCRIPTOR);return true}
   if(code!=IBinder.FIRST_CALL_TRANSACTION) return super.onTransact(code,data,reply,flags)
   data.enforceInterface(DESCRIPTOR)
   val id=requireNotNull(data.readString());val operation=requireNotNull(data.readString())
   val lease=if(operation=="begin") BinderDictationLease(requireNotNull(data.readStrongBinder())) else null
   require(data.dataAvail()==0 && UUID.fromString(id).toString()==id)
   val result=DictationRuntime.command(id,operation,Binder.getCallingUid(),SystemClock.elapsedRealtime(),lease)
   reply?.writeNoException();reply?.writeString(result.toString());return true
  }
 }
 override fun onBind(intent:Intent?):IBinder=endpoint
}

/** Single process ownership; ordinary durable outbox is intentionally separate. */
object DictationTrust {
 fun approved(packages:Array<String>?,digests:List<String>):Boolean = packages?.toList()==listOf(DictationBridgeService.ADAPTER) && digests==listOf(DictationBridgeService.CERT)
}
interface DictationLease {
 fun alive():Boolean
 fun watch(death:()->Unit)
 fun release()
 fun same(other:DictationLease):Boolean=this===other
}
class BinderDictationLease(private val token:IBinder):DictationLease {
 override fun same(other:DictationLease)=other is BinderDictationLease && other.token==token
 private var recipient:IBinder.DeathRecipient?=null
 override fun alive()=token.isBinderAlive
 override fun watch(death:()->Unit) {
  val callback=IBinder.DeathRecipient {death()};recipient=callback
  try {token.linkToDeath(callback,0);if(!alive()) death()} catch(_:android.os.RemoteException) {death()}
 }
 override fun release() {recipient?.let {try {token.unlinkToDeath(it,0)} catch(_:NoSuchElementException) {}};recipient=null}
}
open class DictationState {
 private var current:JSONObject?=null
 private var uid=-1
 private var deadline=0L
 private var lease:DictationLease?=null
 private val observers=mutableMapOf<String,(String)->Unit>()
 @Synchronized fun attach(owner:String,listener:(String)->Unit) {observers[owner]=listener}
 @Synchronized fun detach(owner:String) {observers.remove(owner)}
 @Synchronized fun command(id:String,op:String,caller:Int,now:Long,newLease:DictationLease?=null):JSONObject {
  if(lease?.alive()==false) cancel()
  if(current?.optString("phase") !in listOf(null,"queued","synced","cancelled") && now>=deadline) cancel()
  if(op=="begin") {
   if(current?.optString("id")==id) return if(uid==caller && newLease!=null && lease?.same(newLease)==true) snapshot() else JSONObject().put("phase","cancelled")
   if(current!=null && current?.optString("phase") !in listOf("queued","synced","cancelled")) return JSONObject().put("phase","busy")
   requireNotNull(newLease) {"A live caller lease is required"}
   lease?.release();lease=newLease
   current=JSONObject().put("id",id).put("phase","begin");uid=caller;deadline=now+8000
   newLease.watch {synchronized(this) {if(lease===newLease) cancel()}}
   if(!newLease.alive()) cancel()
  } else {
   if(uid!=caller || current?.optString("id")!=id) return JSONObject().put("phase","cancelled")
   val phase=current!!.getString("phase")
   when(op) {
    "status" -> Unit
    "recording" -> if(phase=="prepared") {current!!.put("phase","recording");deadline=Long.MAX_VALUE} else if(phase!="recording") cancel()
    "finishing" -> if(phase=="recording") {current!!.put("phase","processing");deadline=now+60_000} else if(phase!="processing") cancel()
    "completed" -> if(phase=="processing" && current!!.optBoolean("inserted")) current!!.put("phase","complete") else if(phase !in listOf("complete","queued","synced")) cancel()
    "cancel" -> cancel()
    else -> throw IllegalArgumentException("Unsupported dictation operation")
   }
  }
  return snapshot()
 }
 @Synchronized fun snapshot():JSONObject {if(lease?.alive()==false) cancel();return JSONObject(current?.toString() ?: "{\"phase\":\"none\"}")}
 @Synchronized fun insertionOwner():String? {
  if(current?.optString("phase")=="processing" && current?.optBoolean("inserted")==false) return current!!.getString("id")
  if(current?.optString("phase") in listOf("prepared","recording","processing","complete")) cancel()
  return null
 }
 @Synchronized fun inserted(owner:String?,accepted:Boolean) {
  if(owner==null || owner!=current?.optString("id") || current?.optString("phase")!="processing") return
  if(accepted) current!!.put("inserted",true) else cancel()
 }
 @Synchronized fun authorize(id:String,chat:String,revision:Int,item:String,now:Long):Boolean {
  if(lease?.alive()!=true || now>=deadline) {cancel();return false}
  if(current?.optString("id")!=id || current?.optString("phase")!="complete" || current?.optString("contextId")!=chat || current?.optInt("revision")!=revision) return false
  val claimed=current?.optString("claimedItem")
  if(!claimed.isNullOrEmpty() && claimed!=item) return false
  require(UUID.fromString(item).toString()==item)
  current!!.put("claimedItem",item);return true
 }
 @Synchronized fun report(id:String,phase:String,chat:String?,revision:Int?,item:String?) {
  if(lease?.alive()==false) {cancel();return}
  if(current?.optString("id")!=id) return
  val before=current!!.getString("phase")
  when {
   phase=="cancelled" -> cancel()
   phase=="prepared" && before=="begin" && chat!=null && revision!=null -> current!!.put("phase",phase).put("contextId",chat).put("revision",revision)
   phase=="queued" && before=="complete" && chat==current!!.optString("contextId") && item!=null && item==current!!.optString("claimedItem") && lease?.alive()==true -> current!!.put("phase",phase).put("itemId",item)
   phase=="synced" && before=="queued" && item==current!!.optString("itemId") && chat==current!!.optString("contextId") -> current!!.put("phase",phase)
  }
 }
 @Synchronized fun cancel() {
  if(current==null || current?.optString("phase")=="cancelled") return
  val id=current!!.getString("id");current!!.put("phase","cancelled");lease?.release()
  for(listener in observers.values.toList()) try {listener(id)} catch(_:RuntimeException) { /* A destroyed renderer cannot retain authority. */ }
 }
}
object DictationRuntime:DictationState()
