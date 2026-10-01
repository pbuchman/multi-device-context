package com.multidevicecontext.mobile
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
class ExportStoreTest {
 @Test fun finishedExportsSurviveDiscardAndTraversalIsRejected() {
  val root=Files.createTempDirectory("exports").toFile();val store=ExportStore(root)
  val id=store.begin("../../report.txt","text/plain");store.append(id,"hello".toByteArray())
  val exported=store.finish(id);store.discard(id)
  assertTrue(exported.file.exists());assertEquals("hello",exported.file.readText());assertEquals("report.txt",exported.displayName)
  try{store.append("../escape",byteArrayOf(1));fail("reject unknown handle")}catch(_:IllegalArgumentException){}
  root.deleteRecursively()
 }
 @Test fun boundsChunksAndSimultaneousHandles() {
  val root=Files.createTempDirectory("exports").toFile();val store=ExportStore(root)
  val id=store.begin("a","text/plain")
  try{store.append(id,ByteArray(262145));fail("chunk limit")}catch(_:IllegalArgumentException){}
  repeat(7){store.begin("a","text/plain")}
  try{store.begin("a","text/plain");fail("handle limit")}catch(_:IllegalArgumentException){}
  root.deleteRecursively()
 }
 @Test fun unicodeDisplayNamesNeverBecomeFilesystemComponents() {
  val root=Files.createTempDirectory("unicode-export").toFile();val store=ExportStore(root)
  // All three bridge actions share this promotion path before their Android UI.
  for(action in listOf("copy","save","share")) {
   val id=store.begin("漢".repeat(100)+".txt","text/plain");store.append(id,action.toByteArray())
   val exported=store.finish(id);store.discard(id)
   assertTrue(exported.file.name.all { it.code<128 })
   assertEquals(action,exported.file.readText())
   assertEquals("漢".repeat(100)+".txt",exported.displayName)
  }
  root.deleteRecursively()
 }
}
