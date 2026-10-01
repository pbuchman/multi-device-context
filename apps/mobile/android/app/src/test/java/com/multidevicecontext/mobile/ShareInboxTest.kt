package com.multidevicecontext.mobile
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
class ShareInboxTest {
 @Test fun signOutMonitorBlocksCaptureWithoutBlockingUiGenerationRead() {
  val root=Files.createTempDirectory("logout-concurrent").toFile();val inbox=ShareInbox(root)
  val entered=java.util.concurrent.CountDownLatch(1);val finish=java.util.concurrent.CountDownLatch(1)
  val executor=java.util.concurrent.Executors.newFixedThreadPool(3)
  try {
   val logout=executor.submit {inbox.signOut(emptySet()) {entered.countDown();check(finish.await(2,java.util.concurrent.TimeUnit.SECONDS))}}
   assertTrue(entered.await(2,java.util.concurrent.TimeUnit.SECONDS))
   val during=executor.submit<Long> {inbox.captureGeneration()}.get(1,java.util.concurrent.TimeUnit.SECONDS)
   val capture=executor.submit<Boolean> {
    try {inbox.capture(java.util.UUID.randomUUID().toString(),"during logout",emptyList(),during);false}catch(_:IllegalStateException){true}
   }
   assertFalse(capture.isDone);finish.countDown()
   logout.get(2,java.util.concurrent.TimeUnit.SECONDS);assertTrue(capture.get(2,java.util.concurrent.TimeUnit.SECONDS))
   assertEquals(0,inbox.pending().length())
  } finally {finish.countDown();executor.shutdownNow();root.deleteRecursively()}
 }
 @Test fun signOutRejectsUnreviewedCommittedShareBeforeInvalidatingCredentials() {
  val root=Files.createTempDirectory("logout").toFile();val inbox=ShareInbox(root)
  val reviewed=java.util.UUID.randomUUID().toString();val late=java.util.UUID.randomUUID().toString()
  inbox.capture(reviewed,"reviewed",listOf(IncomingFile("keep.bin","application/octet-stream"){byteArrayOf(0,1,-1).inputStream()}));inbox.capture(late,"late",emptyList())
  var invalidated=false
  try {inbox.signOut(setOf(reviewed)) {invalidated=true};fail("must reconfirm")}catch(_:IllegalStateException){}
  assertFalse(invalidated);assertEquals(2,inbox.pending().length())
  val request=(0 until inbox.pending().length()).map {inbox.pending().getJSONObject(it)}.first {it.getString("id")==reviewed}
  assertArrayEquals(byteArrayOf(0,1,-1),java.io.File(java.net.URI(request.getJSONArray("files").getJSONObject(0).getString("path"))).readBytes())
  inbox.signOut(setOf(reviewed,late)) {invalidated=true}
  assertTrue(invalidated);assertEquals(0,inbox.pending().length());root.deleteRecursively()
 }
 @Test fun discardedShareIsNotImportedAgainWhenActivityIntentIsReplayed() {
  val root=Files.createTempDirectory("logout-replay").toFile();val inbox=ShareInbox(root)
  val id=java.util.UUID.randomUUID().toString();inbox.capture(id,"discarded",emptyList())
  inbox.signOut(setOf(id)) {}
  ShareInbox(root).capture(id,"discarded",emptyList())
  assertEquals(0,ShareInbox(root).pending().length());root.deleteRecursively()
 }
 @Test fun rejectedStaleIntentIsNotReimportedIntoNextAccountAfterRecreation() {
  val root=Files.createTempDirectory("logout-rejected-replay").toFile();val inbox=ShareInbox(root)
  val generation=inbox.captureGeneration();val id=java.util.UUID.randomUUID().toString()
  inbox.signOut(emptySet()) {}
  try {inbox.capture(id,"previous account",emptyList(),generation);fail("must reject")}catch(_:IllegalStateException){}
  ShareInbox(root).capture(id,"previous account",emptyList())
  assertEquals(0,ShareInbox(root).pending().length());root.deleteRecursively()
 }
 @Test fun signOutFencesCapturesStartedBeforeOrDuringAccountClear() {
  val root=Files.createTempDirectory("logout-race").toFile();val inbox=ShareInbox(root)
  val before=inbox.captureGeneration();var during=0L
  inbox.signOut(emptySet()) {during=inbox.captureGeneration()}
  for(generation in listOf(before,during)) {
   try {inbox.capture(java.util.UUID.randomUUID().toString(),"stale",emptyList(),generation);fail("must retry capture")}catch(_:IllegalStateException){}
  }
  assertEquals(0,inbox.pending().length())
  inbox.capture(java.util.UUID.randomUUID().toString(),"after logout",emptyList(),inbox.captureGeneration())
  assertEquals(1,inbox.pending().length());root.deleteRecursively()
 }
 @Test fun credentialFailureRetainsReviewedInboxForRetry() {
  val root=Files.createTempDirectory("logout-failure").toFile();val inbox=ShareInbox(root)
  val id=java.util.UUID.randomUUID().toString();inbox.capture(id,"retained",emptyList())
  try {inbox.signOut(setOf(id)) {throw IllegalStateException("credentials")};fail("must fail")}catch(_:IllegalStateException){}
  assertEquals(1,inbox.pending().length());inbox.signOut(setOf(id)) {};assertEquals(0,inbox.pending().length());root.deleteRecursively()
 }
 @Test fun persistsUntilAcknowledgedAndDeduplicatesRequest() {
  val root=Files.createTempDirectory("inbox").toFile(); val id=java.util.UUID.randomUUID().toString()
  val inbox=ShareInbox(root)
  inbox.capture(id,"hello",listOf(IncomingFile("test.txt","text/plain"){"bytes".byteInputStream()}))
  inbox.capture(id,"hello",emptyList())
  val restarted=ShareInbox(root)
  assertEquals(1,restarted.pending().length())
  val request=restarted.pending().getJSONObject(0)
  assertEquals("hello",request.getString("text"))
  val file=request.getJSONArray("files").getJSONObject(0)
  assertTrue(file.getString("path").startsWith("file:"))
  assertEquals("bytes",java.io.File(java.net.URI(file.getString("path"))).readText())
  restarted.acknowledge(id); assertEquals(0,ShareInbox(root).pending().length());root.deleteRecursively()
 }
 @Test fun failedCaptureLeavesNoPartialRequestOrFiles() {
  val root=Files.createTempDirectory("inbox").toFile();val inbox=ShareInbox(root)
  try { inbox.capture(java.util.UUID.randomUUID().toString(),null,listOf(IncomingFile("a","text/plain"){throw java.io.IOException("revoked grant")}));fail("must reject") } catch(_:java.io.IOException){}
  assertEquals(0,inbox.pending().length());assertEquals(0,root.listFiles()!!.size);root.deleteRecursively()
 }
 @Test fun emptyFileIsRejectedWithoutPoisoningPendingInbox() {
  val root=Files.createTempDirectory("empty").toFile();val inbox=ShareInbox(root)
  try {inbox.capture(java.util.UUID.randomUUID().toString(),null,listOf(IncomingFile("empty.txt","text/plain"){byteArrayOf().inputStream()}));fail("reject empty files")}catch(_:IllegalArgumentException){}
  assertEquals(0,inbox.pending().length());root.deleteRecursively()
 }
 @Test fun invalidProviderMimeIsNormalizedAndBadManifestIsIsolated() {
  val root=Files.createTempDirectory("mime").toFile();val inbox=ShareInbox(root);val id=java.util.UUID.randomUUID().toString()
  inbox.capture(id,null,listOf(IncomingFile("file","invalid mime"){"ok".byteInputStream()}))
  assertEquals("application/octet-stream",inbox.pending().getJSONObject(0).getJSONArray("files").getJSONObject(0).getString("contentType"))
  val broken=java.io.File(root,java.util.UUID.randomUUID().toString()).apply {mkdirs()};java.io.File(broken,"request.json").writeText("{\"id\":\"bad\"}")
  assertEquals(1,inbox.pending().length());assertEquals(1,inbox.consumeRejections());assertEquals(0,inbox.consumeRejections());root.deleteRecursively()
 }
}
