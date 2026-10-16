package com.multidevicecontext.mobile

/** Debug-only isolated child used by the emulator's actual Binder death test. */
class DictationLeaseProbeService:android.app.Service() {
 private val endpoint=object:android.os.Binder() {
  override fun onTransact(code:Int,data:android.os.Parcel,reply:android.os.Parcel?,flags:Int):Boolean {
   if(code!=android.os.IBinder.FIRST_CALL_TRANSACTION)return false
   android.os.Process.killProcess(android.os.Process.myPid());return true
  }
 }
 override fun onBind(intent:android.content.Intent?)=endpoint
}
