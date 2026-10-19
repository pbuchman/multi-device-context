package com.multidevicecontext.mobile

import android.app.KeyguardManager
import android.os.PowerManager
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
import android.view.WindowInsets
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
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean

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
 /** Fixed enums/counters only: CI must distinguish navigation, JS callback and display failures. */
 private class LoadProgress {
  val started=AtomicInteger();val finished=AtomicInteger();val domReady=AtomicInteger();val evalRequested=AtomicInteger();val evalReturned=AtomicInteger();val errors=AtomicInteger()
  @Volatile var jsResult="NOT_RETURNED";@Volatile var errorCode=0;@Volatile var rendererGone=false
  fun counters()="started=${started.get()},finished=${finished.get()},domReady=${domReady.get()},evalRequested=${evalRequested.get()},evalReturned=${evalReturned.get()},jsResult=$jsResult,mainErrors=${errors.get()},errorCode=$errorCode,rendererGone=$rendererGone"
  fun snapshot(activity:MainActivity,web:DictationWebView):String {
   val power=activity.getSystemService(PowerManager::class.java);val keyguard=activity.getSystemService(KeyguardManager::class.java)
   return counters()+",interactive=${power.isInteractive},keyguardLocked=${keyguard.isKeyguardLocked},attached=${web.isAttachedToWindow},shown=${web.isShown},windowVisible=${web.windowVisibility==android.view.View.VISIBLE},windowFocus=${web.hasWindowFocus()},viewFocus=${web.hasFocus()},activityFocus=${activity.currentFocus===web},javascript=${web.settings.javaScriptEnabled},progress=${web.progress}"
  }
 }
 /** androidTest-only signal; readiness still requires a separate read of the marked real DOM. */
 private class DocumentReady(private val signal:(String)->Unit) {
  @android.webkit.JavascriptInterface fun ready(marker:String)=signal(marker)
 }
 /** Receive the real DOM keyup boundary; parse and assert the raw snapshot on the test thread. */
 private class CommitTrace {
  val finished=CountDownLatch(1);val result=AtomicReference<String>();private val active=AtomicBoolean()
  @Volatile private var marker="";@Volatile private var deadline=0L
  fun document(value:String) {marker=value}
  fun arm() {check(deadline==0L);deadline=SystemClock.elapsedRealtime()+3000;active.set(true)}
  @android.webkit.JavascriptInterface fun observed(document:String,phase:String,value:String) {
   if(document==marker && phase=="owned-commit" && SystemClock.elapsedRealtime()<deadline && active.compareAndSet(true,false)) {result.set(value);finished.countDown()}
  }
  fun await()=finished.await((deadline-SystemClock.elapsedRealtime()).coerceAtLeast(0),TimeUnit.MILLISECONDS)
  fun close() {active.set(false)}
 }
 private val commitTrace=CommitTrace()
 private class DocumentLoad(private val web:DictationWebView,val bridgeName:String) {
  val progress=LoadProgress();val loaded=CountDownLatch(1);val active=AtomicBoolean(true);val deadline=SystemClock.elapsedRealtime()+10000
  fun await():Boolean {
   try {return loaded.await((deadline-SystemClock.elapsedRealtime()).coerceAtLeast(0),TimeUnit.MILLISECONDS)}
   finally {active.set(false);web.post {web.removeJavascriptInterface(bridgeName)}}
  }
 }
 /** Cancel Capacitor's initial navigation once; do not depend on onPageFinished delivery. */
 private fun loadDocument(web:DictationWebView,body:String,focusDraft:Boolean,capture:CommitTrace?=null):DocumentLoad {
  val marker=UUID.randomUUID().toString();val load=DocumentLoad(web,"MdcFixtureDocument_"+marker.replace("-",""));val progress=load.progress;val claimed=AtomicBoolean()
  web.stopLoading()
  if(capture!=null) {capture.document(marker);web.addJavascriptInterface(capture,"MdcFixtureCommit")}
  web.webViewClient=object:WebViewClient() {
   override fun onPageStarted(v:WebView,url:String,icon:android.graphics.Bitmap?) {progress.started.incrementAndGet()}
   override fun onPageFinished(v:WebView,url:String) {progress.finished.incrementAndGet()}
   override fun onReceivedError(v:WebView,request:android.webkit.WebResourceRequest,error:android.webkit.WebResourceError) {if(request.isForMainFrame){progress.errors.incrementAndGet();progress.errorCode=error.errorCode};super.onReceivedError(v,request,error)}
   override fun onRenderProcessGone(v:WebView,detail:android.webkit.RenderProcessGoneDetail):Boolean {progress.rendererGone=true;return false}
  }
  web.addJavascriptInterface(DocumentReady {received->
   if(received==marker && load.active.get() && SystemClock.elapsedRealtime()<load.deadline && claimed.compareAndSet(false,true)) {
    progress.domReady.incrementAndGet()
    web.post {
     if(load.active.get() && SystemClock.elapsedRealtime()<load.deadline) {
      progress.evalRequested.incrementAndGet()
      val probe=if(focusDraft) "const d=document.getElementById('draft');if(!(d instanceof HTMLTextAreaElement)||d.disabled||d.readOnly||d.value!=='prior')return 'DRAFT_MISSING';d.focus();d.setSelectionRange(5,5);return document.activeElement===d&&d.selectionStart===5&&d.selectionEnd===5?'DRAFT_FOCUSED':'DRAFT_UNFOCUSED'" else "return document.getElementById('root')?'DOCUMENT_READY':'ROOT_MISSING'"
      web.evaluateJavascript("(()=>{if(document.documentElement.dataset.mdcFixture!=='$marker'||!['interactive','complete'].includes(document.readyState))return 'WRONG_DOCUMENT';$probe})()") {value->
       if(load.active.get() && SystemClock.elapsedRealtime()<load.deadline) {
        progress.evalReturned.incrementAndGet();progress.jsResult=when(value) {"\"DRAFT_FOCUSED\""->"DRAFT_FOCUSED";"\"DRAFT_UNFOCUSED\""->"DRAFT_UNFOCUSED";"\"DRAFT_MISSING\""->"DRAFT_MISSING";"\"DOCUMENT_READY\""->"DOCUMENT_READY";"\"ROOT_MISSING\""->"ROOT_MISSING";"\"WRONG_DOCUMENT\""->"WRONG_DOCUMENT";else->"OTHER"}
        if(progress.jsResult==if(focusDraft) "DRAFT_FOCUSED" else "DOCUMENT_READY")load.loaded.countDown()
       }
      }
     }
    }
   }
  },load.bridgeName)
  val signal="<script>document.addEventListener('DOMContentLoaded',()=>window['${load.bridgeName}'].ready('$marker'),{once:true})</script>"
  web.loadDataWithBaseURL("https://localhost","<html data-mdc-fixture='$marker'><body>"+body+signal+"</body></html>","text/html","UTF-8",null)
  return load
 }
 private fun fixture(captureCommit:Boolean=false,block:(MainActivity,DictationWebView)->Unit) {
  val target=instrumentation.targetContext
  assertTrue("fixture requires interactive display",target.getSystemService(PowerManager::class.java).isInteractive)
  assertFalse("fixture requires unlocked display",target.getSystemService(KeyguardManager::class.java).isKeyguardLocked)
  ActivityScenario.launch(MainActivity::class.java).use { scenario ->
   val activity=AtomicReference<MainActivity>();val view=AtomicReference<DictationWebView>();val document=AtomicReference<DocumentLoad>()
   scenario.onActivity { current ->
    activity.set(current);val web=current.bridge.webView as DictationWebView;view.set(web)
    document.set(loadDocument(web,"<textarea id='draft' aria-label='Native dictation fixture'>prior</textarea>",true,if(captureCommit)commitTrace else null))
   }
   val load=document.get();val didLoad=load.await();val state=AtomicReference("MAIN_SNAPSHOT_NOT_RETURNED");val captured=CountDownLatch(1)
   android.os.Handler(android.os.Looper.getMainLooper()).post {
    try {state.set(load.progress.snapshot(activity.get(),view.get()))} catch (_:Exception) {state.set("MAIN_SNAPSHOT_FAILED")} finally {captured.countDown()}
   }
   captured.await(500,TimeUnit.MILLISECONDS)
   assertTrue("fixture loaded: "+state.get(),didLoad);instrumentation.waitForIdleSync()
   block(activity.get(),view.get())
  }
 }
 private fun editor(web:DictationWebView):AccessibilityNodeInfo {
  val automation=instrumentation.uiAutomation;val expectedPackage=instrumentation.targetContext.packageName
  val retrieveWindows=automation.serviceInfo.flags and android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS!=0
  val until=SystemClock.elapsedRealtime()+5000;var diagnostic="NO_AX_SAMPLE"
  while(SystemClock.elapsedRealtime()<until) {
   val roots=mutableListOf<AccessibilityNodeInfo>();val windows=automation.windows
   try {
    val windowStates=windows.map {window->
     val root=window.root;if(root!=null)roots.add(root)
     "id=${window.id},type=${window.type},active=${window.isActive},focused=${window.isFocused},packageMatches=${root?.packageName==expectedPackage}"
    }
    val activeRoot=automation.rootInActiveWindow;activeRoot?.let {roots.add(it)}
    val candidates=mutableListOf<AccessibilityNodeInfo>();var visited=0;var focused=0;var editable=0;var focusedEditable=0;var textMatches=0
    fun search(node:AccessibilityNodeInfo) {
     if(SystemClock.elapsedRealtime()>=until)return
     visited++;if(node.isFocused)focused++
     if(node.isEditable && node.packageName==expectedPackage) {
      editable++
      if(node.isFocused)focusedEditable++
      if(node.isFocused&&node.text?.toString()=="prior") {textMatches++;candidates.add(AccessibilityNodeInfo.obtain(node))}
     }
     for(i in 0 until node.childCount) {val child=node.getChild(i);try {if(child!=null)search(child)} finally {child?.recycle()}}
    }
    val focusedWindows=windows.filter {it.isFocused&&it.type==android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION}.map {it.id}.toSet()
    val current=activeRoot?.takeIf {it.packageName==expectedPackage} ?: roots.firstOrNull {it.windowId in focusedWindows&&it.packageName==expectedPackage}
    val fresh=current?.refresh()==true;if(fresh)search(requireNotNull(current))
    diagnostic="currentWindow=${current?.windowId},retrieveWindows=$retrieveWindows,windows=$windowStates,activeWindow=${activeRoot?.windowId},activePackageMatches=${activeRoot?.packageName==expectedPackage},currentRoot=${current!=null},fresh=$fresh,visited=$visited,focused=$focused,editable=$editable,focusedEditable=$focusedEditable,textMatches=$textMatches"
    if(candidates.size==1&&focusedEditable==1)return candidates.single()
    candidates.forEach {it.recycle()}
   } finally {roots.forEach {it.recycle()};windows.forEach {it.recycle()}}
   SystemClock.sleep(100)
  }
  val dom=AtomicReference("DOM_NOT_RETURNED");val read=CountDownLatch(1)
  web.post {val native="attached=${web.isAttachedToWindow},shown=${web.isShown},windowFocus=${web.hasWindowFocus()},viewFocus=${web.hasFocus()},nativeEditor=${web.onCheckIsTextEditor()}";web.evaluateJavascript("(()=>{const d=document.getElementById('draft');return JSON.stringify({marked:!!document.documentElement.dataset.mdcFixture,editable:!!d&&!d.disabled&&!d.readOnly,focused:document.activeElement===d,valueLength:d?.value.length??-1,selectionStart:d?.selectionStart??-1,selectionEnd:d?.selectionEnd??-1})})()") {dom.set("$native,dom=$it");read.countDown()}}
  read.await(500,TimeUnit.MILLISECONDS)
  throw AssertionError("Chromium editable virtual node missing: $diagnostic,dom=${dom.get()}")
 }
 @Test fun actualVirtualNodeAccessibilityReplacementConfirmsInsertion()=fixture { _,web ->
  val node=editor(web);val id=prepared()
  try {
   val args=Bundle().apply {putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,"prior transcript")}
   assertTrue(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,args));instrumentation.waitForIdleSync()
   assertTrue("native virtual provider observed insertion",DictationRuntime.snapshot().optBoolean("inserted"))
   assertEquals("complete",DictationRuntime.command(id,"completed",101,SystemClock.elapsedRealtime()).optString("phase"))
  } finally {node.recycle();DictationRuntime.cancel()}
 }
 @Test fun imeCommitAndSelectionRevokeSessionWithoutSuppressingUserEdit()=fixture { _,web ->
  val input=readyInput(web);prepared()
  instrumentation.runOnMainSync {input.commitText(" manual",1)}
  assertEquals("cancelled",DictationRuntime.snapshot().optString("phase"))
  prepared()
  instrumentation.runOnMainSync {input.setSelection(1,1)}
  assertEquals("cancelled",DictationRuntime.snapshot().optString("phase"))
 }
 @Test fun actualAccessibilityCommitBatchPreservesCandidateThroughPlatformCompositionCleanup()=fixture { activity,web ->
  if(android.os.Build.VERSION.SDK_INT<33)return@fixture
  val input=readyInput(web);hiddenField(activity,web);val id=prepared()
  val handler=input.handler ?: android.os.Handler(android.os.Looper.getMainLooper())
  val dispatch=java.util.concurrent.FutureTask {
   // RemoteInputConnectionImpl's accessibility commit, including its mandatory cleanup.
   input.beginBatchEdit()
   try {
    input.finishComposingText()
    assertEquals("cleanup alone retains processing","processing",DictationRuntime.snapshot().optString("phase"))
    assertFalse(DictationRuntime.snapshot().optBoolean("provisionalPending"))
    assertFalse(DictationRuntime.snapshot().optBoolean("provisionalInput"))
    assertTrue(input.commitText(" transcript",1,null))
   }
   finally {input.endBatchEdit()}
  }
  assertTrue(handler.post(dispatch));dispatch.get(3,TimeUnit.SECONDS);instrumentation.waitForIdleSync()
  val snapshot=DictationRuntime.snapshot()
  assertEquals("platform commit cancellation: "+snapshot.optString("cancelReason"),"processing",snapshot.optString("phase"))
  assertTrue(snapshot.optBoolean("provisionalInput"));assertFalse(snapshot.optBoolean("inserted"))
  assertEquals("complete",DictationRuntime.command(id,"completed",101,SystemClock.elapsedRealtime()).optString("phase"))
 }
 @Test fun actualIncompleteRepeatedNestedOrOrdinaryEditBatchesStillRevoke()=fixture { activity,web ->
  if(android.os.Build.VERSION.SDK_INT<33)return@fixture
  val actions=listOf<Pair<String,(android.view.inputmethod.InputConnection)->Unit>>(
   "cleanup without commit" to {it.beginBatchEdit();it.finishComposingText();it.endBatchEdit()},
   "repeated cleanup" to {it.beginBatchEdit();it.finishComposingText();it.finishComposingText();it.endBatchEdit()},
   "nested cleanup" to {it.beginBatchEdit();it.beginBatchEdit();it.finishComposingText();it.endBatchEdit();it.endBatchEdit()},
   "ordinary commit" to {it.beginBatchEdit();it.finishComposingText();it.commitText(" manual",1);it.endBatchEdit()},
   "ordinary composition" to {it.beginBatchEdit();it.finishComposingText();it.setComposingText(" manual",1);it.endBatchEdit()},
   "selection" to {it.beginBatchEdit();it.finishComposingText();it.setSelection(0,0);it.endBatchEdit()}
  )
  for((name,action) in actions) {
   val input=readyInput(web);hiddenField(activity,web);val id=prepared()
   val handler=input.handler ?: android.os.Handler(android.os.Looper.getMainLooper())
   val dispatch=java.util.concurrent.FutureTask {action(input)}
   assertTrue(handler.post(dispatch));dispatch.get(3,TimeUnit.SECONDS);instrumentation.waitForIdleSync()
   assertEquals("revoked by $name","cancelled",DictationRuntime.snapshot().optString("phase"))
   assertFalse("no admission after $name",DictationRuntime.authorize(id,DictationRuntime.snapshot().getString("contextId"),1,UUID.randomUUID().toString(),SystemClock.elapsedRealtime()))
  }
 }
 @Test fun actualThreeArgumentCommitIsProvisionalAndDoesNotSelfDispatchIntoRejectingOverload()=fixture(captureCommit=true) { activity,web ->
  if(android.os.Build.VERSION.SDK_INT<33)return@fixture
  val input=readyInput(web)
  instrumentation.runOnMainSync {
   activity.window.decorView.windowInsetsController?.hide(WindowInsets.Type.ime())
  }
  val until=SystemClock.elapsedRealtime()+3000
  while(!DictationFieldGuard(web).valid() && SystemClock.elapsedRealtime()<until)SystemClock.sleep(50)
  assertTrue("current focused field and hidden IME",DictationFieldGuard(web).valid())
  try {
   val capturing=CountDownLatch(1);val armed=AtomicReference<String>()
   val script="""
    (()=>{
     const d=document.getElementById('draft'),marker=document.documentElement.dataset.mdcFixture;
     if(document.activeElement!==d||d.value!=='prior'||d.selectionStart!==5||d.selectionEnd!==5)return 'FIELD_NOT_READY';
     window.events=[];window.fixturePhase='owned-commit';let sent=false;
     for(const kind of ['input','beforeinput','compositionstart','compositionupdate','compositionend','paste','keydown','keyup','pointerdown'])document.addEventListener(kind,e=>{
      window.events.push({type:e.type,key:e.key??null,code:e.code??null,keyCode:e.keyCode??null,isTrusted:e.isTrusted,isComposing:e.isComposing??null,inputType:e.inputType??null,phase:window.fixturePhase});
      if(e.type==='keyup'&&!sent&&window.fixturePhase==='owned-commit'&&document.documentElement.dataset.mdcFixture===marker){
       sent=true;let snapshot;try{snapshot=JSON.stringify({value:d.value,events:window.events})}catch(error){snapshot=JSON.stringify({observationError:String(error)})}
       MdcFixtureCommit.observed(marker,window.fixturePhase,snapshot);
      }
     },true);
     return 'CAPTURE_ARMED';
    })()
   """.trimIndent()
   instrumentation.runOnMainSync {web.evaluateJavascript(script) {armed.set(it);capturing.countDown()}}
   assertTrue("capture armed after real connection and hidden IME settle",capturing.await(3,TimeUnit.SECONDS))
   assertEquals("actual prior field/focus/caret before commit","\"CAPTURE_ARMED\"",armed.get())
   val id=prepared();commitTrace.arm()
   instrumentation.runOnMainSync {assertTrue(input.commitText(" transcript",1,null))}
   instrumentation.waitForIdleSync()
   assertEquals("processing",DictationRuntime.snapshot().optString("phase"))
   assertTrue(DictationRuntime.snapshot().optBoolean("provisionalInput"));assertFalse(DictationRuntime.snapshot().optBoolean("inserted"))
   val observed=commitTrace.await();val diagnostic=AtomicReference("KEYUP_NOT_OBSERVED")
   if(!observed) {
    val read=CountDownLatch(1)
    web.post {web.evaluateJavascript("(()=>{const d=document.getElementById('draft');return JSON.stringify({readyState:document.readyState,valueLength:d?.value.length??-1,expectedText:d?.value==='prior transcript',activeDraft:document.activeElement===d,selectionStart:d?.selectionStart??-1,selectionEnd:d?.selectionEnd??-1,ownedPhase:window.fixturePhase==='owned-commit',eventTypes:(window.events??[]).map(e=>e.type)})})()") {value->diagnostic.set(value);read.countDown()}}
    read.await(500,TimeUnit.MILLISECONDS)
   }
   assertTrue("real DOM keyup snapshot within the original observation budget: "+diagnostic.get(),observed)
   val events=commitTrace.result.get();val snapshot=org.json.JSONObject(events)
   assertFalse("DOM observation error: "+snapshot.optString("observationError"),snapshot.has("observationError"))
   assertEquals("exact DOM value after the complete event chain","prior transcript",snapshot.getString("value"))
   assertTrue("expected insertion after keyup; actual length="+snapshot.getString("value").length,events.contains("prior transcript"));assertTrue(events.contains("input"))
   val trace=snapshot.getJSONArray("events")
   assertEquals(listOf("keydown","beforeinput","input","keyup"),(0 until trace.length()).map {trace.getJSONObject(it).getString("type")})
   for(index in listOf(0,3)) {val key=trace.getJSONObject(index);assertEquals("Unidentified",key.getString("key"));assertEquals("",key.getString("code"));assertEquals(229,key.getInt("keyCode"));assertTrue(key.getBoolean("isTrusted"));assertFalse(key.getBoolean("isComposing"))}
   for(index in listOf(1,2))assertEquals("insertText",trace.getJSONObject(index).getString("inputType"))
   assertEquals("complete",DictationRuntime.command(id,"completed",101,SystemClock.elapsedRealtime()).optString("phase"))
  } finally {commitTrace.close();web.post {web.removeJavascriptInterface("MdcFixtureCommit")}}
 }
 @Test fun actualThreeArgumentCommitWithLostFocusPreservesEditButRevokesAutomation()=fixture { _,web ->
  if(android.os.Build.VERSION.SDK_INT<33)return@fixture
  val input=readyInput(web);prepared()
  instrumentation.runOnMainSync {web.clearFocus();input.commitText(" manual",1,null)}
  assertEquals("cancelled",DictationRuntime.snapshot().optString("phase"));assertEquals("INPUT_COMMIT_ATTRIBUTES",DictationRuntime.snapshot().optString("cancelReason"))
 }

 private fun readyInput(web:DictationWebView):android.view.inputmethod.InputConnection {
  instrumentation.runOnMainSync {web.requestFocus()}
  val selected=CountDownLatch(1);val focused=AtomicReference<String>()
  instrumentation.runOnMainSync {web.evaluateJavascript("(()=>{const d=document.getElementById('draft');if(!document.documentElement.dataset.mdcFixture||!d||d.disabled||d.readOnly)return false;d.focus();d.setSelectionRange(d.value.length,d.value.length);return document.activeElement===d&&d.selectionStart===d.value.length&&d.selectionEnd===d.value.length})()") {focused.set(it);selected.countDown()}}
  assertTrue("actual DOM selection settled",selected.await(3,TimeUnit.SECONDS));assertEquals("actual marked editable owns DOM focus and endcaret","true",focused.get())
  val state=AtomicReference("NATIVE_READINESS_NOT_OBSERVED")
  val input=AtomicReference<android.view.inputmethod.InputConnection?>();val until=SystemClock.elapsedRealtime()+3000
  while(input.get()==null && SystemClock.elapsedRealtime()<until) {
   instrumentation.runOnMainSync {
    val attached=web.isAttachedToWindow;val shown=web.isShown;val viewFocus=web.hasFocus();val windowFocus=web.hasWindowFocus();val editor=web.onCheckIsTextEditor()
    if(attached&&shown&&viewFocus&&windowFocus&&SystemClock.elapsedRealtime()<until) {
     input.set(web.onCreateInputConnection(EditorInfo()))
    }
    state.set("attached=$attached,shown=$shown,viewFocus=$viewFocus,windowFocus=$windowFocus,textEditor=$editor,inputPresent=${input.get()!=null}")
   }
   if(input.get()==null)SystemClock.sleep(50)
  }
  assertNotNull("actual Chromium InputConnection required within original3s: ${state.get()}",input.get())
  return requireNotNull(input.get())
 }
 private fun hiddenField(activity:MainActivity,web:DictationWebView) {
  instrumentation.runOnMainSync {activity.window.decorView.windowInsetsController?.hide(WindowInsets.Type.ime())}
  val until=SystemClock.elapsedRealtime()+3000
  while(!DictationFieldGuard(web).valid() && SystemClock.elapsedRealtime()<until)SystemClock.sleep(50)
  assertTrue("current focused field and hidden IME",DictationFieldGuard(web).valid())
 }
 @Test fun obsoleteActualWrapperCannotArmAfterReplacement()=fixture { activity,web ->
  if(android.os.Build.VERSION.SDK_INT<33)return@fixture
  val obsolete=readyInput(web);hiddenField(activity,web);prepared()
  instrumentation.runOnMainSync {
   assertNotNull("replacement actual connection",web.onCreateInputConnection(EditorInfo()))
   obsolete.commitText(" obsolete",1,null)
  }
  assertEquals("cancelled",DictationRuntime.snapshot().optString("phase"))
  assertEquals("INPUT_COMMIT_ATTRIBUTES",DictationRuntime.snapshot().optString("cancelReason"))
 }
 @Test fun actualWrapperReplacementRevokesProcessingAndCompletedCandidates()=fixture { activity,web ->
  if(android.os.Build.VERSION.SDK_INT<33)return@fixture
  for(complete in listOf(false,true)) {
   val input=readyInput(web);hiddenField(activity,web);val id=prepared()
   instrumentation.runOnMainSync {assertTrue(input.commitText(" candidate",1,null))}
   assertTrue(DictationRuntime.snapshot().optBoolean("provisionalInput"))
   if(complete)assertEquals("complete",DictationRuntime.command(id,"completed",101,SystemClock.elapsedRealtime()).optString("phase"))
   instrumentation.runOnMainSync {assertNotNull(web.onCreateInputConnection(EditorInfo()))}
   val snapshot=DictationRuntime.snapshot();assertEquals("cancelled",snapshot.optString("phase"));assertEquals("PROVISIONAL_FIELD_CHANGED",snapshot.optString("cancelReason"))
   assertFalse(DictationRuntime.authorize(id,snapshot.getString("contextId"),1,UUID.randomUUID().toString(),SystemClock.elapsedRealtime()))
  }
 }
 @Test fun actualCompositionRegionCompletionCorrectionAndReplacementRevokeWithoutBlockingDispatch()=fixture { _,web ->
  val actions=mutableListOf<Pair<String,(android.view.inputmethod.InputConnection)->Unit>>(
   "region" to {it.setComposingRegion(0,2)},
   "finish" to {it.finishComposingText()},
   "completion" to {it.commitCompletion(android.view.inputmethod.CompletionInfo(1,0,"suggestion"))},
   "correction" to {it.commitCorrection(android.view.inputmethod.CorrectionInfo(0,"prior","after"))},
   "editor action" to {it.performEditorAction(EditorInfo.IME_ACTION_DONE)}
  )
  if(android.os.Build.VERSION.SDK_INT>=33)actions.add("region attributes" to {it.setComposingRegion(0,2,null)})
  if(android.os.Build.VERSION.SDK_INT>=34)actions.add("replace" to {it.replaceText(0,2,"after",1,null)})
  for((name,action) in actions) {
   val input=readyInput(web);prepared()
   // Match Android's InputConnection dispatch, including Chromium's dedicated IME looper.
   val handler=input.handler ?: android.os.Handler(android.os.Looper.getMainLooper())
   val dispatch=java.util.concurrent.FutureTask {action(input)}
   assertTrue("input handler accepts $name",handler.post(dispatch));dispatch.get(3,TimeUnit.SECONDS)
   assertEquals("revoked by $name","cancelled",DictationRuntime.snapshot().optString("phase"))
  }
 }

 /** Test-only JS facade delegates every proof/admission to the actual native runtime. */
 private class HookBridge {
  private val reports=java.util.ArrayDeque<String>();private var dropped=0
  @Synchronized private fun remember(value:org.json.JSONObject) {
   val phase=value.optString("phase").let {if(it in setOf("prepared","recording","processing","complete","queued","synced","cancelled"))it else "OTHER"}
   val reason=value.optString("reason").let {if(it.isEmpty())"NONE" else if(DictationCancelReason.values().any {reason->reason.name==it})it else "OTHER"}
   if(reports.size<32)reports.add("phase=$phase,reason=$reason") else dropped++
  }
  @Synchronized fun summary()="reports=${reports.toList()},dropped=$dropped"
  @android.webkit.JavascriptInterface fun read()=DictationRuntime.snapshot().toString()
  @android.webkit.JavascriptInterface fun confirm(id:String,chat:String,revision:Int)=DictationRuntime.confirmProvisional(id,chat,revision,SystemClock.elapsedRealtime())
  @android.webkit.JavascriptInterface fun authorize(id:String,chat:String,revision:Int,item:String)=DictationRuntime.authorize(id,chat,revision,item,SystemClock.elapsedRealtime())
  @android.webkit.JavascriptInterface fun report(value:String) {val v=org.json.JSONObject(value);remember(v);DictationRuntime.report(v.getString("id"),v.getString("phase"),v.optString("contextId").takeIf {it.isNotEmpty()},if(v.has("revision"))v.getInt("revision") else null,v.optString("itemId").takeIf {it.isNotEmpty()},v.optString("reason"),SystemClock.elapsedRealtime())}
 }
 private fun phase(expected:String,bridge:HookBridge) {
  val until=SystemClock.elapsedRealtime()+4000
  while(DictationRuntime.snapshot().optString("phase")!=expected && SystemClock.elapsedRealtime()<until)SystemClock.sleep(50)
  val snapshot=DictationRuntime.snapshot();val allowedPhases=setOf("none","begin","busy","prepared","recording","processing","complete","queued","synced","cancelled")
  val diagnostic=org.json.JSONObject()
  for(key in listOf("phase","cancelPhase"))diagnostic.put(key,snapshot.optString(key).let {if(it.isEmpty())"NONE" else if(it in allowedPhases)it else "OTHER"})
  diagnostic.put("cancelReason",snapshot.optString("cancelReason").let {if(it.isEmpty())"NONE" else if(DictationCancelReason.values().any {reason->reason.name==it})it else "OTHER"})
  diagnostic.put("cancelledAtElapsedMs",snapshot.optLong("cancelledAtElapsedMs",-1)).put("inserted",snapshot.optBoolean("inserted")).put("provisionalInput",snapshot.optBoolean("provisionalInput"))
  assertEquals("native phase: $diagnostic,${bridge.summary()}",expected,snapshot.optString("phase"))
 }
 @Test fun actualCommitRunsCompiledProductionHookAndFreshNativeProofBeforeSingleSendAndExactAck()=fixture { activity,web ->
  if(android.os.Build.VERSION.SDK_INT<33)return@fixture
  val bundle=instrumentation.context.assets.open("dictation-hook-fixture.js").bufferedReader().use {it.readText()};val document=AtomicReference<DocumentLoad>();val bridge=HookBridge()
  instrumentation.runOnMainSync {
   web.addJavascriptInterface(bridge,"MdcDictationFixture")
   document.set(loadDocument(web,"<div id='root'></div><script>window.fixtureErrors=[];addEventListener('error',e=>window.fixtureErrors.push(e.message));</script><script>"+bundle+"</script>",false))
  }
  val hookLoad=document.get();val didLoad=hookLoad.await()
  assertTrue("compiled hook fixture loaded: "+hookLoad.progress.counters(),didLoad);instrumentation.waitForIdleSync()
  var dom=org.json.JSONObject();val readyUntil=SystemClock.elapsedRealtime()+4000
  while(!dom.optBoolean("ready") && SystemClock.elapsedRealtime()<readyUntil) {
   val read=CountDownLatch(1);val value=AtomicReference<String>()
   instrumentation.runOnMainSync {web.evaluateJavascript("JSON.stringify({ready:window.fixtureReady===true,editable:!!document.querySelector('textarea#draft'),errors:window.fixtureErrors})"){value.set(it);read.countDown()}}
   assertTrue("DOM readiness read",read.await(3,TimeUnit.SECONDS));dom=org.json.JSONObject(org.json.JSONTokener(value.get()).nextValue().toString())
   if(!dom.optBoolean("ready"))SystemClock.sleep(50)
  }
  assertTrue("compiled production hook mounted: "+dom.toString(),dom.optBoolean("ready"));assertTrue("fixture editable mounted",dom.optBoolean("editable"));assertEquals("fixture console errors",0,dom.getJSONArray("errors").length())
  val input=readyInput(web);hiddenField(activity,web)
  val id=UUID.randomUUID().toString();val now=SystemClock.elapsedRealtime();DictationRuntime.cancel()
  DictationRuntime.command(id,"begin",101,now,object:DictationLease{override fun alive()=true;override fun watch(death:()->Unit){};override fun release(){}})
  phase("prepared",bridge);DictationRuntime.command(id,"recording",101,SystemClock.elapsedRealtime());SystemClock.sleep(200)
  // Deliberately no renderer poll wait after native finishing: cover the recording/processing poll race.
  DictationRuntime.command(id,"finishing",101,SystemClock.elapsedRealtime())
  val handler=input.handler ?: android.os.Handler(android.os.Looper.getMainLooper())
  val dispatch=java.util.concurrent.FutureTask {
   input.beginBatchEdit()
   try {
    input.finishComposingText()
    assertEquals("production hook cleanup retains processing","processing",DictationRuntime.snapshot().optString("phase"))
    assertFalse(DictationRuntime.snapshot().optBoolean("provisionalPending"))
    assertFalse(DictationRuntime.snapshot().optBoolean("provisionalInput"))
    assertTrue(input.commitText(" transcript",1,null))
   }
   finally {input.endBatchEdit()}
  }
  assertTrue(handler.post(dispatch));dispatch.get(3,TimeUnit.SECONDS);instrumentation.waitForIdleSync()
  assertEquals("processing",DictationRuntime.snapshot().optString("phase"));assertTrue(DictationRuntime.snapshot().optBoolean("provisionalInput"))
  SystemClock.sleep(650);assertEquals("complete",DictationRuntime.command(id,"completed",101,SystemClock.elapsedRealtime()).optString("phase"));phase("queued",bridge)
  val read=CountDownLatch(1);val result=AtomicReference<String>()
  instrumentation.runOnMainSync {web.evaluateJavascript("JSON.stringify(window.fixtureSends)"){result.set(it);read.countDown()}}
  assertTrue(read.await(3,TimeUnit.SECONDS));assertEquals("one whole-editor send","[\"prior transcript\"]",org.json.JSONTokener(result.get()).nextValue().toString())
  instrumentation.runOnMainSync {web.evaluateJavascript("window.fixtureAck()",null)};phase("synced",bridge)
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
