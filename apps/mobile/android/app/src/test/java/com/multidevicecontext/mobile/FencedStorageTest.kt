package com.multidevicecontext.mobile
import com.auth0.android.authentication.storage.Storage
import org.junit.Assert.*
import org.junit.Test
class FencedStorageTest {
 @Test fun logoutPreventsLateSdkRefreshFromPersistingCredentials() {
  val values=mutableMapOf<String,Any?>()
  val raw=object:Storage {
   override fun store(name:String,value:String?) {values[name]=value}
   override fun store(name:String,value:Int?) {values[name]=value}
   override fun store(name:String,value:Long?) {values[name]=value}
   override fun store(name:String,value:Boolean?) {values[name]=value}
   override fun retrieveString(name:String)=values[name] as? String
   override fun retrieveInteger(name:String)=values[name] as? Int
   override fun retrieveLong(name:String)=values[name] as? Long
   override fun retrieveBoolean(name:String)=values[name] as? Boolean
   override fun remove(name:String) {values.remove(name)}
  }
  val storage=FencedStorage(raw)
  storage.store("credentials","before")
  storage.blockWrites {storage.remove("credentials")}
  storage.store("credentials","late refresh");assertNull(storage.retrieveString("credentials"))
  storage.allowWrites();storage.store("credentials","new login");assertEquals("new login",storage.retrieveString("credentials"))
 }
}
