package com.multidevicecontext.mobile
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.inputmethod.InputMethodManager
import com.getcapacitor.BridgeActivity
import java.util.UUID
class MainActivity:BridgeActivity() {
 companion object {
  const val SHARE_ID="mdc.internal.shareId"
  const val PREPARE_DICTATION="com.multidevicecontext.mobile.PREPARE_DICTATION"
 }
 private val dictationIme=DictationImeRequest(SystemClock::elapsedRealtime)
 override fun onCreate(savedInstanceState:Bundle?) {
  intent.putExtra(SHARE_ID,savedInstanceState?.getString(SHARE_ID) ?: UUID.randomUUID().toString())
  registerPlugin(MdcNativePlugin::class.java);super.onCreate(savedInstanceState)
  // Cold launch never guesses an editor or schedules an IME request.
 }
 override fun onSaveInstanceState(outState:Bundle) {outState.putString(SHARE_ID,intent.getStringExtra(SHARE_ID));super.onSaveInstanceState(outState)}
 override fun onNewIntent(intent:Intent) {
  dictationIme.cancel()
  intent.putExtra(SHARE_ID,UUID.randomUUID().toString());setIntent(intent);super.onNewIntent(intent)
  if(intent.action!=PREPARE_DICTATION) return
  val view=bridge?.webView ?: return
  val token=dictationIme.request()
  tryShowDictationIme(token)
  view.post {tryShowDictationIme(token)}
  view.postDelayed({dictationIme.cancel(token)},DictationImeRequest.TIMEOUT_MS)
 }
 private fun tryShowDictationIme(token:Long) {
  val view=bridge?.webView ?: return
  dictationIme.attempt(token,currentFocus===view && view.hasFocus() && view.hasWindowFocus()) {
   try {(getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(view,InputMethodManager.SHOW_IMPLICIT)}
   catch(_:RuntimeException) { /* Declined platform request is not retried or queued. */ }
  }
 }
 override fun onWindowFocusChanged(hasFocus:Boolean) {
  super.onWindowFocusChanged(hasFocus)
  if(hasFocus) dictationIme.pendingToken?.let {tryShowDictationIme(it)}
 }
 override fun onPause() {dictationIme.cancel();super.onPause()}
 override fun onDestroy() {dictationIme.cancel();super.onDestroy()}
}
