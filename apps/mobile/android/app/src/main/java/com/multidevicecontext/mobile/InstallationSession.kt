package com.multidevicecontext.mobile

import org.json.JSONObject
/** Storage partition claims are hints only; every HTTP request is authenticated by the server. */
class InstallationSession(
 private val read:(String)->JSONObject?, private val write:(String,JSONObject)->Unit,
 private val post:(String,String,JSONObject)->JSONObject,
 private val partition:(String)->String,
 private val name:String
) {
 @Volatile private var generation=0L
 @Synchronized fun invalidate() { generation++ }
 fun exchange(token:String):JSONObject {
  require(token.isNotEmpty() && token.length<=32768)
  val epoch=generation;val key=partition(token)
  fun current() { check(epoch==generation) { "Account changed" } }
  var proof=read(key)
  if(proof==null) {
   val enrollment=post("/api/devices/enroll",token,JSONObject().put("name",name.take(80)).put("platform","android"))
   val id=enrollment.getJSONObject("device").getString("id")
   require(java.util.UUID.fromString(id).toString()==id)
   val credential=enrollment.getString("credential");require(Regex("^[A-Za-z0-9_-]{43}$").matches(credential))
   proof=JSONObject().put("deviceId",id).put("credential",credential)
   synchronized(this) {current();write(key,proof)}
  }
  val result=post("/api/session",token,proof)
  current();require(result.getJSONObject("device").getString("id")==proof.getString("deviceId"))
  require(result.getString("uid").isNotEmpty() && result.getString("customToken").isNotEmpty())
  // Explicit projection: never forward a server-added credential into the renderer.
  return JSONObject().put("uid",result.getString("uid")).put("customToken",result.getString("customToken")).put("device",result.getJSONObject("device"))
 }
}
