package com.multidevicecontext.mobile

import android.content.Context
import android.os.Bundle
import android.os.SystemClock
import android.util.AttributeSet
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeProvider
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import com.getcapacitor.CapacitorWebView
import java.util.concurrent.atomic.AtomicLong

/** Ordinary edits revoke authority. A hidden-IME API33 commit is provisional, never an origin claim. */
class DictationWebView(context:Context,attrs:AttributeSet):CapacitorWebView(context,attrs) {
 private val inputGeneration=AtomicLong()
 private fun interfere(reason:DictationCancelReason) {DictationRuntime.cancel(reason,SystemClock.elapsedRealtime())}
 override fun onCreateInputConnection(attributes:EditorInfo):InputConnection? {
  val generation=inputGeneration.incrementAndGet()
  DictationRuntime.inputConnectionChanged(SystemClock.elapsedRealtime())
  val target=super.onCreateInputConnection(attributes) ?: return null
  return object:InputConnectionWrapper(target,false) {
   private var batchDepth=0
   private var cleanupPending=false
   @Synchronized override fun beginBatchEdit():Boolean {
    if(cleanupPending) interfere(DictationCancelReason.INPUT_COMPOSITION)
    batchDepth++;return target.beginBatchEdit()
   }
   @Synchronized override fun endBatchEdit():Boolean {
    if(batchDepth==1 && cleanupPending) interfere(DictationCancelReason.INPUT_COMPOSITION)
    if(batchDepth>0) batchDepth--
    if(batchDepth==0) cleanupPending=false
    return target.endBatchEdit()
   }
   override fun commitText(text:CharSequence?,newCursorPosition:Int):Boolean {interfere(DictationCancelReason.INPUT_COMMIT);return super.commitText(text,newCursorPosition)}
   override fun setComposingText(text:CharSequence?,newCursorPosition:Int):Boolean {interfere(DictationCancelReason.INPUT_COMPOSITION);return super.setComposingText(text,newCursorPosition)}
   override fun deleteSurroundingText(beforeLength:Int,afterLength:Int):Boolean {interfere(DictationCancelReason.INPUT_DELETE);return super.deleteSurroundingText(beforeLength,afterLength)}
   override fun deleteSurroundingTextInCodePoints(beforeLength:Int,afterLength:Int):Boolean {interfere(DictationCancelReason.INPUT_DELETE);return super.deleteSurroundingTextInCodePoints(beforeLength,afterLength)}
   override fun sendKeyEvent(event:KeyEvent?):Boolean {interfere(DictationCancelReason.INPUT_KEY);return super.sendKeyEvent(event)}
   override fun performContextMenuAction(id:Int):Boolean {interfere(DictationCancelReason.INPUT_CONTEXT_MENU);return super.performContextMenuAction(id)}
   @android.annotation.TargetApi(33)
   @Synchronized override fun commitText(text:CharSequence,newCursorPosition:Int,attributes:android.view.inputmethod.TextAttribute?):Boolean {
    cleanupPending=false
    val generationSource=inputGeneration
    val currentGeneration={generationSource.get()==generation}
    val guard=DictationFieldGuard(this@DictationWebView,currentGeneration)
    val owner=DictationRuntime.provisionalOwner(text.isNotEmpty() && newCursorPosition==1 && attributes==null && guard.valid(),SystemClock.elapsedRealtime(),currentGeneration,guard::valid)
    // Delegate through the captured target directly. No dispatch through our two-argument rejecting overload.
    val accepted=try {target.commitText(text,newCursorPosition,attributes)} catch(error:RuntimeException) {interfere(DictationCancelReason.PROVISIONAL_REJECTED);throw error}
    if(owner!=null) DictationRuntime.provisionalCommitted(owner,accepted,guard.valid(),SystemClock.elapsedRealtime())
    return accepted
   }
   @android.annotation.TargetApi(33)
   override fun setComposingText(text:CharSequence,newCursorPosition:Int,attributes:android.view.inputmethod.TextAttribute?):Boolean {interfere(DictationCancelReason.INPUT_COMPOSITION);return super.setComposingText(text,newCursorPosition,attributes)}
   override fun setComposingRegion(start:Int,end:Int):Boolean {interfere(DictationCancelReason.INPUT_COMPOSITION);return super.setComposingRegion(start,end)}
   @android.annotation.TargetApi(33)
   override fun setComposingRegion(start:Int,end:Int,attributes:android.view.inputmethod.TextAttribute?):Boolean {interfere(DictationCancelReason.INPUT_COMPOSITION);return super.setComposingRegion(start,end,attributes)}
   @Synchronized override fun finishComposingText():Boolean {
    val currentGeneration={inputGeneration.get()==generation}
    val guard=DictationFieldGuard(this@DictationWebView,currentGeneration)
    if(batchDepth==1 && !cleanupPending && DictationRuntime.compositionCleanupAllowed(guard.valid(),SystemClock.elapsedRealtime(),currentGeneration)) cleanupPending=true
    else interfere(DictationCancelReason.INPUT_COMPOSITION)
    return try {target.finishComposingText()} catch(error:RuntimeException) {interfere(DictationCancelReason.PROVISIONAL_REJECTED);throw error}
   }
   override fun commitCompletion(text:android.view.inputmethod.CompletionInfo?):Boolean {interfere(DictationCancelReason.INPUT_COMMIT);return super.commitCompletion(text)}
   override fun commitCorrection(info:android.view.inputmethod.CorrectionInfo?):Boolean {interfere(DictationCancelReason.INPUT_COMMIT);return super.commitCorrection(info)}
   @android.annotation.TargetApi(34)
   override fun replaceText(start:Int,end:Int,text:CharSequence,newCursorPosition:Int,attributes:android.view.inputmethod.TextAttribute?):Boolean {interfere(DictationCancelReason.INPUT_COMMIT);return super.replaceText(start,end,text,newCursorPosition,attributes)}
   override fun commitContent(info:android.view.inputmethod.InputContentInfo,flags:Int,options:Bundle?):Boolean {interfere(DictationCancelReason.INPUT_COMMIT);return super.commitContent(info,flags,options)}
   override fun performEditorAction(action:Int):Boolean {interfere(DictationCancelReason.INPUT_KEY);return super.performEditorAction(action)}
   override fun performPrivateCommand(action:String?,data:Bundle?):Boolean {interfere(DictationCancelReason.INPUT_COMMIT);return super.performPrivateCommand(action,data)}
   @android.annotation.TargetApi(34)
   override fun performHandwritingGesture(gesture:android.view.inputmethod.HandwritingGesture,executor:java.util.concurrent.Executor?,consumer:java.util.function.IntConsumer?) {interfere(DictationCancelReason.INPUT_COMMIT);super.performHandwritingGesture(gesture,executor,consumer)}
   override fun closeConnection() {if(inputGeneration.compareAndSet(generation,generation+1)) DictationRuntime.inputConnectionChanged(SystemClock.elapsedRealtime());super.closeConnection()}
   override fun setSelection(start:Int,end:Int):Boolean {interfere(DictationCancelReason.INPUT_SELECTION);return super.setSelection(start,end)}
  }
 }
 override fun dispatchKeyEvent(event:KeyEvent):Boolean {if(event.action==KeyEvent.ACTION_DOWN) interfere(DictationCancelReason.NATIVE_KEY);return super.dispatchKeyEvent(event)}
 override fun onTouchEvent(event:MotionEvent):Boolean {if(event.actionMasked==MotionEvent.ACTION_DOWN) interfere(DictationCancelReason.NATIVE_TOUCH);return super.onTouchEvent(event)}
 override fun getAccessibilityNodeProvider():AccessibilityNodeProvider? {
  val provider=super.getAccessibilityNodeProvider() ?: return null
  return object:AccessibilityNodeProvider() {
   override fun createAccessibilityNodeInfo(id:Int)=provider.createAccessibilityNodeInfo(id)
   override fun findAccessibilityNodeInfosByText(text:String?,id:Int)=provider.findAccessibilityNodeInfosByText(text,id)
   override fun findFocus(focus:Int)=provider.findFocus(focus)
   override fun addExtraDataToAccessibilityNodeInfo(id:Int,info:AccessibilityNodeInfo,key:String,args:Bundle?)=provider.addExtraDataToAccessibilityNodeInfo(id,info,key,args)
   override fun performAction(id:Int,action:Int,args:Bundle?):Boolean {
    if(action!=AccessibilityNodeInfo.ACTION_SET_TEXT && action!=AccessibilityNodeInfo.ACTION_PASTE) return provider.performAction(id,action,args)
    val owner=DictationRuntime.insertionOwner()
    val accepted=provider.performAction(id,action,args)
    DictationRuntime.inserted(owner,accepted)
    return accepted
   }
  }
 }
}
