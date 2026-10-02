package com.multidevicecontext.mobile
import java.io.File
import java.util.UUID

data class ExportedFile(val file:File,val contentType:String,val displayName:String)
class ExportStore(private val root:File) {
 private data class Handle(val file:File,val name:String,val type:String)
 private val handles=mutableMapOf<String,Handle>()
 private val staging=File(root,"staging").apply { mkdirs();listFiles()?.forEach { it.delete() } }
 val exports=File(root,"exports").apply { mkdirs() }
 init { cleanup() }
 @Synchronized fun begin(name:String,type:String):String {
  require(handles.size<8) { "Too many transfers" }
  val id=UUID.randomUUID().toString();handles[id]=Handle(File(staging,id).apply { createNewFile() },NativePolicy.safeName(name),type);return id
 }
 @Synchronized fun append(id:String,bytes:ByteArray) {
  val handle=requireNotNull(handles[id]) { "Unknown transfer" }
  require(bytes.size<=NativePolicy.MAX_CHUNK && handle.file.length()+bytes.size<=NativePolicy.MAX_FILE) { "Transfer exceeds limit" }
  require(staging.listFiles()!!.sumOf { it.length() }+bytes.size<=NativePolicy.MAX_INBOX) { "Transfers exceed storage limit" }
  handle.file.appendBytes(bytes)
 }
 @Synchronized fun finish(id:String):ExportedFile {
  val handle=requireNotNull(handles[id]) { "Unknown transfer" }
  cleanup()
  require(exports.walkTopDown().filter { it.isFile }.sumOf { it.length() }+handle.file.length()<=NativePolicy.MAX_INBOX) { "Export storage full; retry later" }
  val dir=File(exports,UUID.randomUUID().toString()).apply { mkdirs() }
  // Display names may be <=255 characters yet exceed filesystem UTF-8 component limits.
  // Only an opaque ASCII handle and a bounded ASCII extension are used on disk.
  val extension=handle.name.substringAfterLast('.', "").takeIf { it.length in 1..16 && it.all { c -> c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' } }
  val file=File(dir,id+(extension?.let { ".$it" } ?: ""))
  check(handle.file.renameTo(file));handles.remove(id);return ExportedFile(file,handle.type,handle.name)
 }
 @Synchronized fun discard(id:String) { handles.remove(id)?.file?.delete() }
 @Synchronized fun clearStaging() { handles.clear();staging.listFiles()?.forEach { it.delete() } }
 @Synchronized fun invalidate() { clearStaging();exports.listFiles()?.forEach {it.deleteRecursively()} }
 fun cleanup() { exports.listFiles()?.filter { System.currentTimeMillis()-it.lastModified()>24*60*60*1000L }?.forEach { it.deleteRecursively() } }
}
