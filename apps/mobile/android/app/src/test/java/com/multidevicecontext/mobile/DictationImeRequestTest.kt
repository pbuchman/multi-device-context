package com.multidevicecontext.mobile

import org.junit.Assert.*
import org.junit.Test

class DictationImeRequestTest {
 private var now=1000L
 private val request=DictationImeRequest {now}
 private var shown=0
 private fun attempt(token:Long,eligible:Boolean=true)=request.attempt(token,eligible) {shown++}
 @Test fun noRequestDoesNothing() {attempt(1);assertEquals(0,shown)}
 @Test fun focusedRequestExecutesOnlyOnce() {
  val token=request.request();attempt(token);attempt(token)
  assertEquals(1,shown);assertNull(request.pendingToken)
 }
 @Test fun waitsForEligibilityWithinOriginalDeadline() {
  val token=request.request();attempt(token,false);assertEquals(token,request.pendingToken)
  now+=1499;attempt(token);assertEquals(1,shown)
 }
 @Test fun exactDeadlineFailsClosedWithoutExpiryCallback() {
  val token=request.request();now+=1500;attempt(token)
  assertEquals(0,shown);assertNull(request.pendingToken)
 }
 @Test fun ineligibleAttemptCannotRenewDeadline() {
  val token=request.request();now+=1400;attempt(token,false);now+=100;attempt(token)
  assertEquals(0,shown)
 }
 @Test fun pauseDestroyOrOtherIntentCancellationStopsPostedAttempts() {
  val token=request.request();request.cancel();attempt(token)
  assertEquals(0,shown);assertNull(request.pendingToken)
 }
 @Test fun oldPostedAttemptCannotConsumeNewRequest() {
  val old=request.request();request.cancel();val next=request.request()
  attempt(old);assertEquals(next,request.pendingToken);attempt(next);assertEquals(1,shown)
 }
 @Test fun oldExpiryCannotCancelNewRequest() {
  val old=request.request();val next=request.request();request.cancel(old)
  assertEquals(next,request.pendingToken);attempt(next);assertEquals(1,shown)
 }
 @Test fun expiryCancelsOnlyItsOwnRequest() {
  val token=request.request();request.cancel(token);attempt(token)
  assertEquals(0,shown)
 }
 @Test fun rollbackFailsClosed() {
  val token=request.request();now--;attempt(token);assertEquals(0,shown)
 }
 @Test fun platformFailureCannotCauseRetry() {
  val token=request.request()
  try {request.attempt(token,true) {throw IllegalStateException("synthetic platform failure")}} catch(_:IllegalStateException) {}
  attempt(token);assertEquals(0,shown);assertNull(request.pendingToken)
 }
}
