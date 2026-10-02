package com.multidevicecontext.mobile
import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject
class InstallationSessionTest {
 private val id="00000000-0000-4000-8000-000000000001"
 @Test fun persistsBeforeSessionAndNeverReturnsProof() {
  val stored=mutableMapOf<String,JSONObject>();var enrollments=0
  val session=InstallationSession({stored[it]},{key,value->stored[key]=value},{path,_,body->
   if(path.endsWith("enroll")) {enrollments++;JSONObject().put("device",JSONObject().put("id",id)).put("credential","a".repeat(43))}
   else {assertEquals(stored["account"]?.getString("credential"),body.getString("credential"));JSONObject().put("uid","owner").put("customToken","token").put("credential","must-not-leak").put("device",JSONObject().put("id",id))}
  },{"account"},"Phone")
  assertFalse(session.exchange("token").has("credential"));session.invalidate();session.exchange("token")
  assertEquals(1,enrollments)
 }
 @Test fun signOutDuringEnrollmentDoesNotPersist() {
  var saved=false;lateinit var session:InstallationSession
  session=InstallationSession({null},{_,_->saved=true},{_,_,_->session.invalidate();JSONObject().put("device",JSONObject().put("id",id)).put("credential","a".repeat(43))},{"account"},"Phone")
  assertThrows(IllegalStateException::class.java) {session.exchange("token")};assertFalse(saved)
 }
 @Test fun accountPartitionsCannotReuseProof() {
  val stored=mutableMapOf<String,JSONObject>();var enrollments=0
  val session=InstallationSession({stored[it]},{key,value->stored[key]=value},{path,_,_->
   if(path.endsWith("enroll")) {enrollments++;JSONObject().put("device",JSONObject().put("id",id)).put("credential","a".repeat(43))}
   else JSONObject().put("uid","owner").put("customToken","token").put("device",JSONObject().put("id",id))
  },{it},"Phone")
  session.exchange("one");session.exchange("two");assertEquals(2,enrollments)
 }
}
