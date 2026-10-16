package com.multidevicecontext.mobile

/** A one-shot IME request; stale UI callbacks can never consume a newer request. */
internal class DictationImeRequest(private val now: () -> Long) {
 companion object { const val TIMEOUT_MS = 1500L }
 private data class Pending(val token: Long, val started: Long)
 private var serial = 0L
 private var pending: Pending? = null
 val pendingToken: Long? get() = pending?.token
 fun request(): Long {
  val next = Pending(++serial, now()); pending = next; return next.token
 }
 fun cancel(token: Long? = null) {
  if (token == null || pending?.token == token) pending = null
 }
 fun attempt(token: Long, eligible: Boolean, show: () -> Unit) {
  val current = pending ?: return
  if (current.token != token) return
  val age = now() - current.started
  if (age < 0 || age >= TIMEOUT_MS) { pending = null; return }
  if (!eligible) return
  // Consume before calling Android, even if the platform declines or throws.
  pending = null
  show()
 }
}
