package com.multidevicecontext.mobile

import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class DictationStateTest {
 private class Lease:DictationLease {var living=true;var death:(()->Unit)?=null;override fun alive()=living;override fun watch(death:()->Unit) {this.death=death};override fun release() {death=null};fun die() {living=false;death?.invoke()}}
 private val lease=Lease()
 private val state=DictationState()
 private val id=UUID.randomUUID().toString()
 private val chat=UUID.randomUUID().toString()
 private val item=UUID.randomUUID().toString()
 private fun command(op:String,now:Long=1,uid:Int=101)=state.command(id,op,uid,now,if(op=="begin")lease else null).optString("phase")
 private fun prepare() {assertEquals("begin",command("begin"));state.report(id,"prepared",chat,3,null);assertEquals("prepared",command("status"))}
 private fun finish() {prepare();assertEquals("recording",command("recording"));assertEquals("processing",command("finishing",1000))}
 private fun insert() {val owner=state.insertionOwner();assertEquals(id,owner);state.inserted(owner,true)}
 @Test fun callerAndSignerBoundaryRejectsImpersonationSharedUidAndExtraSigners() {
  val pkg=DictationBridgeService.ADAPTER;val cert=DictationBridgeService.CERT
  assertTrue(DictationTrust.approved(arrayOf(pkg),listOf(cert)))
  assertFalse(DictationTrust.approved(null,listOf(cert)))
  assertFalse(DictationTrust.approved(arrayOf("evil.package"),listOf(cert)))
  assertFalse(DictationTrust.approved(arrayOf(pkg,"shared.uid"),listOf(cert)))
  assertFalse(DictationTrust.approved(arrayOf(pkg),listOf("unapproved")))
  assertFalse(DictationTrust.approved(arrayOf(pkg),listOf(cert,cert)))
 }
 @Test fun wrongUidOrSessionCannotDriveOwnedRecording() {
  prepare();assertEquals("cancelled",command("recording",uid=102));assertEquals("prepared",command("status"))
  assertEquals("cancelled",state.command(UUID.randomUUID().toString(),"recording",101,1).optString("phase"))
 }
 @Test fun longRecordingDoesNotExpireAndProcessingHasItsOwnFixedDeadline() {
  prepare();command("recording");assertEquals("recording",command("status",120_000))
  assertEquals("processing",command("finishing",120_001));assertEquals("processing",command("status",180_000))
  assertEquals("cancelled",command("status",180_001))
 }
 @Test fun doneWithoutObservedInsertionCannotComplete() {finish();assertEquals("cancelled",command("completed",2000))}
 @Test fun insertionBeforeDoneInvalidatesInsteadOfSending() {prepare();command("recording");assertNull(state.insertionOwner());assertEquals("cancelled",command("status"))}
 @Test fun failedOrSecondAccessibilityInsertionInvalidates() {
  finish();state.inserted(state.insertionOwner(),false);assertEquals("cancelled",command("status"))
  val other=DictationState();val key=UUID.randomUUID().toString();other.command(key,"begin",101,0,Lease());other.report(key,"prepared",chat,1,null);other.command(key,"recording",101,0);other.command(key,"finishing",101,0)
  other.inserted(other.insertionOwner(),true);assertNull(other.insertionOwner());assertEquals("cancelled",other.snapshot().optString("phase"))
 }
 @Test fun onlyBoundMessageAcknowledgementCanTransitionQueuedToSynced() {
  finish();insert();assertEquals("complete",command("completed",2000));assertTrue(state.authorize(id,chat,3,item,2001));state.report(id,"queued",chat,null,item)
  assertEquals("queued",command("status",500_000))
  state.report(id,"synced",chat,null,UUID.randomUUID().toString());assertEquals("queued",command("status"))
  state.report(id,"synced",chat,null,item);assertEquals("synced",command("status"))
 }
 @Test fun cancelPreventsLateAckButDoesNotReconstructAnythingAfterProcessDeath() {
  finish();insert();command("completed",2000);assertTrue(state.authorize(id,chat,3,item,2001));state.report(id,"queued",chat,null,item);state.cancel();state.report(id,"synced",chat,null,item)
  assertEquals("cancelled",command("status"));val restarted=DictationState();assertEquals("none",restarted.snapshot().optString("phase"));assertEquals("cancelled",restarted.command(id,"completed",101,9000).optString("phase"))
 }
 @Test fun leaseDeathRevokesProcessingCompleteAndAdmissionWithoutReplay() {
  finish();lease.die();assertEquals("cancelled",command("status"));assertFalse(state.authorize(id,chat,3,item,2000))
 }
 @Test fun leaseDeathAfterCompletionPushesImmediateRevocationAndDeniesAdmission() {
  val revoked=mutableListOf<String>();state.attach("test") {revoked.add(it)}
  finish();insert();command("completed",2000);assertTrue(state.authorize(id,chat,3,item,2001));lease.die()
  assertEquals(listOf(id),revoked);assertFalse(state.authorize(id,chat,3,item,2002));assertEquals("cancelled",command("status"))
 }
 @Test fun newLeaseCannotAdoptOldSessionAndClaimsBindChatRevisionAndItem() {
  finish();insert();command("completed",2000)
  assertEquals("cancelled",state.command(id,"begin",101,2001,Lease()).optString("phase"))
  assertFalse(state.authorize(id,UUID.randomUUID().toString(),3,item,2001));assertFalse(state.authorize(id,chat,4,item,2001))
  assertTrue(state.authorize(id,chat,3,item,2001));assertFalse(state.authorize(id,chat,3,UUID.randomUUID().toString(),2001))
 }
 @Test fun duplicateBeginCannotResetDeadlineOrReviveTerminalSession() {
  command("begin",1000);command("begin",5000);assertEquals("cancelled",command("status",9000));assertEquals("cancelled",command("begin",9001))
 }
 @Test fun hiddenFieldCommitRemainsProvisionalUntilApprovedCompletionAndRechecksFieldAtAdmission() {
  finish();var field=true
  val owner=state.provisionalOwner(true,1100) {field};assertEquals(id,owner)
  assertTrue(state.snapshot().optBoolean("provisionalPending"));assertFalse(state.snapshot().optBoolean("inserted"))
  assertFalse(state.authorize(id,chat,3,item,1101))
  state.provisionalCommitted(id,true,true,1102)
  assertTrue(state.snapshot().optBoolean("provisionalInput"));assertFalse(state.snapshot().optBoolean("inserted"))
  assertEquals("processing",command("status",1103));assertFalse(state.authorize(id,chat,3,item,1104))
  assertEquals("complete",command("completed",2000));assertTrue(state.authorize(id,chat,3,item,2001))
  field=false
  assertFalse(state.authorize(id,chat,3,item,2002));assertEquals("PROVISIONAL_FIELD_CHANGED",state.snapshot().optString("cancelReason"))
 }
 @Test fun provisionalPendingOrUnknownFieldOrRejectedWriteCannotComplete() {
  finish();state.provisionalOwner(true,1100) {true};assertEquals("cancelled",command("completed",1101))
  val other=DictationState();val key=UUID.randomUUID().toString();other.command(key,"begin",101,0,Lease());other.report(key,"prepared",chat,1,null);other.command(key,"recording",101,0);other.command(key,"finishing",101,0)
  assertNull(other.provisionalOwner(false,1) {true});assertEquals("cancelled",other.snapshot().optString("phase"))
 }
 @Test fun provisionalRequiresProcessingAndSecondInputRevokesInsteadOfReplacingWitness() {
  prepare();assertNull(state.provisionalOwner(true,2) {true});assertEquals("cancelled",command("status",3))
  val other=DictationState();val key=UUID.randomUUID().toString();other.command(key,"begin",101,0,Lease());other.report(key,"prepared",chat,1,null);other.command(key,"recording",101,0);other.command(key,"finishing",101,0)
  assertEquals(key,other.provisionalOwner(true,1) {true});other.provisionalCommitted(key,true,true,2)
  assertNull(other.provisionalOwner(true,3) {true});assertEquals("cancelled",other.snapshot().optString("phase"))
 }
 @Test fun provisionalRejectedOrLateCommitDoesNotReviveCancelledSession() {
  finish();state.provisionalOwner(true,1100) {true};state.provisionalCommitted(id,false,true,1101)
  assertEquals("PROVISIONAL_REJECTED",state.snapshot().optString("cancelReason"));state.provisionalCommitted(id,true,true,1102)
  assertEquals("cancelled",command("completed",1200));assertFalse(state.authorize(id,chat,3,item,1201))
 }
 @Test fun provisionalCompletionRequiresCurrentFieldAndCannotSurviveInterferenceOrLeaseDeath() {
  finish();state.provisionalOwner(true,1100) {false};state.provisionalCommitted(id,true,true,1101)
  assertEquals("cancelled",command("completed",1200))
  val other=DictationState();val key=UUID.randomUUID().toString();val token=Lease();other.command(key,"begin",101,0,token);other.report(key,"prepared",chat,1,null);other.command(key,"recording",101,0);other.command(key,"finishing",101,0)
  other.provisionalOwner(true,1) {true};other.provisionalCommitted(key,true,true,2);token.die()
  assertEquals("cancelled",other.command(key,"completed",101,3).optString("phase"))
 }
 @Test fun cancellationReasonIsFirstOnlyAndRendererCannotForgeNativeReason() {
  finish();state.cancel(DictationCancelReason.INPUT_SELECTION,1100);state.cancel(DictationCancelReason.ADAPTER_CANCEL,1200)
  assertEquals("INPUT_SELECTION",state.snapshot().optString("cancelReason"));assertEquals(1100,state.snapshot().optInt("cancelledAtElapsedMs"));assertEquals("processing",state.snapshot().optString("cancelPhase"))
  val other=DictationState();val key=UUID.randomUUID().toString();other.command(key,"begin",101,0,Lease());other.report(key,"cancelled",null,null,null,"INPUT_SELECTION",1)
  assertEquals("RENDERER_CANCELLED",other.snapshot().optString("cancelReason"))
 }
 @Test fun obsoleteGenerationCannotArmOrSurviveCompletionAndAdmission() {
  finish();var generation=true
  assertNull(state.provisionalOwner(true,1100,{false}) {true})
  assertEquals("cancelled",command("status"))
  val other=DictationState();val key=UUID.randomUUID().toString();other.command(key,"begin",101,0,Lease());other.report(key,"prepared",chat,1,null);other.command(key,"recording",101,0);other.command(key,"finishing",101,0)
  other.provisionalOwner(true,1,{generation}) {true};other.provisionalCommitted(key,true,true,2);generation=false
  assertEquals("cancelled",other.command(key,"completed",101,3).optString("phase"))
 }
 @Test fun connectionReplacementRevokesCompletedCandidateBeforeDurableAdmission() {
  finish();state.provisionalOwner(true,1100) {true};state.provisionalCommitted(id,true,true,1101)
  assertEquals("complete",command("completed",1200));state.inputConnectionChanged(1201)
  assertFalse(state.authorize(id,chat,3,item,1202));assertEquals("PROVISIONAL_FIELD_CHANGED",state.snapshot().optString("cancelReason"))
 }
 @Test fun guardReadDoesNotHoldStateMonitorAndConcurrentRevocationWins() {
  finish();var reads=0
  state.provisionalOwner(true,1100) {
   assertFalse("UI read must be outside the state monitor",Thread.holdsLock(state));reads++
   state.cancel(DictationCancelReason.NATIVE_TOUCH,1103);true
  }
  state.provisionalCommitted(id,true,true,1101)
  assertEquals("cancelled",command("completed",1200));assertEquals(1,reads)
  assertEquals("NATIVE_TOUCH",state.snapshot().optString("cancelReason"));assertFalse(state.authorize(id,chat,3,item,1201))
 }
 @Test fun authorizationGuardReadAlsoReleasesMonitorAndRechecksGenerationAfterRead() {
  finish();var generation=true;var checks=0
  state.provisionalOwner(true,1100,{generation}) {
   assertFalse(Thread.holdsLock(state));checks++;if(checks==2) generation=false;true
  }
  state.provisionalCommitted(id,true,true,1101);assertEquals("complete",command("completed",1200))
  assertFalse(state.authorize(id,chat,3,item,1201));assertEquals("PROVISIONAL_FIELD_CHANGED",state.snapshot().optString("cancelReason"))
 }
 @Test fun mainThreadCanSnapshotAndCancelWhileCompletionWaitsForFieldRead() {
  finish();val reading=java.util.concurrent.CountDownLatch(1);val release=java.util.concurrent.CountDownLatch(1)
  state.provisionalOwner(true,1100) {reading.countDown();assertTrue(release.await(2,java.util.concurrent.TimeUnit.SECONDS));true}
  state.provisionalCommitted(id,true,true,1101)
  val result=java.util.concurrent.atomic.AtomicReference<String>()
  val worker=Thread {result.set(command("completed",1200))};worker.start()
  assertTrue(reading.await(2,java.util.concurrent.TimeUnit.SECONDS))
  try {assertEquals("processing",state.snapshot().optString("phase"));state.cancel(DictationCancelReason.INPUT_SELECTION,1201)} finally {release.countDown()}
  worker.join(2000);assertFalse(worker.isAlive);assertEquals("cancelled",result.get())
 }

 @Test fun fieldReadCannotExtendCompletionDeadlinePastActualMonotonicTime() {
  var clock=0L;val other=DictationState {requested->maxOf(requested,clock)};val key=UUID.randomUUID().toString()
  other.command(key,"begin",101,0,Lease());other.report(key,"prepared",chat,1,null);other.command(key,"recording",101,0);other.command(key,"finishing",101,0)
  other.provisionalOwner(true,1) {clock=60_001;true};other.provisionalCommitted(key,true,true,2)
  assertEquals("cancelled",other.command(key,"completed",101,59_999).optString("phase"));assertEquals("EXPIRED",other.snapshot().optString("cancelReason"))
 }

 @Test fun durableQueuedOwnResetMayReplaceConnectionButCannotAdmitAgainAndOnlyExactAckSyncs() {
  finish();var generation=true;state.provisionalOwner(true,1100,{generation}) {true};state.provisionalCommitted(id,true,true,1101);command("completed",1200)
  assertTrue(state.authorize(id,chat,3,item,1201));state.report(id,"queued",chat,null,item)
  generation=false;state.inputConnectionChanged(1202);assertEquals("queued",command("status",1203))
  assertFalse(state.authorize(id,chat,3,UUID.randomUUID().toString(),1204))
  state.report(id,"synced",chat,null,UUID.randomUUID().toString());assertEquals("queued",command("status",1205))
  state.report(id,"synced",chat,null,item);assertEquals("synced",command("status",1206))
 }
 @Test fun realUserInterferenceAfterQueueStillDeniesExactAckResumption() {
  finish();state.provisionalOwner(true,1100) {true};state.provisionalCommitted(id,true,true,1101);command("completed",1200)
  assertTrue(state.authorize(id,chat,3,item,1201));state.report(id,"queued",chat,null,item)
  state.cancel(DictationCancelReason.NATIVE_KEY,1202);state.report(id,"synced",chat,null,item)
  assertEquals("cancelled",command("status",1203));assertEquals("NATIVE_KEY",state.snapshot().optString("cancelReason"))
 }

 @Test fun rendererSentinelNeedsFreshAcceptedNativeProofForSamePinnedOwner() {
  finish();assertFalse(state.confirmProvisional(id,chat,3,1100))
  assertEquals("cancelled",command("status"))
  val other=DictationState();val key=UUID.randomUUID().toString();val token=Lease();var field=true;var generation=true
  other.command(key,"begin",101,0,token);other.report(key,"prepared",chat,3,null);other.command(key,"recording",101,0);other.command(key,"finishing",101,0)
  other.provisionalOwner(true,1,{generation}) {assertFalse(Thread.holdsLock(other));field};other.provisionalCommitted(key,true,true,2)
  assertFalse(other.confirmProvisional(id,chat,3,3));assertFalse(other.confirmProvisional(key,UUID.randomUUID().toString(),3,3));assertFalse(other.confirmProvisional(key,chat,4,3))
  assertTrue(other.confirmProvisional(key,chat,3,3));assertEquals("processing",other.snapshot().optString("phase"))
  assertEquals("complete",other.command(key,"completed",101,4).optString("phase"));assertTrue(other.confirmProvisional(key,chat,3,5))
  generation=false;assertFalse(other.confirmProvisional(key,chat,3,6));assertEquals("cancelled",other.snapshot().optString("phase"))
 }
 @Test fun pendingExpiredDeadOrChangedFieldCannotConfirmRendererSentinel() {
  for(failure in listOf("pending","expired","dead","field")) {
   val other=DictationState();val key=UUID.randomUUID().toString();val token=Lease();var field=true
   other.command(key,"begin",101,0,token);other.report(key,"prepared",chat,3,null);other.command(key,"recording",101,0);other.command(key,"finishing",101,0)
   other.provisionalOwner(true,1) {field};if(failure!="pending")other.provisionalCommitted(key,true,true,2)
   if(failure=="dead")token.die();if(failure=="field")field=false
   assertFalse(failure,other.confirmProvisional(key,chat,3,if(failure=="expired")60_000 else 3));assertEquals("cancelled",other.snapshot().optString("phase"))
  }
 }

}
