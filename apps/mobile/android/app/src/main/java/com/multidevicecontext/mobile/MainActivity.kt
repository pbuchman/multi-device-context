package com.multidevicecontext.mobile
import android.content.Intent
import android.os.Bundle
import com.getcapacitor.BridgeActivity
import java.util.UUID
class MainActivity:BridgeActivity() {
 companion object {const val SHARE_ID="mdc.internal.shareId"}
 override fun onCreate(savedInstanceState:Bundle?) {
  intent.putExtra(SHARE_ID,savedInstanceState?.getString(SHARE_ID) ?: UUID.randomUUID().toString())
  registerPlugin(MdcNativePlugin::class.java);super.onCreate(savedInstanceState)
 }
 override fun onSaveInstanceState(outState:Bundle) {outState.putString(SHARE_ID,intent.getStringExtra(SHARE_ID));super.onSaveInstanceState(outState)}
 override fun onNewIntent(intent:Intent) {intent.putExtra(SHARE_ID,UUID.randomUUID().toString());setIntent(intent);super.onNewIntent(intent)}
}
