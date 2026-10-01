package com.multidevicecontext.mobile
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
class ShareInboxTest {
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
