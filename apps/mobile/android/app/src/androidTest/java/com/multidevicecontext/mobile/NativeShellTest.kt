package com.multidevicecontext.mobile
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
@RunWith(AndroidJUnit4::class)
class NativeShellTest {
 @Test fun launchesAndRetainsShareAcrossRecreation() {
  val context=ApplicationProvider.getApplicationContext<android.content.Context>()
  val intent=Intent(context,MainActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT,"instrumented share")
  ActivityScenario.launch<MainActivity>(intent).use { scenario ->
   Thread.sleep(1500)
   val inbox=ShareInbox(java.io.File(context.filesDir,"inbox"));val before=inbox.pending().length()
   assertTrue(before>0);scenario.recreate();Thread.sleep(1000);assertEquals(before,inbox.pending().length())
   scenario.onActivity { assertNotNull(it.bridge.webView) }
  }
 }
}
