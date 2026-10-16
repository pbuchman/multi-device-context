package com.multidevicecontext.mobile

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.IBinder
import android.os.Parcel
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.EditorInfo
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Real Chromium virtual accessibility provider and real InputConnection on emulator. */
@RunWith(AndroidJUnit4::class)
class DictationWebViewTest {
 private val instrumentation get()=InstrumentationRegistry.getInstrumentation()
 private fun prepared():String {
  val id=UUID.randomUUID().toString();val now=SystemClock.elapsedRealtime()
  DictationRuntime.cancel();DictationRuntime.command(id,"begin",101,now,object:DictationLease {override fun alive()=true;override fun watch(death:()->Unit) {};override fun release() {}})
  DictationRuntime.report(id,"prepared",UUID.randomUUID().toString(),1,null)
  DictationRuntime.command(id,"recording",101,now);DictationRuntime.command(id,"finishing",101,now)
  return id
 }
 private fun fixture(block:(MainActivity,DictationWebView)->Unit) {
  ActivityScenario.launch(MainActivity::class.java).use { scenario ->
   val loaded=CountDownLatch(1);val activity=AtomicReference<MainActivity>();val view=AtomicReference<DictationWebView>()
   scenario.onActivity { current ->
    activity.set(current);val web=current.bridge.webView as DictationWebView;view.set(web)
    web.webViewClient=object:WebViewClient() {override fun onPageFinished(v:WebView,url:String) {v.evaluateJavascript("document.getElementById('draft').focus();document.getElementById('draft').setSelectionRange(5,5)") {loaded.countDown()}}}
    web.loadDataWithBaseURL("https://localhost", "<html><body><textarea id='draft' aria-label='Native dictation fixture'>prior</textarea></body></html>","text/html","UTF-8",null)
   }
   assertTrue("fixture loaded",loaded.await(10,TimeUnit.SECONDS));instrumentation.waitForIdleSync()
   block(activity.get(),view.get())
  }
 }
 private fun editor():AccessibilityNodeInfo {
  fun search(node:AccessibilityNodeInfo?):AccessibilityNodeInfo? {
   if(node==null)return null
   if(node.isEditable && node.text?.toString()=="prior")return AccessibilityNodeInfo.obtain(node)
   for(i in 0 until node.childCount) {val child=node.getChild(i);try {val found=search(child);if(found!=null)return found} finally {child?.recycle()}}
   return null
  }
  val until=SystemClock.elapsedRealtime()+5000
  while(SystemClock.elapsedRealtime()<until) {
   val root=instrumentation.uiAutomation.rootInActiveWindow
   try {val found=search(root);if(found!=null)return found} finally {root?.recycle()}
   SystemClock.sleep(100)
  }
  throw AssertionError("Chromium editable virtual node missing")
 }
 @Test fun actualVirtualNodeAccessibilityReplacementConfirmsInsertion()=fixture { _,_ ->
  val node=editor();val id=prepared()
  try {
   val args=Bundle().apply {putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,"prior transcript")}
   assertTrue(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,args));instrumentation.waitForIdleSync()
   assertTrue("native virtual provider observed insertion",DictationRuntime.snapshot().optBoolean("inserted"))
   assertEquals("complete",DictationRuntime.command(id,"completed",101,SystemClock.elapsedRealtime()).optString("phase"))
  } finally {node.recycle();DictationRuntime.cancel()}
 }
 @Test fun imeCommitAndSelectionRevokeSessionWithoutSuppressingUserEdit()=fixture { _,web ->
  instrumentation.runOnMainSync {web.requestFocus()}
  val field=editor();try {assertTrue(field.performAction(AccessibilityNodeInfo.ACTION_CLICK))} finally {field.recycle()}
  instrumentation.waitForIdleSync();SystemClock.sleep(300)
  prepared()
  instrumentation.runOnMainSync {
   val input=web.onCreateInputConnection(EditorInfo());assertNotNull(input);input!!.commitText(" manual",1)
  }
  assertEquals("cancelled",DictationRuntime.snapshot().optString("phase"))
  prepared()
  instrumentation.runOnMainSync {web.onCreateInputConnection(EditorInfo())!!.setSelection(1,1)}
  assertEquals("cancelled",DictationRuntime.snapshot().optString("phase"))
 }
 @Test fun exportedEndpointRejectsActualUnapprovedBinderUid()=fixture { activity,_ ->
  val connected=CountDownLatch(1);val endpoint=AtomicReference<IBinder>()
  val connection=object:ServiceConnection {override fun onServiceConnected(name:ComponentName,binder:IBinder) {endpoint.set(binder);connected.countDown()};override fun onServiceDisconnected(name:ComponentName) {}}
  assertTrue(activity.bindService(Intent(activity,DictationBridgeService::class.java),connection,Context.BIND_AUTO_CREATE))
  try {
   assertTrue(connected.await(5,TimeUnit.SECONDS));val data=Parcel.obtain();val reply=Parcel.obtain()
   try {
    data.writeInterfaceToken(DictationBridgeService.DESCRIPTOR);data.writeString(UUID.randomUUID().toString());data.writeString("begin");data.writeStrongBinder(android.os.Binder())
    var denied=false
    try {endpoint.get().transact(IBinder.FIRST_CALL_TRANSACTION,data,reply,0);reply.readException()} catch(_:SecurityException) {denied=true}
    assertTrue("actual MDC UID is not the approved adapter UID",denied)
   } finally {data.recycle();reply.recycle()}
  } finally {activity.unbindService(connection)}
 }
 @Test fun actualRemoteProcessDeathRevokesCompletedSessionBeforeQueueAdmission()=fixture { activity,_ ->
  val connected=CountDownLatch(1);val died=CountDownLatch(1);val remote=AtomicReference<IBinder>()
  val connection=object:ServiceConnection {override fun onServiceConnected(name:ComponentName,binder:IBinder) {remote.set(binder);connected.countDown()};override fun onServiceDisconnected(name:ComponentName) {}}
  val intent=Intent().setComponent(ComponentName(activity.packageName,"com.multidevicecontext.mobile.DictationLeaseProbeService"))
  assertTrue(activity.bindService(intent,connection,Context.BIND_AUTO_CREATE))
  try {
   assertTrue(connected.await(5,TimeUnit.SECONDS));val state=DictationState();val id=UUID.randomUUID().toString();val chat=UUID.randomUUID().toString();val item=UUID.randomUUID().toString();val now=SystemClock.elapsedRealtime()
   state.attach("death-test") {died.countDown()};state.command(id,"begin",101,now,BinderDictationLease(remote.get()));state.report(id,"prepared",chat,1,null)
   state.command(id,"recording",101,now);state.command(id,"finishing",101,now);state.inserted(state.insertionOwner(),true);state.command(id,"completed",101,now)
   assertTrue(state.authorize(id,chat,1,item,now))
   val data=Parcel.obtain()
   try {remote.get().transact(IBinder.FIRST_CALL_TRANSACTION,data,null,IBinder.FLAG_ONEWAY)} catch(_:android.os.RemoteException) {} finally {data.recycle()}
   assertTrue("DeathRecipient revoked without a status poll",died.await(5,TimeUnit.SECONDS))
   assertFalse(state.authorize(id,chat,1,item,SystemClock.elapsedRealtime()));assertEquals("cancelled",state.snapshot().optString("phase"))
  } finally {activity.unbindService(connection)}
 }
}
