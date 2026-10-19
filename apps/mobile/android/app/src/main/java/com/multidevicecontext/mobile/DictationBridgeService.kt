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
enum class DictationCancelReason {
 EXPLICIT, LEASE_DIED, EXPIRED, RECORDING_PHASE, FINISHING_PHASE, COMPLETE_WITHOUT_INPUT,
 ADAPTER_CANCEL, ACCESSIBILITY_UNEXPECTED, ACCESSIBILITY_REJECTED, AUTHORIZE_EXPIRED,
 INPUT_COMMIT, INPUT_COMMIT_ATTRIBUTES, INPUT_COMPOSITION, INPUT_DELETE, INPUT_KEY,
 INPUT_CONTEXT_MENU, INPUT_SELECTION, NATIVE_KEY, NATIVE_TOUCH, PROVISIONAL_REJECTED,
 PROVISIONAL_FIELD_CHANGED, PLUGIN_DESTROYED, TRANSFERS_INVALIDATED, SIGN_OUT,
 RENDERER_CANCELLED, RENDERER_REVOKED, RENDERER_KEY, RENDERER_POINTER, RENDERER_PASTE,
 RENDERER_DROP, RENDERER_COMPOSITION, RENDERER_ELIGIBILITY, RENDERER_READ,
 RENDERER_CHAT, RENDERER_FOCUS, RENDERER_CODE, RENDERER_TIMEOUT, RENDERER_CHANGE_PHASE,
 RENDERER_SECOND_CHANGE, RENDERER_INSERTION, RENDERER_SELECTION, RENDERER_FAILURE, RENDERER_DISPOSED
}
open class DictationState(private val monotonicNow:(Long)->Long={it}) {
 private var current:JSONObject?=null
 private var uid=-1
 private var deadline=0L
 private var lease:DictationLease?=null
 private var provisionalGuard:(()->Boolean)?=null
 private var provisionalCurrent:(()->Boolean)?=null
 private data class GuardRead(val guard:()->Boolean,val valid:Boolean)
 /** Native UI reads may wait for the main thread. Never perform them while holding state. */
 private fun readProvisionalGuard():GuardRead? {
  val guard=synchronized(this) {if(current?.optString("phase") in listOf("processing","complete")) provisionalGuard else null} ?: return null
  return GuardRead(guard,guard())
 }
 private val observers=mutableMapOf<String,(String)->Unit>()
 @Synchronized fun attach(owner:String,listener:(String)->Unit) {observers[owner]=listener}
 @Synchronized fun detach(owner:String) {observers.remove(owner)}
 fun command(id:String,op:String,caller:Int,now:Long,newLease:DictationLease?=null):JSONObject {
  val proof=if(op=="completed") readProvisionalGuard() else null
  val observedNow=monotonicNow(now)
  synchronized(this) {
  if(lease?.alive()==false) cancel(DictationCancelReason.LEASE_DIED,observedNow)
  if(current?.optString("phase") !in listOf(null,"queued","synced","cancelled") && observedNow>=deadline) cancel(DictationCancelReason.EXPIRED,observedNow)
  if(op=="begin") {
   if(current?.optString("id")==id) return if(uid==caller && newLease!=null && lease?.same(newLease)==true) snapshot() else JSONObject().put("phase","cancelled")
   if(current!=null && current?.optString("phase") !in listOf("queued","synced","cancelled")) return JSONObject().put("phase","busy")
   requireNotNull(newLease) {"A live caller lease is required"}
   lease?.release();lease=newLease
   current=JSONObject().put("id",id).put("phase","begin");uid=caller;deadline=observedNow+8000;provisionalGuard=null;provisionalCurrent=null
   newLease.watch {synchronized(this) {if(lease===newLease) cancel(DictationCancelReason.LEASE_DIED)}}
   if(!newLease.alive()) cancel(DictationCancelReason.LEASE_DIED,observedNow)
  } else {
   if(uid!=caller || current?.optString("id")!=id) return JSONObject().put("phase","cancelled")
   val phase=current!!.getString("phase")
   when(op) {
    "status" -> Unit
    "recording" -> if(phase=="prepared") {current!!.put("phase","recording");deadline=Long.MAX_VALUE} else if(phase!="recording") cancel(DictationCancelReason.RECORDING_PHASE,observedNow)
    "finishing" -> if(phase=="recording") {current!!.put("phase","processing");deadline=observedNow+60_000} else if(phase!="processing") cancel(DictationCancelReason.FINISHING_PHASE,observedNow)
    "completed" -> if(phase=="processing" && (current!!.optBoolean("inserted") || provisionalReady(proof))) current!!.put("phase","complete") else if(phase !in listOf("complete","queued","synced")) cancel(DictationCancelReason.COMPLETE_WITHOUT_INPUT,observedNow)
    "cancel" -> cancel(DictationCancelReason.ADAPTER_CANCEL,observedNow)
    else -> throw IllegalArgumentException("Unsupported dictation operation")
   }
  }
  return snapshot()
  }
 }
 @Synchronized fun snapshot():JSONObject {if(lease?.alive()==false) cancel(DictationCancelReason.LEASE_DIED);return JSONObject(current?.toString() ?: "{\"phase\":\"none\"}")}
 /** Not an origin assertion. Only the approved adapter's later full completion can admit this candidate. */
 private fun provisionalEligible(eligible:Boolean,now:Long,currentGeneration:()->Boolean):Boolean =
  current?.optString("phase")=="processing" && lease?.alive()==true && now<deadline && eligible && currentGeneration() && !current!!.optBoolean("inserted")
   && !current!!.optBoolean("provisionalPending") && !current!!.optBoolean("provisionalInput")
 /** Android's accessibility commit clears composition inside its batch before supplying text. No input witness is granted here. */
 @Synchronized fun compositionCleanupAllowed(eligible:Boolean,now:Long,currentGeneration:()->Boolean):Boolean = provisionalEligible(eligible,now,currentGeneration)
 @Synchronized fun provisionalOwner(eligible:Boolean,now:Long,currentGeneration:()->Boolean={true},guard:()->Boolean):String? {
  if(provisionalEligible(eligible,now,currentGeneration)) {
   current!!.put("provisionalPending",true).put("inputPath","CORRELATED_ATTRIBUTES_COMMIT")
   provisionalGuard=guard;provisionalCurrent=currentGeneration;return current!!.getString("id")
  }
  cancel(DictationCancelReason.INPUT_COMMIT_ATTRIBUTES,now);return null
 }
 @Synchronized fun provisionalCommitted(owner:String,accepted:Boolean,eligible:Boolean,now:Long) {
  if(owner!=current?.optString("id") || current?.optString("phase")!="processing" || !current!!.optBoolean("provisionalPending")) return
  if(!accepted) {cancel(DictationCancelReason.PROVISIONAL_REJECTED,now);return}
  if(!eligible || provisionalCurrent?.invoke()!=true || now>=deadline || lease?.alive()!=true) {cancel(DictationCancelReason.PROVISIONAL_FIELD_CHANGED,now);return}
  current!!.put("provisionalPending",false).put("provisionalInput",true)
 }
 private fun provisionalReady(proof:GuardRead?):Boolean = current?.optBoolean("provisionalInput")==true && current?.optBoolean("provisionalPending")!=true && proof?.guard===provisionalGuard && proof?.valid==true && provisionalCurrent?.invoke()==true
 /** Replacement revokes only authority tied to the previous connection; ordinary editing continues. */
 @Synchronized fun inputConnectionChanged(now:Long) {
  if(current?.optString("phase") in listOf("processing","complete") && (current?.optBoolean("provisionalPending")==true || current?.optBoolean("provisionalInput")==true)) cancel(DictationCancelReason.PROVISIONAL_FIELD_CHANGED,now)
 }
 @Synchronized fun insertionOwner():String? {
  if(current?.optString("phase")=="processing" && current?.optBoolean("inserted")==false && !current!!.optBoolean("provisionalPending") && !current!!.optBoolean("provisionalInput")) return current!!.getString("id")
  if(current?.optString("phase") in listOf("prepared","recording","processing","complete")) cancel(DictationCancelReason.ACCESSIBILITY_UNEXPECTED)
  return null
 }
 @Synchronized fun inserted(owner:String?,accepted:Boolean) {
  if(owner==null || owner!=current?.optString("id") || current?.optString("phase")!="processing") return
  if(accepted) current!!.put("inserted",true).put("inputPath","ACCESSIBILITY_ACTION") else cancel(DictationCancelReason.ACCESSIBILITY_REJECTED)
 }
 fun authorize(id:String,chat:String,revision:Int,item:String,now:Long):Boolean {
  val proof=readProvisionalGuard()
  val observedNow=monotonicNow(now)
  synchronized(this) {
  if(current?.optString("id")!=id || current?.optString("phase")!="complete" || current?.optString("contextId")!=chat || current?.optInt("revision")!=revision) return false
  if(lease?.alive()!=true || observedNow>=deadline) {cancel(DictationCancelReason.AUTHORIZE_EXPIRED,observedNow);return false}
  if(current?.optBoolean("provisionalInput")==true && !provisionalReady(proof)) {cancel(DictationCancelReason.PROVISIONAL_FIELD_CHANGED,observedNow);return false}
  val claimed=current?.optString("claimedItem")
  if(!claimed.isNullOrEmpty() && claimed!=item) return false
  require(UUID.fromString(item).toString()==item)
  current!!.put("claimedItem",item);return true
  }
 }
 /** Fresh renderer event-chain confirmation grants no completion or queue authority. */
 fun confirmProvisional(id:String,chat:String,revision:Int,now:Long):Boolean {
  val proof=readProvisionalGuard();val observedNow=monotonicNow(now)
  synchronized(this) {
   if(current?.optString("id")!=id || current?.optString("phase") !in listOf("processing","complete") || current?.optString("contextId")!=chat || current?.optInt("revision")!=revision) return false
   if(lease?.alive()!=true || observedNow>=deadline) {cancel(DictationCancelReason.AUTHORIZE_EXPIRED,observedNow);return false}
   if(!provisionalReady(proof)) {cancel(DictationCancelReason.PROVISIONAL_FIELD_CHANGED,observedNow);return false}
   return true
  }
 }
 @Synchronized fun report(id:String,phase:String,chat:String?,revision:Int?,item:String?,reason:String?=null,now:Long=0) {
  if(lease?.alive()==false) {cancel(DictationCancelReason.LEASE_DIED,now);return}
  if(current?.optString("id")!=id) return
  val before=current!!.getString("phase")
  when {
   phase=="cancelled" -> cancel(try {DictationCancelReason.valueOf(reason?.takeIf {it.startsWith("RENDERER_")} ?: "RENDERER_CANCELLED")} catch(_:IllegalArgumentException) {DictationCancelReason.RENDERER_CANCELLED},now)
   phase=="prepared" && before=="begin" && chat!=null && revision!=null -> current!!.put("phase",phase).put("contextId",chat).put("revision",revision)
   phase=="queued" && before=="complete" && chat==current!!.optString("contextId") && item!=null && item==current!!.optString("claimedItem") && lease?.alive()==true -> current!!.put("phase",phase).put("itemId",item)
   phase=="synced" && before=="queued" && item==current!!.optString("itemId") && chat==current!!.optString("contextId") -> current!!.put("phase",phase)
  }
 }
 @Synchronized fun cancel(reason:DictationCancelReason=DictationCancelReason.EXPLICIT,now:Long=0) {
  if(current==null || current?.optString("phase")=="cancelled") return
  val id=current!!.getString("id");current!!.put("cancelReason",reason.name).put("cancelledAtElapsedMs",now)
   .put("cancelPhase",current!!.getString("phase")).put("phase","cancelled");lease?.release();provisionalGuard=null;provisionalCurrent=null
  for(listener in observers.values.toList()) try {listener(id)} catch(_:RuntimeException) { /* A destroyed renderer cannot retain authority. */ }
 }
}
object DictationRuntime:DictationState({requested->maxOf(requested,SystemClock.elapsedRealtime())})
