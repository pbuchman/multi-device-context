package com.multidevicecontext.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.io.File

class AcceptanceUpdateReceiver:BroadcastReceiver() {
 override fun onReceive(context:Context,intent:Intent) {
  if(!BuildConfig.MDC_UPDATE_ACCEPTANCE || intent.action!=ACTION)return
  val operation=intent.getStringExtra("operation") ?: return
  val token=intent.getStringExtra("token") ?: return
  if(operation !in OPERATIONS || !token.matches(Regex("[A-Za-z0-9_-]{1,64}")))return
  val pending=goAsync();val manager=AndroidUpdateManager.get(context)
  manager.execute {
   val response=JSONObject().put("token",token).put("operation",operation)
   try {
    val state=when(operation) {
     "state" -> manager.getState()
     "check" -> manager.check()
     "download" -> manager.startUpdate()
     "permissionDenied" -> {manager.permissionDenied();manager.getState()}
     "install" -> {require(context.packageManager.canRequestPackageInstalls()) {"Unknown-source permission is required"};manager.install()}
     else -> error("Unsupported acceptance operation")
    }
    response.put("ok",true).put("state",state)
   } catch(cause:Exception) {
    response.put("ok",false).put("error",cause.message ?: cause.javaClass.simpleName).put("state",manager.getState())
   } finally {
    val directory=File(context.filesDir,"android-update-acceptance").apply {mkdirs()}
    File(directory,"$token.json").writeText(response.toString());pending.finish()
   }
  }
 }
 companion object {
  const val ACTION="com.multidevicecontext.mobile.ACCEPTANCE_UPDATE"
  private val OPERATIONS=setOf("state","check","download","permissionDenied","install")
 }
}
