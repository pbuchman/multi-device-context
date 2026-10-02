package com.multidevicecontext.mobile
import org.junit.Assert.*
import org.junit.Test
class NativePolicyTest {
 @Test fun navigationRequiresExactCanonicalContextLink() {
  val id="123e4567-e89b-42d3-a456-426614174000"
  assertEquals(id,NativePolicy.contextId("multi-device-context://context/$id"))
  listOf("multi-device-context://context/$id/extra","multi-device-context://context/$id?evil=1","multi-device-context://other/$id","com.multidevicecontext.mobile://tenant/android/callback","multi-device-context://context/1-1-1-1-1","multi-device-context://context/123e4567-e89b-f2d3-a456-426614174000","multi-device-context://context/123e4567-e89b-42d3-0456-426614174000").forEach { assertNull(NativePolicy.contextId(it)) }
 }
 @Test fun validatesUtf8AndShareLimits() {
  assertTrue(NativePolicy.validShare("x",emptyList(),0))
  assertFalse(NativePolicy.validShare("",emptyList(),0))
  assertFalse(NativePolicy.validShare("😀".repeat(65537),emptyList(),0))
  assertFalse(NativePolicy.validShare(null,List(33){1L},0))
  assertFalse(NativePolicy.validShare(null,listOf(104857601),0))
  assertFalse(NativePolicy.validShare(null,listOf(100),268435450))
  assertFalse(NativePolicy.validShare(null,listOf(-1),0))
 }
 @Test fun exportNamesCannotEscapeDirectory() {
  assertEquals("report.pdf", NativePolicy.safeName("../report.pdf"))
  assertEquals("file", NativePolicy.safeName("\u0000"))
  assertEquals("😀".repeat(120)+".txt",NativePolicy.safeName("😀".repeat(120)+".txt"))
  assertFalse(Character.isHighSurrogate(NativePolicy.safeName("😀".repeat(130)).last()))
 }
}
