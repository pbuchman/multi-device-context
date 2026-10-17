package com.multidevicecontext.mobile

import android.os.Build
import android.os.Looper
import android.view.View
import android.view.WindowInsets
import java.lang.ref.WeakReference
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/** Reads current platform state on the view thread. Unknown/late/detached fails closed. */
class DictationFieldGuard(view:View,private val currentGeneration:()->Boolean={true}) {
 private val view=WeakReference(view)
 fun valid():Boolean {
  val current=view.get() ?: return false
  val read={
   if(!currentGeneration() || Build.VERSION.SDK_INT<33 || !current.isAttachedToWindow || !current.hasFocus() || !current.hasWindowFocus()) false
   else current.rootWindowInsets?.let {!it.isVisible(WindowInsets.Type.ime())} ?: false
  }
  if(Looper.myLooper()==Looper.getMainLooper()) return read()
  val task=FutureTask(read)
  val handler=current.handler ?: return false
  if(!handler.post(task)) return false
  return try {task.get(500,TimeUnit.MILLISECONDS)} catch(_:Exception) {task.cancel(false);false}
 }
}
