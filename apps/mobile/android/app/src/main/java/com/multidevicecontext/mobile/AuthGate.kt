package com.multidevicecontext.mobile
/** All access from native UI thread; generation fences callbacks after sign-out. */
class AuthGate<T> {
 private var generation=0L
 private val pending=mutableListOf<T>()
 fun add(value:T):Long? { pending.add(value);return if(pending.size==1)generation else null }
 fun isCurrent(value:Long)=generation==value
 fun finish(value:Long):List<T> { if(!isCurrent(value))return emptyList();return pending.toList().also { pending.clear() } }
 fun signOut():List<T> { generation++;return pending.toList().also { pending.clear() } }
}
