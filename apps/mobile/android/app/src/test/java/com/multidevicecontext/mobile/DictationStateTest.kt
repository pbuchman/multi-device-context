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
}
