package com.multidevicecontext.mobile
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.io.OutputStream
import java.nio.file.Files
class ExportStoreTest {
 @Test fun repeatedMaxSizeDocumentSavesReleasePrivateCopies() {
  val root=Files.createTempDirectory("document-saves").toFile()
  try {
   val store=ExportStore(root.resolve("private"))
   val documents=root.resolve("documents").apply { mkdir() }
   val chunk=ByteArray(NativePolicy.MAX_CHUNK) { 42 }
   repeat(3) { index ->
    val name="saved-$index.bin"
    val id=store.begin(name,"application/octet-stream")
    repeat((NativePolicy.MAX_FILE/chunk.size).toInt()) { store.append(id,chunk) }
    val staged=store.prepareSave(id)
    val destination=documents.resolve(name)
    store.saveDocument(id) { destination.outputStream() }
    assertEquals(NativePolicy.MAX_FILE,destination.length())
    assertFalse("A completed document save must release its private copy",staged.file.exists())
    store.discard(id) // The renderer also discards after the native call completes.
   }
   assertTrue(store.exports.listFiles()!!.isEmpty())
  } finally { root.deleteRecursively() }
 }
 @Test fun cancelAndOutputFailuresReleaseDocumentStaging() {
  val root=Files.createTempDirectory("document-save-failures").toFile()
  try {
   val store=ExportStore(root)
   val cancelled=store.begin("cancelled.bin","application/octet-stream")
   store.append(cancelled,byteArrayOf(1))
   val abandoned=store.prepareSave(cancelled)
   store.discard(cancelled)
   assertFalse(abandoned.file.exists())

   for(openOutput in listOf<()->OutputStream?>(
    { null },
    { throw IOException("Provider refused destination") },
    { object:OutputStream() { override fun write(value:Int) { throw IOException("Provider stopped accepting bytes") } } },
   )) {
    val id=store.begin("failed.bin","application/octet-stream")
    store.append(id,byteArrayOf(1))
    val staged=store.prepareSave(id)
    assertTrue(runCatching { store.saveDocument(id,openOutput) }.isFailure)
    assertFalse(staged.file.exists())
   }
   assertTrue(store.exports.listFiles()!!.isEmpty())
  } finally { root.deleteRecursively() }
 }

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
  for(action in listOf("copy","share")) {
   val id=store.begin("漢".repeat(100)+".txt","text/plain");store.append(id,action.toByteArray())
   val exported=store.finish(id);store.discard(id)
   assertTrue(exported.file.name.all { it.code<128 })
   assertEquals(action,exported.file.readText())
   assertEquals("漢".repeat(100)+".txt",exported.displayName)
  }
  root.deleteRecursively()
 }
}
