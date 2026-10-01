package com.multidevicecontext.mobile

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import android.widget.Toast
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

@CapacitorPlugin(name="MdcNative")
class MdcNativePlugin:Plugin() {
 private val worker=NativeRuntime.worker
 private lateinit var inbox:ShareInbox
 private lateinit var clipboardFiles:ShareInbox
 private lateinit var exports:ExportStore
 private lateinit var auth:NativeAuth
 private val prefs by lazy { context.getSharedPreferences("mdc-native",Context.MODE_PRIVATE) }
 private val saves=mutableMapOf<String,ExportedFile>()
 override fun load() {
  NativeRuntime.attach(activity);inbox=NativeRuntime.inbox;clipboardFiles=NativeRuntime.clipboard
  exports=NativeRuntime.exports;auth=NativeRuntime.auth
  receive(activity.intent)
 }
 private fun background(call:PluginCall,block:()->Unit) { worker.execute { try { block() } catch(_:Exception) { call.reject("Native operation failed or exceeds limits") } } }
 @PluginMethod fun getDevice(call:PluginCall) {
  val id=prefs.getString("deviceId",null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("deviceId",it).commit() }
  call.resolve(JSObject().put("id",id).put("name","${Build.MANUFACTURER} ${Build.MODEL}".take(80)))
 }
 @PluginMethod fun getAccessToken(call:PluginCall) { auth.token(call) }
 @PluginMethod fun signOut(call:PluginCall) { activity.runOnUiThread {
  auth.signOut()
  background(call) { inbox.clear();clipboardFiles.clear();exports.clearStaging();exports.cleanup();call.resolve() }
 } }
 @PluginMethod fun copyText(call:PluginCall) { activity.runOnUiThread {
  val text=call.getString("text")
  if(text==null || text.toByteArray().size>NativePolicy.MAX_TEXT) {call.reject("Invalid text");return@runOnUiThread}
  (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Multi Device Context",text));call.resolve()
 } }
 @PluginMethod fun readClipboard(call:PluginCall) { activity.runOnUiThread {
  val clip=(context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
  if(clip==null) {call.resolve(JSObject().put("files",JSArray()));return@runOnUiThread}
  val texts=mutableListOf<String>();val uris=mutableListOf<Uri>()
  for(i in 0 until clip.itemCount) { val item=clip.getItemAt(i);item.text?.let {texts.add(it.toString())};item.uri?.let {uris.add(it)} }
  background(call) {
   val text=texts.joinToString("\n").ifBlank { null }
   if(text==null && uris.isEmpty()) {call.resolve(JSObject().put("files",JSArray()));return@background}
   clipboardFiles.clear()
   val id=UUID.randomUUID().toString();clipboardFiles.capture(id,text,uris.map {incoming(it)})
   val data=clipboardFiles.pending().getJSONObject(0)
   call.resolve(JSObject(data.toString()))
  }
 } }
 @PluginMethod fun beginFile(call:PluginCall) = background(call) {
  val id=exports.begin(requireNotNull(call.getString("name")),requireNotNull(call.getString("contentType")))
  call.resolve(JSObject().put("id",id))
 }
 @PluginMethod fun appendFile(call:PluginCall) = background(call) {
  val encoded=requireNotNull(call.getString("base64"));require(encoded.length<=349528)
  exports.append(requireNotNull(call.getString("id")),Base64.decode(encoded,Base64.NO_WRAP));call.resolve()
 }
 @PluginMethod fun discardFile(call:PluginCall) = background(call) { exports.discard(requireNotNull(call.getString("id")));call.resolve() }
 @PluginMethod fun finishFile(call:PluginCall) = background(call) {
  val action=call.getString("action");require(action in listOf("copy","save","share"))
  val file=exports.finish(requireNotNull(call.getString("id")))
  val uri=FileProvider.getUriForFile(context,"${context.packageName}.fileprovider",file.file,file.displayName)
  activity.runOnUiThread { try {
   when(action) {
    "copy" -> { (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newUri(context.contentResolver,file.displayName,uri));call.resolve(JSObject().put("saved",true)) }
    "share" -> {
     val intent=Intent(Intent.ACTION_SEND).setType(file.contentType).putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
     intent.clipData=ClipData.newUri(context.contentResolver,file.displayName,uri)
     activity.startActivity(Intent.createChooser(intent,"Share file"));call.resolve(JSObject().put("saved",true))
    }
    "save" -> { saves[call.callbackId]=file
     val intent=Intent(Intent.ACTION_CREATE_DOCUMENT).setType(file.contentType).addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE,file.displayName)
     startActivityForResult(call,intent,"savedDocument")
    }
   }
  } catch(_:Exception) {call.reject("No application available for this action")} }
 }
 @ActivityCallback private fun savedDocument(call:PluginCall?,result:ActivityResult) {
  if(call==null)return
  val file=saves.remove(call.callbackId)
  val uri=result.data?.data
  if(result.resultCode!=Activity.RESULT_OK || uri==null || file==null) {call.resolve(JSObject().put("saved",false));return}
  background(call) { context.contentResolver.openOutputStream(uri,"wt").use { output -> requireNotNull(output);file.file.inputStream().use { it.copyTo(output,NativePolicy.MAX_CHUNK) } };call.resolve(JSObject().put("saved",true)) }
 }
 @PluginMethod fun getPendingShares(call:PluginCall) = background(call) {
  val pending=inbox.pending()
  if(inbox.consumeRejections()>0) activity.runOnUiThread {Toast.makeText(context,"An invalid saved share was skipped",Toast.LENGTH_LONG).show()}
  call.resolve(JSObject().put("requests",JSArray(pending.toString())))
 }
 @PluginMethod fun acknowledgeShare(call:PluginCall) = background(call) {inbox.acknowledge(requireNotNull(call.getString("id")));call.resolve()}
 @PluginMethod fun takeNavigation(call:PluginCall) {
  val result=JSObject();prefs.getString("navigation",null)?.let {result.put("contextId",it);prefs.edit().remove("navigation").commit()};call.resolve(result)
 }
 override fun handleOnNewIntent(intent:Intent) { receive(intent) }
 private fun receive(intent:Intent?) {
  if(intent==null)return
  if(intent.action==Intent.ACTION_VIEW) {
   NativePolicy.contextId(intent.dataString)?.let { id ->
    val intentId=intent.getStringExtra(MainActivity.SHARE_ID)
    if(intentId!=prefs.getString("navigationIntent",null)) {
     prefs.edit().putString("navigation",id).putString("navigationIntent",intentId).commit()
     notifyListeners("navigate",JSObject().put("contextId",id))
    }
   }
   return
  }
  if(intent.action!=Intent.ACTION_SEND && intent.action!=Intent.ACTION_SEND_MULTIPLE)return
  val id=intent.getStringExtra(MainActivity.SHARE_ID) ?: return
  val text=intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
  val uris=mutableListOf<Uri>()
  if(intent.action==Intent.ACTION_SEND) (intent.getParcelableExtra<android.os.Parcelable>(Intent.EXTRA_STREAM) as? Uri)?.let {uris.add(it)}
  else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let {uris.addAll(it)}
  intent.clipData?.let {clip -> for(i in 0 until clip.itemCount)clip.getItemAt(i).uri?.let {if(!uris.contains(it))uris.add(it)} }
  worker.execute { try {
   inbox.capture(id,text,uris.map {incoming(it)})
   notifyListeners("shareReceived",JSObject())
  } catch(_:Exception) {activity.runOnUiThread {Toast.makeText(context,"Share could not be imported (empty, unavailable, or too large)",Toast.LENGTH_LONG).show()} } }
 }
 private fun incoming(uri:Uri):IncomingFile {
  require(uri.scheme=="content") { "Only content grants accepted" }
  var name="attachment"
  context.contentResolver.query(uri,arrayOf(OpenableColumns.DISPLAY_NAME),null,null,null)?.use {cursor -> if(cursor.moveToFirst())name=cursor.getString(0) ?: name }
  val type=context.contentResolver.getType(uri) ?: "application/octet-stream"
  return IncomingFile(name,type) {requireNotNull(context.contentResolver.openInputStream(uri)) {"Share grant unavailable"}}
 }

}
