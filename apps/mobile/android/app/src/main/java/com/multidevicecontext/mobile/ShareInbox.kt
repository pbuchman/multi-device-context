package com.multidevicecontext.mobile
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

data class IncomingFile(val name:String,val contentType:String,val open:()->InputStream)
/** Directory rename is the commit point: JS can only see fully copied, durable requests. */
class ShareInbox(private val root:File) {
 init { root.mkdirs();root.listFiles()?.filter { it.name.endsWith(".partial") }?.forEach { it.deleteRecursively() } }
 private var rejected=0
 @Synchronized fun consumeRejections():Int = rejected.also { rejected=0 }
 @Synchronized fun pending():JSONArray = JSONArray().also { result ->
  root.listFiles()?.filter { it.isDirectory && !it.name.endsWith(".partial") && !it.name.endsWith(".rejected") }?.sortedBy { it.name }?.forEach { dir ->
   try {
    val manifest=File(dir,"request.json");require(manifest.length() in 1..1048576)
    val request=JSONObject(manifest.readText());validateRequest(dir,request);result.put(request)
   } catch(_:Exception) {
    rejected++
    // Keep rejected bytes private for bounded storage accounting; never poison the valid queue.
    dir.renameTo(File(root,dir.name+".rejected"))
   }
  }
 }
 private fun validateRequest(dir:File,request:JSONObject) {
  val id=request.getString("id");require(UUID.fromString(id).toString()==id && dir.name==id)
  require(request.getLong("capturedAt")>0)
  val text=if(request.has("text"))request.getString("text") else null
  val refs=request.getJSONArray("files");require(refs.length()<=32)
  val sizes=mutableListOf<Long>();val ids=mutableSetOf<String>()
  for(i in 0 until refs.length()) {
   val ref=refs.getJSONObject(i);val fileId=ref.getString("id")
   require(UUID.fromString(fileId).toString()==fileId && ids.add(fileId))
   val file=File(dir,fileId);val size=ref.getLong("size");sizes.add(size)
   require(file.isFile && file.length()==size && ref.getString("path")=="file://"+file.absolutePath)
   val name=ref.getString("name");require(name==NativePolicy.safeName(name))
   val type=ref.getString("contentType");require(type==NativePolicy.safeMime(type))
  }
  require(NativePolicy.validShare(text,sizes,0))
 }
 @Synchronized fun capture(id:String,text:String?,files:List<IncomingFile>) {
  require(UUID.fromString(id).toString()==id)
  val destination=File(root,id);if(destination.exists() || File(root,"$id.rejected").exists() || acknowledged().contains(id))return
  val used=root.walkTopDown().filter { it.isFile }.sumOf { it.length() }
  require(NativePolicy.validShare(text,files.map { 1L },used)) { "Share exceeds limits or is empty" }
  val staging=File(root,"$id.partial");staging.mkdirs()
  try {
   var total=0L
   val refs=JSONArray()
   for(input in files) {
    val fileId=UUID.randomUUID().toString();val name=NativePolicy.safeName(input.name)
    val target=File(staging,fileId)
    input.open().use { source -> FileOutputStream(target).use { sink ->
     val buffer=ByteArray(NativePolicy.MAX_CHUNK)
     while(true) { val count=source.read(buffer);if(count<0)break;total+=count
      require(total<=NativePolicy.MAX_FILE && used+total+(text?.toByteArray()?.size ?: 0)<=NativePolicy.MAX_INBOX) { "Share exceeds storage limits" }
      sink.write(buffer,0,count)
     };sink.fd.sync()
    } }
    require(target.length()>0) { "Empty attachments are not supported" }
    refs.put(JSONObject().put("id",fileId).put("name",name).put("contentType",NativePolicy.safeMime(input.contentType)).put("size",target.length()).put("path","file://"+File(destination,fileId).absolutePath))
   }
   val request=JSONObject().put("id",id).put("capturedAt",System.currentTimeMillis()).put("files",refs)
   if(text!=null)request.put("text",text)
   val requestBytes=request.toString().toByteArray()
   require(used+total+requestBytes.size<=NativePolicy.MAX_INBOX) { "Inbox metadata exceeds storage limit" }
   FileOutputStream(File(staging,"request.json")).use { it.write(requestBytes);it.fd.sync() }
   check(staging.renameTo(destination)) { "Could not commit share" }
  } catch(e:Exception) { staging.deleteRecursively();throw e }
 }
 private fun acknowledged():List<String> = File(root,"acknowledged").takeIf { it.exists() }?.readLines() ?: emptyList()
 @Synchronized fun acknowledge(id:String) {
  require(UUID.fromString(id).toString()==id)
  val entries=(acknowledged()+id).distinct().takeLast(4096)
  val temp=File(root,"acknowledged.tmp")
  FileOutputStream(temp).use { it.write(entries.joinToString("\n").toByteArray());it.fd.sync() }
  check(temp.renameTo(File(root,"acknowledged")))
  File(root,id).deleteRecursively()
 }
 @Synchronized fun clear() { root.listFiles()?.forEach { it.deleteRecursively() } }
}
