package com.multidevicecontext.mobile
import android.app.Activity
import java.io.File
import java.util.concurrent.Executors
/** Process-wide owner prevents recreation from deleting an in-flight copy or racing credential rotation. */
object NativeRuntime {
 val worker=Executors.newSingleThreadExecutor()
 lateinit var inbox:ShareInbox;private set
 lateinit var clipboard:ShareInbox;private set
 lateinit var exports:ExportStore;private set
 lateinit var installation:NativeInstallation;private set
 lateinit var auth:NativeAuth;private set
 @Synchronized fun attach(activity:Activity) {
  if(!::inbox.isInitialized) {
   inbox=ShareInbox(File(activity.filesDir,"inbox"));clipboard=ShareInbox(File(activity.filesDir,"clipboard"))
   installation=NativeInstallation(activity.applicationContext)
   exports=ExportStore(File(activity.filesDir,"transfers"));auth=NativeAuth(activity)
  } else auth.attach(activity)
 }
}
