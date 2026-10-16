package com.multidevicecontext.mobile

import android.content.Context
import android.os.Bundle
import android.util.AttributeSet
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeProvider
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import com.getcapacitor.CapacitorWebView

/** IME edits revoke authority. Wispr's Accessibility replacement is observed locally. */
class DictationWebView(context:Context,attrs:AttributeSet):CapacitorWebView(context,attrs) {
 override fun onCreateInputConnection(attributes:EditorInfo):InputConnection? {
  val target=super.onCreateInputConnection(attributes) ?: return null
  return object:InputConnectionWrapper(target,false) {
   override fun commitText(text:CharSequence?,newCursorPosition:Int):Boolean {DictationRuntime.cancel();return super.commitText(text,newCursorPosition)}
   override fun setComposingText(text:CharSequence?,newCursorPosition:Int):Boolean {DictationRuntime.cancel();return super.setComposingText(text,newCursorPosition)}
   override fun deleteSurroundingText(beforeLength:Int,afterLength:Int):Boolean {DictationRuntime.cancel();return super.deleteSurroundingText(beforeLength,afterLength)}
   override fun deleteSurroundingTextInCodePoints(beforeLength:Int,afterLength:Int):Boolean {DictationRuntime.cancel();return super.deleteSurroundingTextInCodePoints(beforeLength,afterLength)}
   override fun sendKeyEvent(event:KeyEvent?):Boolean {DictationRuntime.cancel();return super.sendKeyEvent(event)}
   override fun performContextMenuAction(id:Int):Boolean {DictationRuntime.cancel();return super.performContextMenuAction(id)}
   @android.annotation.TargetApi(33)
   override fun commitText(text:CharSequence,newCursorPosition:Int,attributes:android.view.inputmethod.TextAttribute?):Boolean {DictationRuntime.cancel();return super.commitText(text,newCursorPosition,attributes)}
   @android.annotation.TargetApi(33)
   override fun setComposingText(text:CharSequence,newCursorPosition:Int,attributes:android.view.inputmethod.TextAttribute?):Boolean {DictationRuntime.cancel();return super.setComposingText(text,newCursorPosition,attributes)}
   override fun setSelection(start:Int,end:Int):Boolean {DictationRuntime.cancel();return super.setSelection(start,end)}
  }
 }
 override fun dispatchKeyEvent(event:KeyEvent):Boolean {if(event.action==KeyEvent.ACTION_DOWN) DictationRuntime.cancel();return super.dispatchKeyEvent(event)}
 override fun onTouchEvent(event:MotionEvent):Boolean {if(event.actionMasked==MotionEvent.ACTION_DOWN) DictationRuntime.cancel();return super.onTouchEvent(event)}
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
