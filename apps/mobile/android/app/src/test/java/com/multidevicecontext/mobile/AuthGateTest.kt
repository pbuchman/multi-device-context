package com.multidevicecontext.mobile
import org.junit.Assert.*
import org.junit.Test
class AuthGateTest {
 @Test fun coalescesAndDiscardsLateLoginAfterSignout() {
  val gate=AuthGate<String>();val generation=gate.add("first")!!
  assertNull(gate.add("second"));assertEquals(listOf("first","second"),gate.signOut())
  assertFalse(gate.isCurrent(generation));assertTrue(gate.finish(generation).isEmpty())
  val next=gate.add("third")!!;assertTrue(gate.isCurrent(next));assertEquals(listOf("third"),gate.finish(next))
 }
}
