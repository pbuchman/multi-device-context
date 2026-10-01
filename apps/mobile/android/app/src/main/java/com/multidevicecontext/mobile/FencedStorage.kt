package com.multidevicecontext.mobile
import com.auth0.android.authentication.storage.Storage
/** Fence the SDK's own automatic rotation writes, not only its eventual callback. */
class FencedStorage(private val delegate:Storage):Storage by delegate {
 private var writable=true
 @Synchronized fun blockWrites(clear:()->Unit) {writable=false;clear()}
 @Synchronized fun allowWrites() {writable=true}
 @Synchronized override fun store(name:String,value:String?) {if(writable)delegate.store(name,value)}
 @Synchronized override fun store(name:String,value:Int?) {if(writable)delegate.store(name,value)}
 @Synchronized override fun store(name:String,value:Long?) {if(writable)delegate.store(name,value)}
 @Synchronized override fun store(name:String,value:Boolean?) {if(writable)delegate.store(name,value)}
}
